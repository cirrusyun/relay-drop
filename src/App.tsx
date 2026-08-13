import {
  Archive,
  Check,
  Clipboard,
  CloudUpload,
  Copy,
  Download,
  File,
  FileArchive,
  FileText,
  Film,
  Image,
  LoaderCircle,
  Moon,
  Music,
  Pencil,
  RefreshCw,
  Search,
  ShieldCheck,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface ClipboardState {
  content: string;
  updatedAt: string | null;
}

interface RelayFile {
  id: string;
  name: string;
  size: number;
  mime: string;
  createdAt: string;
  hasThumbnail: boolean;
}

interface RelayState {
  clipboard: ClipboardState;
  files: RelayFile[];
  limits: { maxUploadBytes: number };
  storage: { usedBytes: number; maxBytes: number };
}

interface UploadTask {
  id: string;
  name: string;
  progress: number;
  status: "uploading" | "done" | "error";
  error?: string;
}

interface ToastState {
  id: number;
  message: string;
  kind: "success" | "error";
}

const EMPTY_STATE: RelayState = {
  clipboard: { content: "", updatedAt: null },
  files: [],
  limits: { maxUploadBytes: 2 * 1024 * 1024 * 1024 },
  storage: { usedBytes: 0, maxBytes: 20 * 1024 * 1024 * 1024 },
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error || `请求失败（${response.status}）`);
  }
  return response.status === 204 ? (undefined as T) : response.json() as Promise<T>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function pastedImageName(file: globalThis.File, index: number): string {
  const extensionByType: Record<string, string> = {
    "image/avif": "avif",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/svg+xml": "svg",
    "image/webp": "webp",
  };
  const existingExtension = file.name.match(/\.([a-z0-9]{2,8})$/i)?.[1]?.toLowerCase();
  const extension = existingExtension || extensionByType[file.type] || "png";
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return `剪贴板图片-${stamp}${index ? `-${index + 1}` : ""}.${extension}`;
}

function relativeTime(value: string | null): string {
  if (!value) return "还没有内容";
  const delta = new Date(value).getTime() - Date.now();
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  const minutes = Math.round(delta / 60_000);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(delta / 3_600_000);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(delta / 86_400_000), "day");
}

function iconFor(file: RelayFile): ReactNode {
  const props = { size: 20, strokeWidth: 1.8, "aria-hidden": true };
  if (file.mime.startsWith("image/")) return <Image {...props} />;
  if (file.mime.startsWith("video/")) return <Film {...props} />;
  if (file.mime.startsWith("audio/")) return <Music {...props} />;
  if (/\.(zip|rar|7z|tar|gz|bz2)$/i.test(file.name)) return <FileArchive {...props} />;
  if (file.mime.startsWith("text/") || /\.(md|txt|json|csv|log|yml|yaml)$/i.test(file.name)) {
    return <FileText {...props} />;
  }
  return <File {...props} />;
}

function FileVisual({ file }: { file: RelayFile }) {
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  if (file.hasThumbnail && !thumbnailFailed) {
    return (
      <div className="file-icon file-thumbnail">
        <img
          src={`/api/files/${file.id}/thumbnail`}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setThumbnailFailed(true)}
        />
      </div>
    );
  }
  return <div className="file-icon">{iconFor(file)}</div>;
}

