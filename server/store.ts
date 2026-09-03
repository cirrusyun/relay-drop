import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ClipboardState {
  content: string;
  updatedAt: string | null;
}

export interface FileRecord {
  id: string;
  name: string;
  storedName: string;
  size: number;
  mime: string;
  createdAt: string;
  expiresAt: string | null;
  uploadKey?: string;
}

interface PersistedState {
  version: 1;
  clipboard: ClipboardState;
  files: FileRecord[];
}

const EMPTY_STATE: PersistedState = {
  version: 1,
  clipboard: { content: "", updatedAt: null },
  files: [],
};

export const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

async function sizeOnDisk(file: string): Promise<number> {
  try { return (await lstat(file)).size; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

export async function directoryBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    // Never follow symlinks outside the data volume.
    bytes += entry.isDirectory() ? await directoryBytes(target) : await sizeOnDisk(target);
  }
  return bytes;
}

export function normalizeFilename(value: string): string {
  const base = path.basename(value.replaceAll("\\", "/"));
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();
  // Truncate by Unicode code point, never in the middle of an emoji; reject lone surrogates.
  return Array.from(cleaned || "未命名文件").slice(0, 180).join("").replace(/\p{Surrogate}/gu, "\uFFFD");
}

export class RelayStore {
  readonly dataDir: string;
  readonly filesDir: string;
  readonly thumbnailsDir: string;
  readonly statePath: string;
  readonly deletionsDir: string;

