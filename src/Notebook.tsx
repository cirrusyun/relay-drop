import { ArrowLeft, BookOpen, Check, Copy, ImagePlus, LoaderCircle, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { type ChangeEvent, type ClipboardEvent, type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { ImageLightbox } from "./ImageLightbox";
import { canApplyNoteRead, emptyNoteDraft, sameNoteDraft, settleNoteWrite, type Note, type NoteDraft, type NoteSummary } from "./note-editor";

export interface NotebookHandle { saveBeforeLeave(): Promise<boolean> }
export interface NotebookImage { id: string; name: string; mime: string; hasThumbnail: boolean }
interface Props {
  ref?: Ref<NotebookHandle>;
  open: boolean;
  revision: number;
  files: NotebookImage[];
  onBack(): void;
  onStorageChange(): void;
  onUploadImages(files: globalThis.File[]): Promise<NotebookImage[]>;
  notify(message: string, kind?: "success" | "error"): void;
}
const emptyDraft: NoteDraft = { title: "", content: "", attachments: [] };
const NOTE_IMAGE_TYPES = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);

async function noteApi<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  try { return await api<T>(url, { ...init, signal: controller.signal }); }
  catch (cause) {
    if (controller.signal.aborted) throw new Error("连接超时，当前文字仍保留在编辑区，请重试。");
    throw cause;
  } finally { window.clearTimeout(timeout); }
}