export default function App() {
  const [state, setState] = useState<RelayState>(EMPTY_STATE);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadTask[]>([]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"newest" | "name" | "size">("newest");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem("relay-theme");
    return saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  const [toast, setToast] = useState<ToastState | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirtyRef = useRef(false);
  const clipboardFocused = useRef(false);
  const toastId = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("relay-theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const notify = useCallback((message: string, kind: "success" | "error" = "success") => {
    const id = ++toastId.current;
    setToast({ id, message, kind });
    window.setTimeout(() => setToast((current) => current?.id === id ? null : current), 2800);
  }, []);

  const loadState = useCallback(async (forceClipboard = false) => {
    try {
      const next = await api<RelayState>("/api/state");
      setState(next);
      if (forceClipboard || (!dirtyRef.current && !clipboardFocused.current)) {
        setDraft(next.clipboard.content);
        setDirty(false);
      }
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void loadState(true);
    const timer = window.setInterval(() => void loadState(), 10_000);
    return () => window.clearInterval(timer);
  }, [loadState]);

  const saveClipboard = useCallback(async () => {
    setSaving(true);
    try {
      const result = await api<{ clipboard: ClipboardState }>("/api/clipboard", {
        method: "PUT",
        body: JSON.stringify({ content: draft }),
      });
      setState((current) => ({ ...current, clipboard: result.clipboard }));
      setDirty(false);
      notify("剪贴板已同步到所有设备");
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }, [draft, notify]);

  const copyClipboard = async () => {
    if (!draft) return notify("剪贴板还是空的", "error");
    try {
      await navigator.clipboard.writeText(draft);
      notify("已复制到本机剪贴板");
    } catch {
      notify("浏览器没有允许复制，请手动选择文字", "error");
    }
  };

  const clearClipboard = async () => {
    if (draft && !window.confirm("清空后，其他设备也会看到空白剪贴板。继续吗？")) return;
    setSaving(true);
    try {
      const result = await api<{ clipboard: ClipboardState }>("/api/clipboard", { method: "DELETE" });
      setDraft("");
      setDirty(false);
      setState((current) => ({ ...current, clipboard: result.clipboard }));
      notify("共享剪贴板已清空");
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const updateUpload = (id: string, patch: Partial<UploadTask>) => {
    setUploads((current) => current.map((task) => task.id === id ? { ...task, ...patch } : task));
  };

  const uploadOne = (file: globalThis.File, taskId: string): Promise<void> => new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/files");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) updateUpload(taskId, { progress: Math.round(event.loaded / event.total * 100) });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        updateUpload(taskId, { progress: 100, status: "done" });
      } else {
        let message = "上传失败";
        try { message = JSON.parse(xhr.responseText).error || message; } catch { /* noop */ }
        updateUpload(taskId, { status: "error", error: message });
      }
      resolve();
    };
    xhr.onerror = () => {
      updateUpload(taskId, { status: "error", error: "网络连接中断" });
      resolve();
    };
    const body = new FormData();
    body.append("file", file, file.name);
    xhr.send(body);
  });

  const addFiles = async (incoming: FileList | globalThis.File[]) => {
    const files = Array.from(incoming);
    if (!files.length) return;
    let available = Math.max(0, state.storage.maxBytes - state.storage.usedBytes);
    const accepted = files.filter((file) => {
      if (file.size > state.limits.maxUploadBytes) {
        notify(`${file.name} 超过 ${formatBytes(state.limits.maxUploadBytes)} 单文件限制`, "error");
        return false;
      }
      if (file.size > available) {
        notify(`${file.name} 会超过共享空间的 20 GiB 上限`, "error");
        return false;
      }
      available -= file.size;
      return true;
    });
    const tasks = accepted.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      progress: 0,
      status: "uploading" as const,
    }));
    setUploads((current) => [...tasks, ...current].slice(0, 12));
    await Promise.all(accepted.map((file, index) => uploadOne(file, tasks[index].id)));
    await loadState();
    if (accepted.length) notify(`${accepted.length} 个文件已放入中转区`);
    window.setTimeout(() => setUploads((current) => current.filter((task) => task.status !== "done")), 2200);
  };

  const onClipboardPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is globalThis.File => file !== null)
      .map((file, index) => new globalThis.File([file], pastedImageName(file, index), {
        type: file.type || "image/png",
        lastModified: Date.now(),
      }));

    if (!images.length) return;
    event.preventDefault();
    void addFiles(images);
  };

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void addFiles(event.target.files);
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void addFiles(event.dataTransfer.files);
  };

  const deleteFile = async (file: RelayFile) => {
    if (!window.confirm(`删除“${file.name}”？这会立即从所有设备移除。`)) return;
    try {
      await api<void>(`/api/files/${file.id}`, { method: "DELETE" });
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(file.id);
        return next;
      });
      await loadState();
      notify("文件已删除");
    } catch (error) {
      notify((error as Error).message, "error");
    }
  };

  const startRename = (file: RelayFile) => {
    setEditingId(file.id);
    setRenameDraft(file.name);
  };

  const cancelRename = () => {
    if (renaming) return;
    setEditingId(null);
    setRenameDraft("");
  };

  const saveRename = async (file: RelayFile) => {
    const name = renameDraft.trim();
    if (!name) return notify("文件名不能为空", "error");
    if (name === file.name) return cancelRename();
    setRenaming(true);
    try {
      const result = await api<{ file: RelayFile }>(`/api/files/${file.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      setState((current) => ({
        ...current,
        files: current.files.map((item) => item.id === file.id ? result.file : item),
      }));
      setEditingId(null);
      setRenameDraft("");
      notify("文件名已更新");
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setRenaming(false);
    }
  };

  const visibleFiles = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const files = state.files.filter((file) => file.name.toLocaleLowerCase().includes(normalized));
    return [...files].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name, "zh-CN");
      if (sort === "size") return b.size - a.size;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [query, sort, state.files]);

  useEffect(() => {
    const existing = new Set(state.files.map((file) => file.id));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => existing.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [state.files]);

  const allVisibleSelected = visibleFiles.length > 0
    && visibleFiles.every((file) => selectedIds.has(file.id));

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const file of visibleFiles) {
        if (allVisibleSelected) next.delete(file.id);
        else next.add(file.id);
      }
      return next;
    });
  };

  const deleteSelected = async () => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    if (!window.confirm(`确认删除选中的 ${ids.length} 个文件？这会立即从所有设备移除。`)) return;
    setBatchDeleting(true);
    try {
      const result = await api<{
        removedIds: string[];
        storage: RelayState["storage"];
      }>("/api/files", {
        method: "DELETE",
        body: JSON.stringify({ ids }),
      });
      const removed = new Set(result.removedIds);
      setState((current) => ({
        ...current,
        files: current.files.filter((file) => !removed.has(file.id)),
        storage: result.storage,
      }));
      setSelectedIds((current) => new Set([...current].filter((id) => !removed.has(id))));
      notify(`已删除 ${result.removedIds.length} 个文件`);
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setBatchDeleting(false);
    }
  };

  return (
    <main className="shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><CloudUpload size={19} strokeWidth={2} /></div>
          <div>
            <strong>Relay</strong>
            <span>私人文件传输助手</span>
          </div>
        </div>
        <div className="topbar-actions">
          <div className="connection"><span />已连接共享空间</div>
          <button className="icon-button" onClick={() => setDark((value) => !value)} aria-label="切换明暗主题">
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>

      <section className="card clipboard-card">
        <div className="card-heading">
          <div className="heading-copy">
            <div className="section-icon violet"><Clipboard size={19} /></div>
            <div>
              <h2>共享剪贴板</h2>
              <p>{dirty ? "有改动尚未保存" : `上次同步：${relativeTime(state.clipboard.updatedAt)}`}</p>
            </div>
          </div>
          <div className={`save-state ${dirty ? "is-dirty" : ""}`}>
            <span />{dirty ? "待同步" : "已同步"}
          </div>
        </div>

        <textarea
          value={draft}
          onChange={(event) => { setDraft(event.target.value); setDirty(event.target.value !== state.clipboard.content); }}
          onPaste={onClipboardPaste}
          onFocus={() => { clipboardFocused.current = true; }}
          onBlur={() => { clipboardFocused.current = false; }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              if (dirty && !saving) void saveClipboard();
            }
          }}
          placeholder={"粘贴命令、网址、地址或一段临时文字…\n也可以直接粘贴截图或图片，自动放入下方文件区\n\n⌘ / Ctrl + Enter 快速保存"}
          aria-label="共享剪贴板内容"
          spellCheck={false}
        />

        <div className="clipboard-footer">
          <span>{draft.length.toLocaleString("zh-CN")} 个字符 · 支持直接粘贴截图</span>
          <div className="button-row">
            <button className="button ghost danger-ghost" onClick={() => void clearClipboard()} disabled={saving || (!draft && !state.clipboard.content)}>
              <Trash2 size={16} /> 清空
            </button>
            <button className="button secondary" onClick={() => void copyClipboard()} disabled={!draft}>
              <Copy size={16} /> 复制
            </button>
            <button className="button primary" onClick={() => void saveClipboard()} disabled={!dirty || saving}>
              {saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
              {saving ? "保存中" : "保存并同步"}
            </button>
          </div>
        </div>
      </section>

      <section className="card files-card">
        <div className="card-heading files-heading">
          <div className="heading-copy">
            <div className="section-icon blue"><Archive size={19} /></div>
            <div>
              <h2>文件中转区</h2>
              <p>{state.files.length ? `共享空间里有 ${state.files.length} 个文件` : "上传后，其他设备刷新即可看见"}</p>
            </div>
          </div>
          <div className="storage-group">
            <div className="storage-copy">
              <span>{formatBytes(state.storage.usedBytes)} / {formatBytes(state.storage.maxBytes)}</span>
              <div className="storage-track"><span style={{ width: `${Math.min(100, state.storage.usedBytes / state.storage.maxBytes * 100)}%` }} /></div>
            </div>
            <button className="icon-button" onClick={() => void loadState()} aria-label="刷新文件列表" title="刷新">
              <RefreshCw size={17} />
            </button>
          </div>
        </div>

        <div
          className={`dropzone ${dragging ? "is-dragging" : ""}`}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
          }}
          onDrop={onDrop}
          onClick={() => fileInput.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") fileInput.current?.click();
          }}
          role="button"
          tabIndex={0}
          aria-label="选择或拖拽文件上传"
        >
          <input ref={fileInput} type="file" multiple hidden onChange={onFileInput} />
          <div className="drop-icon"><CloudUpload size={24} /></div>
          <div className="drop-copy">
            <strong>{dragging ? "松开即可上传" : "拖拽文件到这里"}</strong>
            <span>或点按选择多个文件 · 单个最大 {formatBytes(state.limits.maxUploadBytes)}</span>
          </div>
        </div>

        {uploads.length > 0 && (
          <div className="upload-stack" aria-live="polite">
            {uploads.map((task) => (
              <div className={`upload-task ${task.status}`} key={task.id}>
                <div className="task-state">
                  {task.status === "done" ? <Check size={15} /> : task.status === "error" ? <X size={15} /> : <LoaderCircle className="spin" size={15} />}
                </div>
                <div className="task-main">
                  <div><strong>{task.name}</strong><span>{task.error || `${task.progress}%`}</span></div>
                  <div className="progress-track"><span style={{ width: `${task.progress}%` }} /></div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="list-toolbar">
          <label className="search-box">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件" aria-label="搜索文件" />
            {query && <button onClick={() => setQuery("")} aria-label="清除搜索"><X size={14} /></button>}
          </label>
          {visibleFiles.length > 0 && (
            <div className="selection-tools">
              <label className="select-all">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleAllVisible}
                  aria-label={query ? "全选搜索结果" : "全选文件"}
                />
                <span>{query ? "全选结果" : "全选"}</span>
              </label>
              {selectedIds.size > 0 && (
                <button className="batch-delete" onClick={() => void deleteSelected()} disabled={batchDeleting}>
                  {batchDeleting ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}
                  删除 {selectedIds.size} 项
                </button>
              )}
            </div>
          )}
          <select className="sort-select" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} aria-label="文件排序">
            <option value="newest">最新上传</option>
            <option value="name">按名称</option>
            <option value="size">按大小</option>
          </select>
        </div>

        <div className="file-list">
          {loading ? (
            <div className="empty-state"><LoaderCircle className="spin" size={22} /><strong>正在连接共享空间</strong></div>
          ) : visibleFiles.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon"><File size={23} /></div>
              <strong>{query ? "没有匹配的文件" : "这里还没有文件"}</strong>
              <span>{query ? "换一个关键词试试" : "从任意设备上传，都会出现在这里"}</span>
            </div>
          ) : visibleFiles.map((file) => (
            <article className={`file-row ${selectedIds.has(file.id) ? "is-selected" : ""}`} key={file.id}>
              <label className="row-select">
                <input
                  type="checkbox"
                  checked={selectedIds.has(file.id)}
                  onChange={() => toggleSelected(file.id)}
                  aria-label={`选择 ${file.name}`}
                />
              </label>
              <FileVisual file={file} />
              <div className="file-info">
                {editingId === file.id ? (
                  <input
                    className="rename-input"
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onFocus={(event) => event.currentTarget.select()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        if (!renaming) void saveRename(file);
                      }
                      if (event.key === "Escape") cancelRename();
                    }}
                    aria-label={`修改 ${file.name} 的文件名`}
                    maxLength={180}
                    autoFocus
                  />
                ) : <strong title={file.name}>{file.name}</strong>}
                <span>{formatBytes(file.size)} · {relativeTime(file.createdAt)}</span>
              </div>
              <div className="file-actions">
                {editingId === file.id ? (
                  <>
                    <button className="file-action confirm-action" onClick={() => void saveRename(file)} disabled={renaming || !renameDraft.trim()} title="保存文件名" aria-label={`保存 ${file.name} 的新文件名`}>
                      {renaming ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
                    </button>
                    <button className="file-action" onClick={cancelRename} disabled={renaming} title="取消重命名" aria-label={`取消修改 ${file.name}`}>
                      <X size={16} />
                    </button>
                  </>
                ) : (
                  <>
                    <button className="file-action rename-action" onClick={() => startRename(file)} title="重命名" aria-label={`重命名 ${file.name}`}>
                      <Pencil size={15} />
                    </button>
                    <a className="file-action primary-action" href={`/api/files/${file.id}/download`} title="下载" aria-label={`下载 ${file.name}`}>
                      <Download size={17} />
                    </a>
                    <button className="file-action delete-action" onClick={() => void deleteFile(file)} title="删除" aria-label={`删除 ${file.name}`}>
                      <Trash2 size={16} />
                    </button>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>

      <footer>
        <span><ShieldCheck size={14} /> HTTPS 与登录保护由部署入口提供</span>
        <span>文件永久保存，按需手动删除</span>
      </footer>

      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          {toast.kind === "success" ? <Check size={16} /> : <X size={16} />}
          {toast.message}
        </div>
      )}
    </main>
  );
}