  private state: PersistedState = structuredClone(EMPTY_STATE);
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    this.filesDir = path.join(this.dataDir, "files");
    this.thumbnailsDir = path.join(this.dataDir, "thumbnails");
    this.statePath = path.join(this.dataDir, "state.json");
    this.deletionsDir = path.join(this.dataDir, ".deletions");
  }

  async init(): Promise<void> {
    await mkdir(this.filesDir, { recursive: true });
    await mkdir(this.thumbnailsDir, { recursive: true });
    await mkdir(this.deletionsDir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as PersistedState;
      if (parsed.version !== 1 || !Array.isArray(parsed.files) || typeof parsed.clipboard?.content !== "string"
        || parsed.files.some((file) => !UUID_PATTERN.test(file.id) || !UUID_PATTERN.test(file.storedName)
          || typeof file.name !== "string" || !Number.isSafeInteger(file.size) || file.size < 0)) {
        throw new Error("Unsupported state file format");
      }
      this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist(this.state);
    }
  }

  // Called once before accepting requests; one process must own the data volume.
  async reconcileStorage() {
    const report = { temporaryFilesRemoved: 0, recoveredFiles: 0, missingFiles: 0, completedDeletes: 0 };
    const known = new Set(this.state.files.map((file) => file.storedName));
    for (const entry of await readdir(this.deletionsDir, { withFileTypes: true })) {
      const storedName = entry.name.replace(/\.json$/, "");
      if (!entry.isFile() || entry.name !== `${storedName}.json` || !UUID_PATTERN.test(storedName)) continue;
      // A durable state commit, not merely a deletion marker, authorizes removal.
      if (!known.has(storedName)) {
        await rm(path.join(this.filesDir, storedName), { force: true });
        await rm(path.join(this.thumbnailsDir, `${storedName}.webp`), { force: true });
        report.completedDeletes += 1;
      }
      await rm(path.join(this.deletionsDir, entry.name));
    }
    for (const directory of [this.filesDir, this.thumbnailsDir, this.dataDir]) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const name = directory === this.dataDir
          ? entry.name.match(/^state\.json\.(.+)\.tmp$/)?.[1]
          : entry.name.match(/^(.+?)(?:\.webp)?\.uploading$/)?.[1];
        if (!entry.isFile() || !name || !UUID_PATTERN.test(name)) continue;
        await rm(path.join(directory, entry.name));
        report.temporaryFilesRemoved += 1;
      }
    }
    await this.mutate(async (next) => {
      for (const file of next.files) {
        if (await this.verifyFile(file)) file.size = await sizeOnDisk(this.filePath(file));
        else report.missingFiles += 1;
      }
      for (const entry of await readdir(this.filesDir, { withFileTypes: true })) {
        if (!entry.isFile() || !UUID_PATTERN.test(entry.name) || known.has(entry.name)) continue;
        const details = await lstat(path.join(this.filesDir, entry.name));
        // Completed original files without metadata are recovered, never discarded.
        next.files.push({
          id: randomUUID(), storedName: entry.name,
          name: `恢复的文件-${entry.name.slice(0, 8)}`, size: details.size,
          mime: "application/octet-stream", createdAt: details.mtime.toISOString(), expiresAt: null,
        });
        report.recoveredFiles += 1;
      }
    });
    return report;
  }

  async storageBytes(): Promise<number> {
    return await directoryBytes(this.filesDir) + await directoryBytes(this.thumbnailsDir);
  }

  getFileByUploadKey(key: string): FileRecord | undefined {
    const file = this.state.files.find((candidate) => candidate.uploadKey === key);
    return file ? { ...file } : undefined;
  }

  snapshot(): { clipboard: ClipboardState; files: FileRecord[] } {
    return {
      clipboard: { ...this.state.clipboard },
      files: this.state.files
        .map((file) => ({ ...file }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  }

  getFile(id: string): FileRecord | undefined {
    const file = this.state.files.find((candidate) => candidate.id === id);
    return file ? { ...file } : undefined;
  }

  filePath(file: FileRecord): string {
    if (!UUID_PATTERN.test(file.storedName)) {
      throw new Error("Unsafe stored filename");
    }
    const candidate = path.join(this.filesDir, file.storedName);
    if (path.dirname(candidate) !== this.filesDir) throw new Error("Unsafe file path");
    return candidate;
  }

  thumbnailPath(file: FileRecord): string {
    if (!UUID_PATTERN.test(file.storedName)) {
      throw new Error("Unsafe stored filename");
    }
    const candidate = path.join(this.thumbnailsDir, `${file.storedName}.webp`);
    if (path.dirname(candidate) !== this.thumbnailsDir) throw new Error("Unsafe thumbnail path");
    return candidate;
  }

  newStoredName(): string {
    return randomUUID();
  }

  async saveClipboard(content: string): Promise<ClipboardState> {
    let result!: ClipboardState;
    await this.mutate(async (next) => {
      result = { content, updatedAt: new Date().toISOString() };
      next.clipboard = result;
    });
    return { ...result };
  }

  async addFile(input: Omit<FileRecord, "id">): Promise<FileRecord> {
    let result!: FileRecord;
    await this.mutate(async (next) => {
      result = { id: randomUUID(), ...input };
      next.files.push(result);
    });
    return { ...result };
  }

  async renameFile(id: string, name: string): Promise<FileRecord | undefined> {
    let result: FileRecord | undefined;
    await this.mutate(async (next) => {
      const file = next.files.find((candidate) => candidate.id === id);
      if (!file) return;
      file.name = name;
      result = { ...file };
    });
    return result;
  }

  async deleteFiles(ids: Iterable<string>): Promise<{ files: FileRecord[]; removedBytes: number }> {
    const requested = new Set(ids);
    let removed: FileRecord[] = [];
    let removedBytes = 0;
    // Keep markers until payload removal completes, so a restart cannot resurrect a deletion.
    const operation = this.writeQueue.then(async () => {
      const next = structuredClone(this.state);
      removed = next.files.filter((candidate) => requested.has(candidate.id));
      if (!removed.length) return;
      for (const file of removed) {
        await writeFile(path.join(this.deletionsDir, `${file.storedName}.json`), "{}\n", { mode: 0o600, flush: true });
      }
      next.files = next.files.filter((candidate) => !requested.has(candidate.id));
      await this.persist(next);
      this.state = next;
      for (const file of removed) {
        const targets = [this.filePath(file), this.thumbnailPath(file)];
        let complete = true;
        for (const target of targets) {
          try {
            const before = await sizeOnDisk(target);
            await rm(target, { force: true });
            removedBytes += before;
          }
          catch { complete = false; }
        }
        // Cleanup failures must not hide an already committed deletion or lose its quota accounting.
        if (complete) await rm(path.join(this.deletionsDir, `${file.storedName}.json`), { force: true }).catch(() => undefined);
      }
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return { files: removed.map((file) => ({ ...file })), removedBytes };
  }

  async verifyFile(file: FileRecord): Promise<boolean> {
    try {
      return (await lstat(this.filePath(file))).isFile();
    } catch {
      return false;
    }
  }

  async thumbnailSize(file: FileRecord): Promise<number> {
    try {
      const details = await lstat(this.thumbnailPath(file));
      return details.isFile() ? details.size : 0;
    } catch {
      return 0;
    }
  }

  private async mutate(action: (next: PersistedState) => Promise<void>): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const next = structuredClone(this.state);
      await action(next);
      if (JSON.stringify(next) === JSON.stringify(this.state)) return;
      await this.persist(next);
      this.state = next;
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async persist(next: PersistedState): Promise<void> {
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flush: true });
      await rename(temporary, this.statePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
