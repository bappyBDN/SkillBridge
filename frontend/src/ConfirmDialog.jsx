import { useEffect, useId, useRef } from "react";

/**
 * Keyboard-operable confirmation dialog. The native <dialog> element opened
 * with showModal() traps focus, makes the background inert and closes on
 * Escape (reported through onCancel). Focus returns to the opener on close.
 */
export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  busy = false,
  danger = false,
  onConfirm,
  onCancel,
  children,
}) {
  const ref = useRef(null);
  const opener = useRef(null);
  const titleId = useId();
  const bodyId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement;
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      opener.current?.focus?.();
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="ad-modal sb-confirm-dialog"
      aria-labelledby={titleId}
      aria-describedby={body ? bodyId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel?.();
      }}
    >
      {open && (
        <form
          method="dialog"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) onConfirm?.();
          }}
        >
          <h2 id={titleId}>{title}</h2>
          {body && <p id={bodyId}>{body}</p>}
          {children}
          <div className="ad-modal-actions">
            <button type="button" onClick={() => onCancel?.()} disabled={busy} autoFocus>
              {cancelLabel}
            </button>
            <button type="submit" className={"ad-modal-confirm" + (danger ? " danger" : "")} disabled={busy} aria-busy={busy}>
              {confirmLabel}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
