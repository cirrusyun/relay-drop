import { LoaderCircle, X, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface PreviewImage {
  id: string;
  name: string;
}

interface Props {
  image: PreviewImage;
  onClose(): void;
}

export function ImageLightbox({ image, onClose }: Props) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [zoomed, setZoomed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const closeButton = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", closeOnEscape);
    closeButton.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return <div className={`image-lightbox ${zoomed ? "is-zoomed" : ""}`} role="dialog" aria-modal="true" aria-label={`查看原图 ${image.name}`} onClick={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <div className="image-lightbox-actions">
      <button type="button" onClick={() => setZoomed((value) => !value)} aria-label={zoomed ? "适应窗口" : "查看原始尺寸"} title={zoomed ? "适应窗口" : "查看原始尺寸"} disabled={status !== "ready"}>{zoomed ? <ZoomOut size={19} /> : <ZoomIn size={19} />}</button>
      <button ref={closeButton} type="button" onClick={onClose} aria-label="关闭原图预览" title="关闭"><X size={20} /></button>
    </div>
    <div className="image-lightbox-content">
      {status === "loading" && <div className="image-lightbox-state" role="status"><LoaderCircle size={22} className="spin" /><span>正在读取原图…</span></div>}
      {status === "error" && <div className="image-lightbox-state" role="alert"><span>原图加载失败</span><button type="button" onClick={() => { setStatus("loading"); setAttempt((value) => value + 1); }}>重试</button></div>}
      <img className={status === "ready" ? "is-ready" : ""} src={`/api/files/${image.id}/preview?attempt=${attempt}`} alt={image.name} onLoad={() => setStatus("ready")} onError={() => setStatus("error")} onClick={() => { if (status === "ready") setZoomed((value) => !value); }} title={zoomed ? "点击适应窗口" : "点击查看原始尺寸"} />
      <span>{image.name}</span>
    </div>
  </div>;
}
