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
  RotateCcw,
  Search,
  ShieldCheck,
  Sun,
  Trash2,
  TriangleAlert,
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
  // 保留原文件引用，失败后可以在同一行重试，而不是新增一行。
  file: globalThis.File;
  // 只有网络类失败值得重试；配额、体积这类结论重试也不会变。
  retryable?: boolean;
  // 瞬时上行速度，字节/秒。慢的时候用户至少知道它还在动。
  speed?: number;
}

type UploadOutcome = { ok: true } | { ok: false; message: string; retryable: boolean };

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

// 并发上传会共用同一条 HTTP/2 连接：链路一断，所有文件一起失败。
// 但网好的时候串行又太亏，所以并发数不写死，按实测的「上行速度」自己调。
const UPLOAD_CONCURRENCY_MAX = 4;
// 超过这个时间一个字节都没有前进，就认为链路已经死了，主动中断而不是干等。
// 用「停滞时长」而不是「总时长」，大文件慢慢传也不会被误杀。
const UPLOAD_STALL_MS = 90_000;
// 网络类失败的尝试总次数（含第一次）。
const UPLOAD_MAX_ATTEMPTS = 3;
// 进度采样间隔，用来算瞬时速度。
const SPEED_SAMPLE_MS = 500;
// 测速结果的保质期。网络状况随时会变，超过这个时间就当没测过，重新用一个文件探路。
const SPEED_FRESH_MS = 60_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => { window.setTimeout(resolve, ms); });

interface NetworkInformation { saveData?: boolean }

// 按实测上行速度决定并发数。
// 注意只用「上传」测出来的速度：navigator.connection 的 effectiveType 反映的是下行，
// 而「下行正常、上行垮掉」是很常见的一种情况，用它判断会得出完全相反的结论。
function concurrencyForSpeed(bytesPerSecond: number | null): number {
  if (bytesPerSecond == null) return 1;                       // 还没测过：先用一个文件探路
  if (bytesPerSecond >= 4 * 1024 * 1024) return UPLOAD_CONCURRENCY_MAX;
  if (bytesPerSecond >= 1024 * 1024) return 3;
  if (bytesPerSecond >= 384 * 1024) return 2;
  return 1;                                                    // 弱网：串行，保住已经传完的
}

function prefersReducedData(): boolean {
  return (navigator as Navigator & { connection?: NetworkInformation }).connection?.saveData === true;
}

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