export function Notebook({ ref, open, revision, files, onBack, onStorageChange, onUploadImages, notify }: Props) {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [selected, setSelected] = useState<Note | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const [uploadingImages, setUploadingImages] = useState(false);
  const [previewImage, setPreviewImage] = useState<NotebookImage | null>(null);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selectedRef = useRef<Note | null>(null);
  const draftRef = useRef(emptyDraft);
  const actionPending = useRef(false);
  const deleting = useRef(false);
  const savePending = useRef<Promise<boolean> | null>(null);
  const isNewRef = useRef(false);
  const createAttempt = useRef<NoteDraft | null>(null);
  const editRevision = useRef(0);
  const composing = useRef(false);
  const uploadingImagesRef = useRef(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const listRequest = useRef(0);
  const busy = working || saving || uploadingImages;
  const hasChanges = () => selectedRef.current !== null && (isNewRef.current
    ? !emptyNoteDraft(draftRef.current) || createAttempt.current !== null
    : !sameNoteDraft(draftRef.current, selectedRef.current));
  const dirty = selected !== null && (isNew ? !emptyNoteDraft(draft) || createAttempt.current !== null : !sameNoteDraft(draft, selected));

  const useNote = useCallback((note: Note | null, fresh = false) => {
    editRevision.current += 1;
    selectedRef.current = note;
    draftRef.current = note ? { title: note.title, content: note.content, attachments: [...note.attachments] } : emptyDraft;
    isNewRef.current = fresh;
    createAttempt.current = null;
    setSelected(note);
    setDraft(draftRef.current);
    setIsNew(fresh);
    setConfirmDelete(false);
    setPreviewImage(null);
    setError("");
  }, []);

  const loadNotes = useCallback(async (refreshEditor = true) => {
    const request = ++listRequest.current;
    const note = selectedRef.current;
    const requestedRevision = editRevision.current;
    const refreshCurrent = refreshEditor && note && !isNewRef.current && !savePending.current
      && sameNoteDraft(draftRef.current, note) && !composing.current;
    setLoading(true);
    try {
      const result = await noteApi<{ notes: NoteSummary[] }>("/api/notes", { cache: "no-store" });
      if (request !== listRequest.current) return;
      setNotes(result.notes);
      if (!refreshCurrent) {
        if (!savePending.current && !isNewRef.current && sameNoteDraft(draftRef.current, selectedRef.current ?? emptyDraft)) setError("");
        return;
      }
      const current = await noteApi<{ note: Note }>(`/api/notes/${note.id}`, { cache: "no-store" });
      if (request === listRequest.current && canApplyNoteRead(note.id, selectedRef.current?.id, requestedRevision, editRevision.current, !sameNoteDraft(draftRef.current, selectedRef.current ?? emptyDraft), composing.current)) {
        useNote(current.note);
      }
    } catch (cause) {
      if (request !== listRequest.current) return;
      if (cause instanceof ApiError && cause.status === 404 && refreshCurrent
        && canApplyNoteRead(note.id, selectedRef.current?.id, requestedRevision, editRevision.current, !sameNoteDraft(draftRef.current, selectedRef.current ?? emptyDraft), composing.current)) {
        useNote(null);
      } else setError((cause as Error).message);
    }
    finally { if (request === listRequest.current) setLoading(false); }
  }, [useNote]);

  useEffect(() => { if (open) void loadNotes(); }, [open, revision, loadNotes]);

  const save = (silent = false): Promise<boolean> => {
    if (savePending.current) return savePending.current;
    if (composing.current || deleting.current) return Promise.resolve(false);
    const note = selectedRef.current;
    if (!note || !hasChanges()) return Promise.resolve(true);
    editRevision.current += 1;
    setSaving(true);
    const acceptSave = (saved: Note, submitted: NoteDraft) => {
      selectedRef.current = saved;
      setSelected(saved);
      isNewRef.current = false;
      setIsNew(false);
      if (!composing.current) {
        draftRef.current = settleNoteWrite(draftRef.current, submitted, saved);
        setDraft(draftRef.current);
      }
    };
    const operation = (async () => {
      try {
        if (isNewRef.current) {
          // Reuse the original payload and ID after an uncertain create result.
          createAttempt.current ??= { ...draftRef.current, attachments: [...draftRef.current.attachments] };
          const submitted = createAttempt.current;
          const result = await noteApi<{ note: Note }>("/api/notes", { method: "POST", body: JSON.stringify({ id: note.id, ...submitted }) });
          acceptSave(result.note, submitted);
          createAttempt.current = null;
        }
        if (hasChanges() && !composing.current) {
          const submitted = { ...draftRef.current, attachments: [...draftRef.current.attachments] };
          const result = await noteApi<{ note: Note }>(`/api/notes/${note.id}`, { method: "PUT", body: JSON.stringify(submitted) });
          acceptSave(result.note, submitted);
        }
        setError("");
        void loadNotes(false);
        onStorageChange();
        const saved = !hasChanges() && !composing.current;
        if (!silent) notify(saved ? "笔记已保存" : "已保存，新增文字仍保留在编辑区");
        return saved;
      } catch (cause) { setError((cause as Error).message); return false; }
      finally { savePending.current = null; setSaving(false); }
    })();
    savePending.current = operation;
    return operation;
  };

  useImperativeHandle(ref, () => ({
    async saveBeforeLeave() {
      if (uploadingImagesRef.current) return false;
      if (!(await save(true))) return false;
      // Ignore pending reads even if the user reopens the notebook immediately.
      editRevision.current += 1;
      if (isNewRef.current && !createAttempt.current && emptyNoteDraft(draftRef.current)) useNote(null);
      return true;
    },
  }));

  const changeDraft = <K extends keyof NoteDraft,>(field: K, value: NoteDraft[K]) => {
    editRevision.current += 1;
    draftRef.current = { ...draftRef.current, [field]: value };
    setDraft(draftRef.current);
  };

  const importImages = async (incoming: FileList | globalThis.File[]) => {
    const images = Array.from(incoming).filter((file) => NOTE_IMAGE_TYPES.has(file.type));
    if (!images.length) return notify("请选择 PNG、JPEG、GIF、WebP 或 AVIF 图片", "error");
    if (uploadingImagesRef.current) return notify("上一批图片仍在上传", "error");
    uploadingImagesRef.current = true;
    setUploadingImages(true);
    try {
      const uploaded = (await onUploadImages(images)).filter((file) => file.hasThumbnail);
      if (!uploaded.length) return notify("图片未能生成安全缩略图，已保留在文件中转区", "error");
      const uploadedIds = uploaded.map((file) => file.id);
      changeDraft("attachments", [...new Set([...draftRef.current.attachments, ...uploadedIds])]);
      await save(true);
      const persisted = uploadedIds.every((id) => selectedRef.current?.attachments.includes(id));
      notify(persisted ? "图片已添加并保存" : "图片已上传，但笔记保存失败，请重试", persisted ? "success" : "error");
    } catch (cause) {
      notify((cause as Error).message || "图片上传失败", "error");
    } finally {
      uploadingImagesRef.current = false;
      setUploadingImages(false);
    }
  };

  const onImageInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void importImages(event.target.files);
    event.target.value = "";
  };

  const onNotePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && NOTE_IMAGE_TYPES.has(item.type))
      .map((item) => item.getAsFile())
      .filter((file): file is globalThis.File => file !== null);
    if (!images.length) return;
    event.preventDefault();
    void importImages(images);
  };

  const openNote = async (id: string) => {
    if (actionPending.current || composing.current) return;
    actionPending.current = true;
    setWorking(true);
    try {
      if (!(await save(true))) return;
      const requestedId = selectedRef.current?.id;
      const requestedRevision = editRevision.current;
      const result = await noteApi<{ note: Note }>(`/api/notes/${id}`, { cache: "no-store" });
      if (canApplyNoteRead(requestedId, selectedRef.current?.id, requestedRevision, editRevision.current, hasChanges(), composing.current)) useNote(result.note);
    }
    catch (cause) { setError((cause as Error).message); }
    finally { actionPending.current = false; setWorking(false); }
  };

  const newNote = async () => {
    if (actionPending.current || composing.current) return;
    actionPending.current = true;
    setWorking(true);
    try {
      if (!(await save(true))) return;
      useNote({ id: crypto.randomUUID(), ...emptyDraft, attachments: [], createdAt: "", updatedAt: "" }, true);
    } finally { actionPending.current = false; setWorking(false); }
  };

  const removeNote = async () => {
    const note = selectedRef.current;
    if (!note || actionPending.current || savePending.current || composing.current) return;
    actionPending.current = true;
    deleting.current = true;
    setWorking(true);
    const requestedRevision = ++editRevision.current;
    try {
      if (!isNewRef.current || createAttempt.current) await noteApi<void>(`/api/notes/${note.id}`, { method: "DELETE" }).catch((cause: unknown) => {
        if (!(cause instanceof ApiError && cause.status === 404)) throw cause;
      });
      if (requestedRevision === editRevision.current) useNote(null);
      else useNote({ id: crypto.randomUUID(), ...draftRef.current, attachments: [...draftRef.current.attachments], createdAt: "", updatedAt: "" }, true);
      void loadNotes(false);
      onStorageChange();
      notify("笔记已删除");
    } catch (cause) { setError((cause as Error).message); }
    finally { deleting.current = false; actionPending.current = false; setWorking(false); }
  };

  return (
    <section className="notebook" hidden={!open} aria-label="记事本">
      <div className="notebook-heading">
        <button className="button ghost" onClick={onBack}><ArrowLeft size={16} /> 返回中转</button>
        <button className="button primary" onClick={() => void newNote()} disabled={busy}><Plus size={16} /> 新建笔记</button>
      </div>
      {error && <div className="notebook-error" role="alert">{error} <button className="button ghost" onClick={() => void loadNotes()}>刷新列表</button></div>}
      <div className="card notebook-layout">
        <aside className="notebook-list" aria-label="笔记列表">
          <div className="notebook-list-heading"><h2>记事本 <span>{notes.length}</span></h2><button className="icon-button" aria-label="刷新笔记列表" onClick={() => void loadNotes()} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : undefined} /></button></div>
          {notes.map((note) => <button key={note.id} className={`note-item ${selected?.id === note.id ? "is-selected" : ""}`} onClick={() => void openNote(note.id)} disabled={busy} aria-pressed={selected?.id === note.id}>
            <strong>{note.title}</strong><span>{note.preview || (note.attachmentCount ? `${note.attachmentCount} 张图片` : "空白笔记")}</span><small>{new Date(note.updatedAt).toLocaleDateString("zh-CN")} · {note.characters.toLocaleString()} 字符{note.attachmentCount ? ` · ${note.attachmentCount} 图` : ""}</small>
          </button>)}
          {!notes.length && <p className="notebook-list-empty">{loading ? "正在读取…" : "还没有笔记"}</p>}
        </aside>
        <div className="notebook-editor">
          {selected ? <>
            <input className="note-title" aria-label="笔记标题" placeholder="笔记标题" maxLength={120} value={draft.title} onCompositionStart={() => { composing.current = true; editRevision.current += 1; }} onCompositionEnd={() => { composing.current = false; }} onChange={(event) => changeDraft("title", event.target.value)} />
            <textarea className="note-content" aria-label="笔记内容" placeholder="写点什么，或直接粘贴图片…" value={draft.content} spellCheck={false} onPaste={onNotePaste} onCompositionStart={() => { composing.current = true; editRevision.current += 1; }} onCompositionEnd={() => { composing.current = false; }} onChange={(event) => changeDraft("content", event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void save(); } }} />
            {draft.attachments.length > 0 && <div className="note-attachments" aria-label="笔记图片">
              {draft.attachments.map((id) => {
                const file = files.find((candidate) => candidate.id === id);
                return file ? <div className="note-attachment" key={id}>
                  <button className="note-attachment-preview" type="button" onClick={() => setPreviewImage(file)} title={`放大查看 ${file.name}`} aria-label={`放大查看 ${file.name}`}>
                    <img src={`/api/files/${file.id}/thumbnail`} alt={file.name} loading="lazy" decoding="async" />
                    <span>{file.name}</span>
                  </button>
                  <button className="note-attachment-remove" onClick={() => changeDraft("attachments", draftRef.current.attachments.filter((attachment) => attachment !== id))} aria-label={`从笔记移除 ${file.name}`} title="从笔记移除，文件仍保留在中转区"><X size={13} /></button>
                </div> : <div className="note-attachment is-missing" key={id}><span>图片已从文件区删除</span><button className="note-attachment-remove" onClick={() => changeDraft("attachments", draftRef.current.attachments.filter((attachment) => attachment !== id))} aria-label="移除已删除的图片"><X size={13} /></button></div>;
              })}
            </div>}
            {confirmDelete && <div className="note-delete-confirm" role="alert"><span>删除这条笔记？剪贴板内容不受影响。</span><div><button className="button ghost" onClick={() => setConfirmDelete(false)}>取消</button><button className="button danger-ghost" onClick={() => void removeNote()} disabled={busy}>确认删除</button></div></div>}
            <div className="note-editor-footer"><span>{uploadingImages ? "图片上传并保存中…" : busy ? "处理中…" : dirty ? "未保存" : isNew ? "新笔记" : "已保存"}</span><div className="note-editor-actions">
              <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" multiple hidden onChange={onImageInput} />
              <button className="button secondary note-image-button" aria-label="导入图片" title="选择图片，也可以直接粘贴截图" onClick={() => imageInput.current?.click()} disabled={busy}>{uploadingImages ? <LoaderCircle size={15} className="spin" /> : <ImagePlus size={15} />}<span>图片</span></button>
              <button className="icon-button" aria-label="删除笔记" onClick={() => setConfirmDelete(true)} disabled={busy}><Trash2 size={15} /></button>
              <button className="button secondary" onClick={() => { void navigator.clipboard.writeText(draft.content).then(() => notify("已复制笔记"), () => notify("请手动选择文字复制", "error")); }} disabled={!draft.content}><Copy size={15} /> 复制</button>
              <button className="button primary" onClick={() => void save()} disabled={busy || !dirty}>{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />} 保存</button>
            </div></div>
          </> : <div className="empty-state notebook-empty"><BookOpen size={32} /><strong>留住值得保存的文字</strong><span>选择一条笔记，或从剪贴板存入</span></div>}
        </div>
      </div>
      {previewImage && <ImageLightbox key={previewImage.id} image={previewImage} onClose={() => setPreviewImage(null)} />}
    </section>
  );
}
