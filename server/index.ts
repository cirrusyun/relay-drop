import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { createReadStream, createWriteStream } from "node:fs";
import { open, rename, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { ZipArchive } from "archiver";
import sharp from "sharp";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { normalizeFilename, RelayStore, UUID_PATTERN, type FileRecord } from "./store.js";
import { NotebookStore, type NoteReservation } from "./notes.js";

interface BuildOptions {
  dataDir?: string;
  maxUploadBytes?: number;
  maxStorageBytes?: number;
  serveFrontend?: boolean;
  minFreeDiskBytes?: number;
  freeDiskBytes?: () => Promise<number>;
}

const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_STORAGE_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_CLIPBOARD_CHARACTERS = 1_000_000;
const THUMBNAIL_RESERVATION_BYTES = 128 * 1024;
const DEFAULT_MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024;
const DISK_CHECK_BYTES = 1024 * 1024;
const ARCHIVE_TICKET_TTL_MS = 60_000;
const MAX_ARCHIVE_TICKETS = 128;
const THUMBNAIL_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

async function hasRasterSignature(filePath: string): Promise<boolean> {
  const input = await open(filePath, "r");
  try {
    const bytes = Buffer.alloc(64);
    const { bytesRead } = await input.read(bytes, 0, bytes.length, 0);
    const header = bytes.subarray(0, bytesRead);
    if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return true;
    if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return true;
    if (["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii"))) return true;
    if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") return true;
    if (header.subarray(4, 8).toString("ascii") === "ftyp") {
      const boxEnd = Math.min(bytesRead, header.readUInt32BE(0));
      for (let offset = 8; offset + 4 <= boxEnd; offset += 4) {
        if (offset !== 12 && ["avif", "avis"].includes(header.subarray(offset, offset + 4).toString("ascii"))) return true;
      }
    }
    return false;
  } finally { await input.close(); }
}

sharp.cache({ files: 0, items: 32, memory: 32 });
sharp.concurrency(1);

class QuotaTracker {
  private committedBytes: number;
  private inFlightBytes = 0;

  constructor(readonly maxBytes: number, initialBytes: number) {
    this.committedBytes = initialBytes;
  }

  get usedBytes() { return this.committedBytes; }
  get availableBytes() { return Math.max(0, this.maxBytes - this.committedBytes - this.inFlightBytes); }

  claim(bytes: number): boolean {
    if (bytes > this.availableBytes) return false;
    this.inFlightBytes += bytes;
    return true;
  }

  release(bytes: number) {
    this.inFlightBytes = Math.max(0, this.inFlightBytes - bytes);
  }

  commit(bytes: number) {
    this.release(bytes);
    this.committedBytes += bytes;
  }

  removeCommitted(bytes: number) {
    this.committedBytes = Math.max(0, this.committedBytes - bytes);
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function contentDisposition(name: string, disposition: "attachment" | "inline" = "attachment"): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function uniqueArchiveNames(files: FileRecord[]): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const file of files) {
    let name = normalizeFilename(file.name);
    if (name === "." || name === "..") name = "未命名文件";
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    let candidate = name;
    for (let copy = 2; used.has(candidate.toLowerCase()); copy += 1) {
      candidate = `${stem} (${copy})${extension}`;
    }
    used.add(candidate.toLowerCase());
    names.set(file.id, candidate);
  }
  return names;
}

function publicFile(file: FileRecord) {
  // Only the display fields belong in API responses, not storage or retry metadata.
  const { id, name, size, mime, createdAt, expiresAt } = file;
  return { id, name, size, mime, createdAt, expiresAt };
}

function publicFileWithThumbnail(file: FileRecord, hasThumbnail: boolean) {
  return { ...publicFile(file), hasThumbnail };
}

