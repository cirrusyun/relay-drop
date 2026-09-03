import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { directoryBytes, UUID_PATTERN } from "./store.js";

export interface Note {
  id: string;
  title: string;
  content: string;
  attachments: string[];
  createdAt: string;
  updatedAt: string;
}
export type NoteSummary = Omit<Note, "content" | "attachments"> & { preview: string; characters: number; attachmentCount: number };
export type NoteReservation = (delta: number, temporaryBytes: number) => Promise<{ commit(): void; rollback(): void }>;

function summary(note: Note): NoteSummary {
  const { content, attachments, ...metadata } = note;
  return { ...metadata, preview: Array.from(content.replace(/\s+/g, " ")).slice(0, 100).join(""), characters: content.length, attachmentCount: attachments.length };
}

function normalizeNote(value: Note): Note {
  return { ...value, attachments: Array.isArray(value.attachments) ? [...value.attachments] : [] };
}

export function noteTitle(title: string, content: string): string {
  return Array.from(title.trim() || content.split(/\r?\n/).find((line) => line.trim())?.trim() || "未命名笔记")
    .slice(0, 120).join("").replace(/\p{Surrogate}/gu, "\uFFFD");
}

// Each note has its own atomic file: clipboard autosaves never rewrite the notebook.
export class NotebookStore {
  readonly directory: string;
  private entries = new Map<string, { summary: NoteSummary; bytes: number }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) { this.directory = path.join(dataDir, "notes"); }

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const temporary = entry.name.match(/^(.+)\.json\.(.+)\.tmp$/);
      if (temporary && UUID_PATTERN.test(temporary[1]) && UUID_PATTERN.test(temporary[2])) {
        await rm(path.join(this.directory, entry.name));
        continue;
      }
      const id = entry.name.replace(/\.json$/, "");
      if (entry.name !== `${id}.json` || !UUID_PATTERN.test(id)) continue;
      const file = this.filePath(id);
      const note = normalizeNote(JSON.parse(await readFile(file, "utf8")) as Note);
      if (note.id !== id || typeof note.title !== "string" || typeof note.content !== "string"
        || !note.attachments.every((attachment) => UUID_PATTERN.test(attachment))
        || typeof note.createdAt !== "string" || typeof note.updatedAt !== "string") throw new Error("Invalid notebook data");
      this.entries.set(id, { summary: summary(note), bytes: (await lstat(file)).size });
    }
  }

  private filePath(id: string): string {
    if (!UUID_PATTERN.test(id)) throw Object.assign(new Error("笔记不存在。"), { statusCode: 404 });
    return path.join(this.directory, `${id}.json`);
  }

  storageBytes() { return directoryBytes(this.directory); }
  list(): NoteSummary[] { return [...this.entries.values()].map((entry) => ({ ...entry.summary })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }

  async get(id: string): Promise<Note | undefined> {
    if (!UUID_PATTERN.test(id) || !this.entries.has(id)) return undefined;
    const file = this.filePath(id);
    if (!(await lstat(file)).isFile()) throw new Error("Invalid notebook file");
    return normalizeNote(JSON.parse(await readFile(file, "utf8")) as Note);
  }

  save(id: string, title: string, content: string, create: boolean, reserve: NoteReservation, attachments?: string[]): Promise<{ note: Note; created: boolean }> {
    return this.serialize(async () => {
      const existing = await this.get(id);
      // Retrying a create after a lost response must not overwrite an edited note.
      if (create && existing) return { note: existing, created: false };
      if (!create && !existing) throw Object.assign(new Error("笔记不存在。"), { statusCode: 404 });
      const timestamp = new Date().toISOString();
      const note: Note = {
        id, title: noteTitle(title, content), content,
        attachments: attachments ? [...attachments] : existing?.attachments ?? [],
        createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
      };
      const bytes = Buffer.from(JSON.stringify(note) + "\n");
      const previousBytes = this.entries.get(id)?.bytes ?? 0;
      const reservation = await reserve(bytes.length - previousBytes, bytes.length);
      const target = this.filePath(id);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o600, flush: true });
        await rename(temporary, target);
      } catch (error) {
        reservation.rollback();
        throw error;
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }
      this.entries.set(id, { summary: summary(note), bytes: bytes.length });
      reservation.commit();
      return { note, created: !existing };
    });
  }

  delete(id: string): Promise<number | undefined> {
    return this.serialize(async () => {
      const entry = this.entries.get(id);
      if (!entry) return undefined;
      await rm(this.filePath(id), { force: true });
      this.entries.delete(id);
      return entry.bytes;
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
