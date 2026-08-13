import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

export function normalizeFilename(value: string): string {
  const base = path.basename(value.replaceAll("\\", "/"));
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();
  return (cleaned || "未命名文件").slice(0, 180);
}

export class RelayStore {
  readonly dataDir: string;
  readonly filesDir: string;
  readonly thumbnailsDir: string;
  readonly statePath: string;

  private state: PersistedState = structuredClone(EMPTY_STATE);
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    this.filesDir = path.join(this.dataDir, "files");
    this.thumbnailsDir = path.join(this.dataDir, "thumbnails");
    this.statePath = path.join(this.dataDir, "state.json");
  }

  async init(): Promise<void> {
    await mkdir(this.filesDir, { recursive: true });
    await mkdir(this.thumbnailsDir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as PersistedState;
      if (parsed.version !== 1 || !Array.isArray(parsed.files) || !parsed.clipboard) {
        throw new Error("Unsupported state file format");
      }
      this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist();
    }
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
    if (!/^[a-f0-9-]{36}$/.test(file.storedName)) {
      throw new Error("Unsafe stored filename");
    }
    const candidate = path.join(this.filesDir, file.storedName);
    if (path.dirname(candidate) !== this.filesDir) throw new Error("Unsafe file path");
    return candidate;
  }

  thumbnailPath(file: FileRecord): string {
    if (!/^[a-f0-9-]{36}$/.test(file.storedName)) {
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
    await this.mutate(async () => {
      result = { content, updatedAt: new Date().toISOString() };
      this.state.clipboard = result;
    });
    return { ...result };
  }

  async addFile(input: Omit<FileRecord, "id">): Promise<FileRecord> {
    let result!: FileRecord;
    await this.mutate(async () => {
      result = { id: randomUUID(), ...input };
      this.state.files.push(result);
    });
    return { ...result };
  }

  async renameFile(id: string, name: string): Promise<FileRecord | undefined> {
    let result: FileRecord | undefined;
    await this.mutate(async () => {
      const file = this.state.files.find((candidate) => candidate.id === id);
      if (!file) return;
      file.name = name;
      result = { ...file };
    });
    return result;
  }

  async deleteFiles(ids: Iterable<string>): Promise<{ files: FileRecord[]; thumbnailBytes: number }> {
    const requested = new Set(ids);
    let removed: FileRecord[] = [];
    let thumbnailBytes = 0;
    await this.mutate(async () => {
      removed = this.state.files.filter((candidate) => requested.has(candidate.id));
      if (!removed.length) return;
      for (const file of removed) {
        thumbnailBytes += await this.thumbnailSize(file);
        await rm(this.filePath(file), { force: true });
        await rm(this.thumbnailPath(file), { force: true });
      }
      this.state.files = this.state.files.filter((candidate) => !requested.has(candidate.id));
    });
    return { files: removed.map((file) => ({ ...file })), thumbnailBytes };
  }

  async verifyFile(file: FileRecord): Promise<boolean> {
    try {
      return (await stat(this.filePath(file))).isFile();
    } catch {
      return false;
    }
  }

  async thumbnailSize(file: FileRecord): Promise<number> {
    try {
      const details = await stat(this.thumbnailPath(file));
      return details.isFile() ? details.size : 0;
    } catch {
      return 0;
    }
  }

  async totalThumbnailBytes(): Promise<number> {
    const sizes = await Promise.all(this.state.files.map((file) => this.thumbnailSize(file)));
    return sizes.reduce((sum, size) => sum + size, 0);
  }

  private async mutate(action: () => Promise<void>): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      await action();
      await this.persist();
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async persist(): Promise<void> {
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.statePath);
  }
}