export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const maxUploadBytes = options.maxUploadBytes ?? positiveInteger(
    process.env.MAX_UPLOAD_BYTES,
    DEFAULT_MAX_UPLOAD_BYTES,
  );
  const maxStorageBytes = options.maxStorageBytes ?? positiveInteger(
    process.env.MAX_STORAGE_BYTES,
    DEFAULT_MAX_STORAGE_BYTES,
  );
  const dataDir = options.dataDir ?? process.env.DATA_DIR ?? path.resolve("data");
  const serveFrontend = options.serveFrontend ?? process.env.NODE_ENV === "production";
  const store = new RelayStore(dataDir);
  await store.init();
  const recovery = await store.reconcileStorage();
  const notes = new NotebookStore(dataDir);
  await notes.init();
  const quota = new QuotaTracker(maxStorageBytes, await store.storageBytes() + await notes.storageBytes());
  const minFreeDiskBytes = options.minFreeDiskBytes ?? positiveInteger(process.env.MIN_FREE_DISK_BYTES, DEFAULT_MIN_FREE_DISK_BYTES);
  const freeDiskBytes = options.freeDiskBytes ?? (async () => {
    const disk = await statfs(dataDir);
    return disk.bavail * disk.bsize;
  });
  const ensureDiskSpace = async (incomingBytes = 0) => {
    // Recheck during streaming; the small margin covers buffered writes between checks.
    if (await freeDiskBytes() < minFreeDiskBytes + DISK_CHECK_BYTES + incomingBytes) {
      throw Object.assign(new Error("服务器磁盘可用空间不足，已暂停上传，请先释放空间。"), {
        code: "DISK_SPACE_LOW", statusCode: 507,
      });
    }
  };

  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: 1_100_000,
    trustProxy: true,
  });
  const archiveTickets = new Map<string, { ids: string[]; expiresAt: number }>();
  if (Object.values(recovery).some(Boolean)) app.log.info(recovery, "Storage recovery completed");

  app.addHook("onRequest", async (request, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    const origin = request.headers.origin;
    let trustedOrigin = true;
    if (origin !== undefined) {
      try {
        const source = new URL(origin);
        const target = new URL(`${request.protocol}://${request.headers.host}`);
        trustedOrigin = source.origin !== "null" && source.origin === target.origin;
      } catch { trustedOrigin = false; }
    }
    if (!trustedOrigin || request.headers["sec-fetch-site"] === "cross-site") {
      return reply.code(403).send({ error: "已拒绝来自其他网站的操作。" });
    }
  });

  let thumbnailQueue = Promise.resolve();
  const ensureThumbnail = (file: FileRecord): Promise<boolean> => {
    const operation = thumbnailQueue.then(async () => {
      if (!THUMBNAIL_IMAGE_TYPES.has(file.mime) || !(await store.verifyFile(file))) return false;
      if (await store.thumbnailSize(file)) return true;

      const temporaryPath = `${store.thumbnailPath(file)}.uploading`;
      let reservedBytes = 0;
      try {
        // MIME is supplied by the uploader; do not feed disguised SVG/PDF documents to the image decoder.
        if (!(await hasRasterSignature(store.filePath(file)))) return false;
        await ensureDiskSpace(THUMBNAIL_RESERVATION_BYTES);
        if (!quota.claim(THUMBNAIL_RESERVATION_BYTES)) return false;
        reservedBytes = THUMBNAIL_RESERVATION_BYTES;
        await sharp(store.filePath(file), {
          animated: false,
          failOn: "error",
          limitInputPixels: 24_000_000,
          pages: 1,
        })
          .rotate()
          .resize(96, 96, { fit: "cover", position: "attention", withoutEnlargement: true })
          .webp({ quality: 58, effort: 4, smartSubsample: true })
          .toFile(temporaryPath);
        const size = (await stat(temporaryPath)).size;
        if (size > reservedBytes && !quota.claim(size - reservedBytes)) {
          throw new Error("Thumbnail exceeded its storage reservation");
        }
        if (size < reservedBytes) quota.release(reservedBytes - size);
        reservedBytes = size;
        await rename(temporaryPath, store.thumbnailPath(file));
        quota.commit(size);
        reservedBytes = 0;
        return true;
      } catch (error) {
        quota.release(reservedBytes);
        await rm(temporaryPath, { force: true });
        app.log.warn({ fileId: file.id, error }, "Unable to generate image thumbnail");
        return false;
      }
    });
    thumbnailQueue = operation.then(() => undefined, () => undefined);
    return operation;
  };

  for (const file of store.snapshot().files) {
    await ensureThumbnail(file);
  }

  await app.register(multipart, {
    limits: { files: 1, fields: 2, parts: 3, fileSize: maxUploadBytes },
    throwFileSizeLimit: true,
  });

  app.addHook("onSend", async (_request, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("Referrer-Policy", "no-referrer")
      .header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (!reply.hasHeader("Content-Security-Policy")) {
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
      );
    }
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/state", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const snapshot = store.snapshot();
    return {
      clipboard: snapshot.clipboard,
      files: await Promise.all(snapshot.files.map(async (file) => (
        publicFileWithThumbnail(file, Boolean(await store.thumbnailSize(file)))
      ))),
      limits: { maxUploadBytes },
      storage: { usedBytes: quota.usedBytes, maxBytes: quota.maxBytes },
    };
  });

  app.put<{ Body: { content?: unknown } }>("/api/clipboard", async (request, reply) => {
    const content = request.body?.content;
    if (typeof content !== "string") {
      return reply.code(400).send({ error: "剪贴板内容必须是文字。" });
    }
    if (content.length > MAX_CLIPBOARD_CHARACTERS) {
      return reply.code(413).send({ error: "剪贴板内容不能超过 100 万字符。" });
    }
    return { clipboard: await store.saveClipboard(content) };
  });

  app.delete("/api/clipboard", async () => ({ clipboard: await store.saveClipboard("") }));

  const reserveNote: NoteReservation = async (delta, temporaryBytes) => {
    await ensureDiskSpace(temporaryBytes);
    const growth = Math.max(0, delta);
    if (!quota.claim(growth)) throw Object.assign(new Error("共享空间已达到存储上限。"), { code: "STORAGE_QUOTA_EXCEEDED", statusCode: 507 });
    return {
      commit() { if (delta >= 0) quota.commit(growth); else quota.removeCommitted(-delta); },
      rollback() { quota.release(growth); },
    };
  };
  type NoteBody = { id?: unknown; title?: unknown; content?: unknown; attachments?: unknown };
  const validNoteBody = (body: NoteBody | undefined) => body && typeof body.content === "string"
    && body.content.length <= MAX_CLIPBOARD_CHARACTERS
    && (body.title === undefined || (typeof body.title === "string" && body.title.length <= 500))
    && (body.attachments === undefined || (Array.isArray(body.attachments) && body.attachments.length <= 30
      && new Set(body.attachments).size === body.attachments.length
      && body.attachments.every((id) => typeof id === "string" && UUID_PATTERN.test(id)
        && THUMBNAIL_IMAGE_TYPES.has(store.getFile(id)?.mime ?? ""))));

  app.get("/api/notes", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    return { notes: notes.list() };
  });
  app.get<{ Params: { id: string } }>("/api/notes/:id", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const note = await notes.get(request.params.id);
    return note ? { note } : reply.code(404).send({ error: "笔记不存在。" });
  });
  app.post<{ Body: NoteBody }>("/api/notes", async (request, reply) => {
    if (!validNoteBody(request.body)) return reply.code(400).send({ error: "笔记内容或标题格式不正确。" });
    const id = request.body.id ?? randomUUID();
    if (typeof id !== "string" || !UUID_PATTERN.test(id)) return reply.code(400).send({ error: "无效的笔记标识。" });
    const result = await notes.save(id, String(request.body.title ?? ""), request.body.content as string, true, reserveNote, request.body.attachments as string[] | undefined);
    return reply.code(result.created ? 201 : 200).send({ note: result.note });
  });
  app.put<{ Params: { id: string }; Body: NoteBody }>("/api/notes/:id", async (request, reply) => {
    if (!validNoteBody(request.body)) return reply.code(400).send({ error: "笔记内容或标题格式不正确。" });
    const result = await notes.save(request.params.id, String(request.body.title ?? ""), request.body.content as string, false, reserveNote, request.body.attachments as string[] | undefined);
    return { note: result.note };
  });
  app.delete<{ Params: { id: string } }>("/api/notes/:id", async (request, reply) => {
    const removedBytes = await notes.delete(request.params.id);
    if (removedBytes === undefined) return reply.code(404).send({ error: "笔记不存在。" });
    quota.removeCommitted(removedBytes);
    return reply.code(204).send();
  });

  const activeUploadKeys = new Set<string>();
  app.post("/api/files", async (request, reply) => {
    const uploadKey = request.headers["idempotency-key"];
    if (uploadKey !== undefined && (typeof uploadKey !== "string" || !UUID_PATTERN.test(uploadKey))) {
      return reply.code(400).send({ error: "无效的上传标识。" });
    }
    if (uploadKey) {
      const existing = store.getFileByUploadKey(uploadKey);
      if (existing) {
        request.raw.resume();
        if (!(await store.verifyFile(existing))) return reply.code(409).send({ error: "原文件已不可用，请重新选择文件上传。" });
        return { file: publicFileWithThumbnail(existing, Boolean(await store.thumbnailSize(existing))) };
      }
      if (activeUploadKeys.has(uploadKey)) {
        request.raw.resume();
        return reply.code(409).header("Retry-After", "2").send({ error: "同一文件仍在处理中，请稍后重试。", code: "UPLOAD_IN_PROGRESS" });
      }
      activeUploadKeys.add(uploadKey);
    }
    const storedName = store.newStoredName();
    const temporaryPath = path.join(store.filesDir, `${storedName}.uploading`);
    const finalPath = path.join(store.filesDir, storedName);
    let claimedBytes = 0;
    let committed = false;
    let bytesSinceDiskCheck = 0;
    const quotaGuard = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (!quota.claim(chunk.length)) {
          const error = Object.assign(new Error("共享空间已达到存储上限。"), {
            code: "STORAGE_QUOTA_EXCEEDED",
            statusCode: 507,
          });
          callback(error);
          return;
        }
        claimedBytes += chunk.length;
        bytesSinceDiskCheck += chunk.length;
        if (bytesSinceDiskCheck >= DISK_CHECK_BYTES) {
          bytesSinceDiskCheck = 0;
          ensureDiskSpace(chunk.length).then(() => callback(null, chunk), (error) => callback(error));
        } else callback(null, chunk);
      },
    });

    try {
      await ensureDiskSpace();
      const part = await request.file();
      if (!part) return reply.code(400).send({ error: "没有收到文件。" });
      await pipeline(
        part.file,
        quotaGuard,
        createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
      );
      if (part.file.truncated) {
        quota.release(claimedBytes);
        claimedBytes = 0;
        await rm(temporaryPath, { force: true });
        return reply.code(413).send({ error: "文件超过了服务器允许的大小。" });
      }
      await rename(temporaryPath, finalPath);
      const size = (await stat(finalPath)).size;
      const createdAt = new Date().toISOString();
      const file = await store.addFile({
        name: normalizeFilename(part.filename),
        storedName,
        size,
        mime: String(part.mimetype || "application/octet-stream").slice(0, 160),
        createdAt,
        expiresAt: null,
        ...(uploadKey ? { uploadKey } : {}),
      });
      committed = true;
      quota.commit(claimedBytes);
      claimedBytes = 0;
      const hasThumbnail = await ensureThumbnail(file);
      return reply.code(201).send({ file: publicFileWithThumbnail(file, hasThumbnail) });
    } catch (error) {
      quota.release(claimedBytes);
      await rm(temporaryPath, { force: true });
      // A thumbnail or response failure must never remove an already committed original.
      if (!committed) await rm(finalPath, { force: true });
      throw error;
    } finally {
      if (uploadKey) activeUploadKeys.delete(uploadKey);
    }
  });

  app.get<{ Params: { id: string } }>("/api/files/:id/download", async (request, reply) => {
    const file = store.getFile(request.params.id);
    if (!file || !(await store.verifyFile(file))) {
      return reply.code(404).send({ error: "文件不存在。" });
    }
    reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Length", String(file.size))
      .header("Content-Disposition", contentDisposition(file.name))
      .header("Cache-Control", "private, no-store");
    return reply.send(createReadStream(store.filePath(file)));
  });

  app.post<{ Body: { ids?: unknown } }>("/api/files/archive", async (request, reply) => {
    const requestedIds = request.body?.ids;
    if (!Array.isArray(requestedIds) || requestedIds.length < 2 || requestedIds.length > 2_000) {
      return reply.code(400).send({ error: "请选择 2 到 2000 个要下载的文件。" });
    }
    const ids = [...new Set(requestedIds)];
    if (ids.length < 2 || ids.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))) {
      return reply.code(400).send({ error: "文件列表中包含无效项目。" });
    }
    const files = ids.map((id) => store.getFile(id as string));
    const filesExist = await Promise.all(files.map((file) => file ? store.verifyFile(file) : false));
    if (filesExist.some((exists) => !exists)) {
      return reply.code(404).send({ error: "部分所选文件已不存在，请刷新后重试。" });
    }

    const now = Date.now();
    for (const [token, ticket] of archiveTickets) {
      if (ticket.expiresAt <= now) archiveTickets.delete(token);
    }
    while (archiveTickets.size >= MAX_ARCHIVE_TICKETS) {
      const oldest = archiveTickets.keys().next().value as string | undefined;
      if (!oldest) break;
      archiveTickets.delete(oldest);
    }
    const token = randomUUID();
    archiveTickets.set(token, { ids: ids as string[], expiresAt: now + ARCHIVE_TICKET_TTL_MS });
    reply.header("Cache-Control", "private, no-store");
    return reply.code(201).send({ url: `/api/files/archive/${token}` });
  });

  app.get<{ Params: { token: string } }>("/api/files/archive/:token", async (request, reply) => {
    const ticket = archiveTickets.get(request.params.token);
    archiveTickets.delete(request.params.token);
    if (!ticket || ticket.expiresAt <= Date.now()) {
      return reply.code(404).send({ error: "批量下载已失效，请重新选择文件。" });
    }
    const files = ticket.ids.map((id) => store.getFile(id));
    const filesExist = await Promise.all(files.map((file) => file ? store.verifyFile(file) : false));
    if (filesExist.some((exists) => !exists)) {
      return reply.code(404).send({ error: "部分所选文件已不存在，请刷新后重试。" });
    }

    const verifiedFiles = files as FileRecord[];
    const entryNames = uniqueArchiveNames(verifiedFiles);
    const archive = new ZipArchive({ forceZip64: true, zlib: { level: 1 }, statConcurrency: 2 });
    archive.on("warning", (error) => {
      request.log.warn({ error }, "Unable to include a file in batch download");
      archive.abort();
      archive.destroy(error);
    });
    archive.on("error", (error) => request.log.warn({ error }, "Batch download stream failed"));
    request.raw.once("aborted", () => archive.abort());
    for (const file of verifiedFiles) {
      archive.file(store.filePath(file), {
        name: entryNames.get(file.id)!,
        date: new Date(file.createdAt),
      });
    }
    void archive.finalize().catch((error) => archive.destroy(error));
    reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", contentDisposition("Relay-files.zip"))
      .header("Cache-Control", "private, no-store");
    return reply.send(archive);
  });

  app.get<{ Params: { id: string } }>("/api/files/:id/preview", async (request, reply) => {
    const file = store.getFile(request.params.id);
    // A thumbnail exists only after the server has decoded and validated this raster image.
    if (!file || !THUMBNAIL_IMAGE_TYPES.has(file.mime) || !(await store.verifyFile(file))
      || !(await store.thumbnailSize(file))) {
      return reply.code(404).send({ error: "这个文件不能安全预览。" });
    }
    reply
      .header("Content-Type", file.mime)
      .header("Content-Length", String(file.size))
      .header("Content-Disposition", contentDisposition(file.name, "inline"))
      .header("Cache-Control", "private, no-store")
      .header("Content-Security-Policy", "default-src 'none'; sandbox");
    return reply.send(createReadStream(store.filePath(file)));
  });

  app.get<{ Params: { id: string } }>("/api/files/:id/thumbnail", async (request, reply) => {
    const file = store.getFile(request.params.id);
    if (!file || !(await store.verifyFile(file))) {
      return reply.code(404).send({ error: "文件不存在。" });
    }
    const size = await store.thumbnailSize(file);
    if (!size) return reply.code(404).send({ error: "这个文件没有缩略图。" });
    reply
      .header("Content-Type", "image/webp")
      .header("Content-Length", String(size))
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .header("Content-Security-Policy", "default-src 'none'; sandbox");
    return reply.send(createReadStream(store.thumbnailPath(file)));
  });

  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>("/api/files/:id", async (request, reply) => {
    const requestedName = request.body?.name;
    if (typeof requestedName !== "string" || !requestedName.trim()) {
      return reply.code(400).send({ error: "文件名不能为空。" });
    }
    const file = await store.renameFile(request.params.id, normalizeFilename(requestedName));
    if (!file) return reply.code(404).send({ error: "文件不存在。" });
    return { file: publicFileWithThumbnail(file, Boolean(await store.thumbnailSize(file))) };
  });

  app.delete<{ Body: { ids?: unknown } }>("/api/files", async (request, reply) => {
    const requestedIds = request.body?.ids;
    if (!Array.isArray(requestedIds) || requestedIds.length === 0 || requestedIds.length > 2_000) {
      return reply.code(400).send({ error: "请选择 1 到 2000 个要删除的文件。" });
    }
    const ids = [...new Set(requestedIds)];
    if (ids.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))) {
      return reply.code(400).send({ error: "文件列表中包含无效项目。" });
    }
    await thumbnailQueue;
    const removed = await store.deleteFiles(ids as string[]);
    if (!removed.files.length) return reply.code(404).send({ error: "所选文件已不存在。" });
    quota.removeCommitted(removed.removedBytes);
    return {
      removedIds: removed.files.map((file) => file.id),
      storage: { usedBytes: quota.usedBytes, maxBytes: quota.maxBytes },
    };
  });

  app.delete<{ Params: { id: string } }>("/api/files/:id", async (request, reply) => {
    const file = store.getFile(request.params.id);
    if (!file) {
      return reply.code(404).send({ error: "文件不存在。" });
    }
    await thumbnailQueue;
    const removed = await store.deleteFiles([request.params.id]);
    if (!removed.files.length) return reply.code(404).send({ error: "文件不存在。" });
    quota.removeCommitted(removed.removedBytes);
    return reply.code(204).send();
  });

  app.setErrorHandler((error, _request, reply) => {
    const appError = error as Error & { code?: string; statusCode?: number };
    if (error instanceof app.multipartErrors.RequestFileTooLargeError) {
      return reply.code(413).send({ error: "文件超过了服务器允许的大小。" });
    }
    if (appError.code === "STORAGE_QUOTA_EXCEEDED" || appError.code === "DISK_SPACE_LOW") {
      return reply.code(507).send({ error: appError.message });
    }
    if (appError.code === "ENOSPC") {
      return reply.code(507).send({ error: "服务器磁盘空间不足，请先释放空间后重试。" });
    }
    app.log.error(error);
    const status = appError.statusCode && appError.statusCode < 500 ? appError.statusCode : 500;
    return reply.code(status).send({ error: status === 500 ? "服务器暂时无法完成这个操作。" : appError.message });
  });

  if (serveFrontend) {
    await app.register(fastifyStatic, {
      root: path.resolve(process.cwd(), "dist"),
      wildcard: false,
      maxAge: "1h",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "接口不存在。" });
      }
      return reply.header("Cache-Control", "no-cache").sendFile("index.html");
    });
  }

  return app;
}

async function start() {
  const app = await buildApp();
  const port = positiveInteger(process.env.PORT, 8787);
  // Docker publishes this port on loopback; unauthenticated local development stays local too.
  const host = process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";
  await app.listen({ host, port });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await start();
}
