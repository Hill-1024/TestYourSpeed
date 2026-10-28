import { useEffect, useRef } from "react";

export type CardState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; url: string; blob: Blob; name: string };

export function CardDialog({
  state,
  onSave,
  onClose,
}: {
  state: CardState;
  onSave: () => void;
  onClose: () => void;
}) {
  const close = useRef(onClose);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    box.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="卡片预览"
        tabIndex={-1}
        ref={box}
      >
        <div className="dialog-head">
          <p>卡片预览</p>
          <button type="button" className="dialog-close" aria-label="关闭预览" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="dialog-body">
          {state.status === "loading" && <p className="quiet">正在生成卡片…</p>}
          {state.status === "error" && <p className="fail">{state.message}</p>}
          {state.status === "ready" && <img src={state.url} alt="这次测速的卡片" />}
        </div>
        <div className="dialog-foot">
          <button type="button" onClick={onClose}>
            关闭
          </button>
          <button type="button" className="primary" disabled={state.status !== "ready"} onClick={onSave}>
            保存图片
          </button>
        </div>
      </div>
    </div>
  );
}