// 重命名时默认只选中扩展名之前的部分，和 Finder / 资源管理器一致。
// 想改扩展名仍然可以：⌘A 全选，或者把光标移到后面。
// 约定：
//   photo.png      -> 选中 "photo"
//   archive.tar.gz -> 选中 "archive.tar"（按最后一个点切）
//   .gitignore     -> 全选（点在开头，前面没有可选的名字）
//   README         -> 全选（没有扩展名）
function baseNameEnd(value: string): number {
  const lastDot = value.lastIndexOf(".");
  return lastDot > 0 ? lastDot : value.length;
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
  const renameInput = useRef<HTMLInputElement>(null);
  const dirtyRef = useRef(false);
  const clipboardFocused = useRef(false);
  const toastId = useRef(0);
  // 实测上行速度（字节/秒）的滑动平均，跨批次沿用，但有保质期。
  const linkSpeed = useRef<number | null>(null);
  const linkSpeedAt = useRef(0);
  // 正在飞的请求，用来支持取消。
  const activeUploads = useRef(new Map<string, XMLHttpRequest>());
  const cancelled = useRef(new Set<string>());
  // 所有上传（新批次和手动重试）共用一条队列，避免多批并发一起压垮弱网链路。
  const uploadChain = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("relay-theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // 进入重命名时聚焦并只选中主文件名。
  // 放在 effect 里而不是 onFocus 里，是为了只在开始编辑那一次生效——
  // 否则用户点回输入框想定位光标时，会被重新全选覆盖掉。
  useEffect(() => {
    const input = renameInput.current;
    if (!editingId || !input) return;
    input.focus();
    input.setSelectionRange(0, baseNameEnd(input.value));
  }, [editingId]);

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

  // 用实测上行速度的滑动平均驱动并发数，跨批次保留，第二批就不用再从 1 探起。
  const noteLinkSpeed = (bytes: number, elapsedMs: number) => {
    if (bytes <= 0 || elapsedMs <= 0) return;
    const sample = bytes / (elapsedMs / 1000);
    const previous = freshLinkSpeed();
    linkSpeed.current = previous == null ? sample : previous * 0.6 + sample * 0.4;
    linkSpeedAt.current = Date.now();
  };

  // 过期或刚失败过的测速结果一律不信，重新探路。
  const freshLinkSpeed = (): number | null =>
    Date.now() - linkSpeedAt.current <= SPEED_FRESH_MS ? linkSpeed.current : null;

  const forgetLinkSpeed = () => {
    linkSpeed.current = null;
    linkSpeedAt.current = 0;
  };

  const sendOnce = (file: globalThis.File, taskId: string): Promise<UploadOutcome> => new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const startedAt = Date.now();
    let lastMovedAt = startedAt;
    let sampleAt = startedAt;
    let sampleLoaded = 0;
    let stalled = false;

    // XHR 自带的 timeout 是「总时长」，4 GiB 的文件慢慢传也会被它砍掉。
    // 这里改成看「有没有字节在动」，只有真的卡死才中断。
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastMovedAt < UPLOAD_STALL_MS) return;
      stalled = true;
      xhr.abort();
    }, 5_000);

    const settle = (outcome: UploadOutcome) => {
      window.clearInterval(watchdog);
      activeUploads.current.delete(taskId);
      resolve(outcome);
    };

    activeUploads.current.set(taskId, xhr);
    xhr.open("POST", "/api/files");
    xhr.upload.onprogress = (event) => {
      const now = Date.now();
      lastMovedAt = now;
      if (!event.lengthComputable) return;
      const patch: Partial<UploadTask> = { progress: Math.round(event.loaded / event.total * 100) };
      if (now - sampleAt >= SPEED_SAMPLE_MS) {
        patch.speed = (event.loaded - sampleLoaded) / ((now - sampleAt) / 1000);
        sampleAt = now;
        sampleLoaded = event.loaded;
      }
      updateUpload(taskId, patch);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        noteLinkSpeed(file.size, Date.now() - startedAt);
        settle({ ok: true });
        return;
      }
      let message = `上传失败（${xhr.status}）`;
      try { message = JSON.parse(xhr.responseText).error || message; } catch { /* noop */ }
      // 网关类错误多半是链路抖动，值得重试；配额、体积、文件名这些服务器已经给出结论。
      settle({ ok: false, message, retryable: xhr.status === 502 || xhr.status === 503 || xhr.status === 504 });
    };
    xhr.onerror = () => settle({ ok: false, message: "网络连接中断", retryable: true });
    xhr.onabort = () => {
      // 用户主动取消不该被自动重试；只有卡死中断才重试。
      if (cancelled.current.has(taskId)) return settle({ ok: false, message: "已取消", retryable: false });
      settle(stalled
        ? { ok: false, message: `上传停滞超过 ${Math.round(UPLOAD_STALL_MS / 1000)} 秒`, retryable: true }
        : { ok: false, message: "上传已中断", retryable: true });
    };

    const body = new FormData();
    body.append("file", file, file.name);
    xhr.send(body);
  });

  const uploadOne = async (file: globalThis.File, taskId: string): Promise<boolean> => {
    for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt += 1) {
      if (cancelled.current.has(taskId)) break;
      updateUpload(taskId, { status: "uploading", progress: 0, error: undefined, retryable: undefined, speed: undefined });
      const outcome = await sendOnce(file, taskId);
      if (outcome.ok) {
        updateUpload(taskId, { progress: 100, status: "done", error: undefined, speed: undefined });
        return true;
      }
      if (cancelled.current.has(taskId)) break;
      if (!outcome.retryable || attempt === UPLOAD_MAX_ATTEMPTS) {
        updateUpload(taskId, { status: "error", error: outcome.message, retryable: outcome.retryable, speed: undefined });
        return false;
      }
      // 退避期间把原因留在行里，用户能看到「为什么在等」。下一轮开头会清掉。
      updateUpload(taskId, { error: `${outcome.message}，重试中（${attempt + 1}/${UPLOAD_MAX_ATTEMPTS}）`, speed: undefined });
      await delay(attempt * 1500);
    }
    // 取消过的任务留一个可以手动重来的入口。
    updateUpload(taskId, { status: "error", error: "已取消", retryable: true, speed: undefined });
    return false;
  };

  const cancelUpload = (taskId: string) => {
    cancelled.current.add(taskId);
    activeUploads.current.get(taskId)?.abort();
  };

  // 自适应并发队列：网快就多开几路，一旦出现网络类失败立刻退回串行。
  const runUploadQueue = (items: Array<{ file: globalThis.File; taskId: string }>): Promise<number> =>
    new Promise((resolve) => {
      let cursor = 0;
      let active = 0;
      let succeeded = 0;
      let degraded = false;
      // 每批都先用一个文件探路。上一批测到的速度不能证明这一刻链路还活着，
      // 而一旦链路是死的，探路只赔上 1 个文件，而不是一次赔上一整批。
      // 探路成功后立刻按实测速度提档，网好的时候这点代价可以忽略。
      let target = 1;

      const pump = () => {
        if (cursor >= items.length && active === 0) {
          resolve(succeeded);
          return;
        }
        while (active < target && cursor < items.length) {
          const item = items[cursor];
          cursor += 1;
          active += 1;
          void uploadOne(item.file, item.taskId).then((ok) => {
            active -= 1;
            if (ok) {
              succeeded += 1;
              // 一路顺利就按最新实测速度重新定档，网好的时候能迅速开到上限。
              if (!degraded && !prefersReducedData()) {
                target = Math.max(target, Math.min(concurrencyForSpeed(freshLinkSpeed()), items.length));
              }
            } else {
              // 失败就退回串行，把剩下的文件一个一个稳稳送上去，
              // 并丢掉旧的测速结果——链路刚出过问题，之前那个「很快」已经不作数了。
              degraded = true;
              target = 1;
              forgetLinkSpeed();
            }
            pump();
          });
        }
      };

      if (!items.length) resolve(0);
      else pump();
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
    if (!accepted.length) return;
    const tasks = accepted.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      progress: 0,
      status: "uploading" as const,
      file,
    }));
    setUploads((current) => [...tasks, ...current].slice(0, 12));

    // 批次之间也要排队。否则连着拖两次文件，就变成两条队列各自并发，
    // 弱网下又回到「一起发、一起失败」的老问题。
    uploadChain.current = uploadChain.current.then(async () => {
      const succeeded = await runUploadQueue(accepted.map((file, index) => ({ file, taskId: tasks[index].id })));
      await loadState();
      const failed = accepted.length - succeeded;
      if (!failed) notify(`${succeeded} 个文件已放入中转区`);
      else if (!succeeded) notify(`${failed} 个文件上传失败，可以点重试`, "error");
      else notify(`${succeeded} 个已上传，${failed} 个失败，可以点重试`, "error");
      window.setTimeout(() => setUploads((current) => current.filter((task) => task.status !== "done")), 2200);
    });
  };

  const retryUpload = (taskId: string) => {
    const task = uploads.find((item) => item.id === taskId);
    if (!task || task.status === "uploading") return;
    updateUpload(taskId, { status: "uploading", progress: 0, error: undefined });
    uploadChain.current = uploadChain.current.then(async () => {
      cancelled.current.delete(taskId);
      const ok = await uploadOne(task.file, taskId);
      await loadState();
      notify(ok ? `${task.name} 已放入中转区` : `${task.name} 仍然失败`, ok ? "success" : "error");
      if (ok) window.setTimeout(() => setUploads((current) => current.filter((item) => item.status !== "done")), 2200);
    });
  };

  const dismissUpload = (taskId: string) => {
    cancelled.current.delete(taskId);
    setUploads((current) => current.filter((task) => task.id !== taskId));
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
                  {/* 失败用警告图标而不是 ✕：这里是状态指示，不是关闭按钮。
                      右侧那个 ✕ 才是真正能点掉这条记录的。 */}
                  {task.status === "done" ? <Check size={15} /> : task.status === "error" ? <TriangleAlert size={15} /> : <LoaderCircle className="spin" size={15} />}
                </div>
                <div className="task-main">
                  <div>
                    <strong>{task.name}</strong>
                    <span>
                      {task.error
                        || (task.speed ? `${task.progress}% · ${formatBytes(task.speed)}/s` : `${task.progress}%`)}
                    </span>
                  </div>
                  <div className="progress-track"><span style={{ width: `${task.progress}%` }} /></div>
                </div>
                {task.status !== "done" && (
                  <div className="task-actions">
                    {task.status === "uploading" && (
                      <button onClick={() => cancelUpload(task.id)} aria-label={`取消上传 ${task.name}`} title="取消">
                        <X size={14} />
                      </button>
                    )}
                    {task.status === "error" && task.retryable && (
                      <button onClick={() => retryUpload(task.id)} aria-label={`重试上传 ${task.name}`} title="重试">
                        <RotateCcw size={14} />
                      </button>
                    )}
                    {task.status === "error" && (
                      <button onClick={() => dismissUpload(task.id)} aria-label={`不再显示 ${task.name}`} title="移除这条记录">
                        <X size={14} />
                      </button>
                    )}
                  </div>
                )}
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
                    ref={renameInput}
                    className="rename-input"
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        if (!renaming) void saveRename(file);
                      }
                      if (event.key === "Escape") cancelRename();
                    }}
                    aria-label={`修改 ${file.name} 的文件名`}
                    maxLength={180}
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
