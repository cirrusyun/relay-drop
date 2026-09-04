import { Check, Copy, LoaderCircle, RotateCcw, ScanText, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

export interface PreviewImage {
  id: string;
  name: string;
}

interface Props {
  image: PreviewImage;
  initialOcrText?: string;
  onRecognized?(text: string): void;
  onClose(): void;
}

type OcrStatus = "loading" | "ready" | "empty" | "error";

export function ImageLightbox({ image, initialOcrText, onRecognized, onClose }: Props) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [zoomed, setZoomed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [ocrAttempt, setOcrAttempt] = useState(0);
  const [ocrStatus, setOcrStatus] = useState<OcrStatus>(initialOcrText === undefined ? "loading" : initialOcrText ? "ready" : "empty");
  const [ocrText, setOcrText] = useState(initialOcrText ?? "");
  const [ocrError, setOcrError] = useState("");
  const [copied, setCopied] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const copyTimer = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);
  const onRecognizedRef = useRef(onRecognized);
  onCloseRef.current = onClose;
  onRecognizedRef.current = onRecognized;

  const retryOcr = useCallback(() => setOcrAttempt((value) => value + 1), []);

  useEffect(() => {
    if (ocrAttempt === 0 && initialOcrText !== undefined) return;
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 35_000);
    setOcrStatus("loading");
    setOcrError("");
    setCopied(false);
    void api<{ text: string }>(`/api/files/${image.id}/ocr`, { method: "POST", signal: controller.signal })
      .then((result) => {
        if (!active) return;
        const text = result.text.trim();
        setOcrText(text);
        setOcrStatus(text ? "ready" : "empty");
        onRecognizedRef.current?.(text);
      })
      .catch((cause: Error) => {
        if (!active) return;
        setOcrError(controller.signal.aborted ? "文字识别超时，请稍后重试。" : cause.message || "文字识别失败，请稍后重试。");
        setOcrStatus("error");
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [image.id, initialOcrText, ocrAttempt]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", closeOnEscape);
    closeButton.current?.focus();
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(ocrText);
      setOcrError("");
      setCopied(true);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setOcrError("无法自动复制，请直接选中文字后复制。");
    }
  };

  return <div className={`image-lightbox ${zoomed ? "is-zoomed" : ""}`} role="dialog" aria-modal="true" aria-label={`查看原图 ${image.name}`} onClick={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <div className="image-lightbox-actions">
      <button type="button" onClick={() => setZoomed((value) => !value)} aria-label={zoomed ? "适应窗口" : "查看原始尺寸"} title={zoomed ? "适应窗口" : "查看原始尺寸"} disabled={status !== "ready"}>{zoomed ? <ZoomOut size={19} /> : <ZoomIn size={19} />}</button>
      <button ref={closeButton} type="button" onClick={onClose} aria-label="关闭原图预览" title="关闭"><X size={20} /></button>
    </div>
    <div className="image-lightbox-shell">
      <div className="image-lightbox-content">
        {status === "loading" && <div className="image-lightbox-state" role="status"><LoaderCircle size={22} className="spin" /><span>正在读取原图…</span></div>}
        {status === "error" && <div className="image-lightbox-state" role="alert"><span>原图加载失败</span><button type="button" onClick={() => { setStatus("loading"); setAttempt((value) => value + 1); }}>重试</button></div>}
        <img className={status === "ready" ? "is-ready" : ""} src={`/api/files/${image.id}/preview?attempt=${attempt}`} alt={image.name} onLoad={() => setStatus("ready")} onError={() => setStatus("error")} onClick={() => { if (status === "ready") setZoomed((value) => !value); }} title={zoomed ? "点击适应窗口" : "点击查看原始尺寸"} />
      </div>
      <aside className="image-ocr-panel" aria-label="图片识别文字">
        <div className="image-ocr-heading">
          <strong><ScanText size={16} /> 识别文字</strong>
          <div>
            <button type="button" onClick={retryOcr} disabled={ocrStatus === "loading"} aria-label="重新识别图片文字" title="重新识别"><RotateCcw size={15} /></button>
            <button type="button" onClick={() => void copyText()} disabled={ocrStatus !== "ready"} aria-label="复制图片识别文字" title="复制文字">{copied ? <Check size={15} /> : <Copy size={15} />}</button>
          </div>
        </div>
        {ocrStatus === "loading" && <div className="image-ocr-state" role="status"><LoaderCircle size={17} className="spin" /><span>正在识别中英文…</span></div>}
        {ocrStatus === "empty" && <div className="image-ocr-state"><span>没有识别到清晰文字</span><button type="button" onClick={retryOcr}>再试一次</button></div>}
        {ocrStatus === "error" && <div className="image-ocr-state" role="alert"><span>{ocrError}</span><button type="button" onClick={retryOcr}>重试</button></div>}
        {ocrStatus === "ready" && <textarea className="image-ocr-text" aria-label="可选择的图片识别文字" readOnly spellCheck={false} value={ocrText} />}
        {ocrStatus === "ready" && <small>{ocrError || (copied ? "已复制" : "可以直接框选文字，或点击复制")}</small>}
      </aside>
    </div>
  </div>;
}
