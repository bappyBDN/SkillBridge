import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "./api.js";
import { useT, useLangValue } from "./i18n.js";
import { WorkspaceIcon } from "./WorkspaceUI.jsx";
import {
  markServerItemsRead,
  normalizeServerNotifications,
  sectionForNotificationLink,
  unreadServerIds,
} from "./notifications.js";

const POLL_MS = 60000;
const examLive = () => typeof document !== "undefined" && document.body.classList.contains("exam-live");

/**
 * Server notification center for every role. Polls /api/notifications every
 * 60 s while the tab is visible and no exam is live, and refreshes when the
 * tab comes back. A 404/501 (endpoint not deployed yet) turns polling off and
 * reports status "unavailable" so the bell still works for local items.
 */
export function useServerNotifications({ enabled = true } = {}) {
  const [state, setState] = useState({ items: [], unread: 0 });
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const statusRef = useRef("idle");
  const inFlight = useRef(false);
  const setStatusBoth = (value) => { statusRef.current = value; setStatus(value); };

  const load = useCallback(async () => {
    if (!enabled || inFlight.current || statusRef.current === "unavailable" || examLive()) return;
    inFlight.current = true;
    if (statusRef.current === "idle") setStatusBoth("loading");
    try {
      const payload = await api("/notifications?limit=50");
      setState(normalizeServerNotifications(payload));
      setError(null);
      setStatusBoth("ready");
    } catch (e) {
      if (e?.status === 404 || e?.status === 501) {
        setStatusBoth("unavailable");
      } else {
        setError(e);
        setStatusBoth("error");
      }
    } finally {
      inFlight.current = false;
    }
  }, [enabled]);

  const markRead = useCallback(async (ids) => {
    const list = (ids || []).filter(Boolean);
    if (!list.length || statusRef.current === "unavailable") return;
    setState((current) => markServerItemsRead(current, list));
    try {
      const res = await api("/notifications/read", { method: "POST", body: { ids: list } });
      if (Number.isFinite(Number(res?.unread))) setState((current) => ({ ...current, unread: Math.max(0, Number(res.unread)) }));
    } catch (e) {
      if (e?.status === 404 || e?.status === 501) return;
      setError(e);
      load();
    }
  }, [load]);

  useEffect(() => {
    if (!enabled) return undefined;
    load();
    const tick = () => {
      if (document.visibilityState === "hidden" || examLive()) return;
      load();
    };
    const timer = setInterval(tick, POLL_MS);
    const onVisibility = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, load]);

  return { items: state.items, unread: state.unread, status, error, load, markRead };
}

export function formatNotificationTime(seconds, lang = "en") {
  if (!seconds) return "";
  try {
    return new Date(Number(seconds) * 1000).toLocaleString(lang === "bn" ? "bn-BD" : undefined);
  } catch {
    return "";
  }
}

/** One server notification row. Clicking navigates to its section, if any. */
export function ServerNotificationItem({ item, unread = false, onOpen }) {
  const lang = useLangValue();
  const t = useT();
  const content = (
    <>
      <div className="assessment-notification-meta">
        <strong>{item.title || t("notificationUntitled")}</strong>
        {unread && <span className="status-pill status-review">{t("notificationNew")}</span>}
        <small>{formatNotificationTime(item.created, lang)}</small>
      </div>
      {item.body && <p>{item.body}</p>}
    </>
  );
  return (
    <article className={"assessment-notification-item server-notification-item" + (unread ? " is-unread" : "")} data-notification-id={item.id}>
      {onOpen ? (
        <button type="button" className="server-notification-link" onClick={() => onOpen(item)}>
          {content}
        </button>
      ) : content}
    </article>
  );
}

/**
 * Bell + panel showing server notifications only (company and admin
 * workspaces). Opening the panel marks the visible unread items read.
 */
export function NotificationBell({ workspace, availableSections, onNavigate, buttonClassName = "cr-icon-btn" }) {
  const t = useT();
  const center = useServerNotifications();
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(() => new Set());
  const panelId = useId();
  const countId = useId();
  const wrapper = useRef(null);
  const button = useRef(null);
  const { items, unread, status, error, markRead } = center;
  const unreadIds = unreadServerIds(items).join("|");
  useEffect(() => {
    if (!open || !unreadIds) return;
    const ids = unreadIds.split("|");
    setHighlight((old) => new Set([...old, ...ids]));
    markRead(ids);
  }, [open, unreadIds, markRead]);
  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    setHighlight(new Set());
    if (restoreFocus) button.current?.focus();
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === "Escape") close(); };
    const onClick = (event) => { if (wrapper.current && !wrapper.current.contains(event.target)) close(false); };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open, close]);
  const label = t("notificationsTitle");
  const openItem = (item) => {
    const section = sectionForNotificationLink(item.link, workspace, availableSections);
    if (section) {
      onNavigate?.(section);
      close(false);
    }
  };
  return (
    <div className="sb-bell" ref={wrapper}>
      <button
        ref={button}
        type="button"
        className={buttonClassName + " sb-bell-btn"}
        title={unread ? `${label} (${unread})` : label}
        aria-label={label}
        aria-describedby={unread ? countId : undefined}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          if (open) { close(); return; }
          setOpen(true);
          center.load();
        }}
      >
        <WorkspaceIcon name="bell" size={18} />
        {unread ? <span className="sb-bell-badge" aria-hidden="true">{unread > 99 ? "99+" : unread}</span> : null}
      </button>
      <span id={countId} className="sb-sr-only" aria-live="polite">{unread ? `${unread} ${t("notificationsUnread")}` : ""}</span>
      {open && (
        <section className="sb-bell-panel portal-panel" id={panelId} aria-label={label}>
          <div className="panel-heading">
            <h2>{label}</h2>
            <button type="button" className="cr-outline-btn" onClick={() => close()}>{t("close")}</button>
          </div>
          <div aria-live="polite">
            {status === "loading" && !items.length && <p className="assessment-notification-empty">{t("loading")}</p>}
            {status === "error" && (
              <p className="err" role="alert">
                {t("notificationsLoadFailed")}{" "}
                <button type="button" className="cr-text-btn" onClick={center.load}>{t("retry")}</button>
                {error?.code ? <small className="muted"> ({error.code})</small> : null}
              </p>
            )}
            {status === "unavailable" && <p className="assessment-notification-empty">{t("notificationsUnavailable")}</p>}
            {status === "ready" && !items.length && <p className="assessment-notification-empty">{t("notificationsEmpty")}</p>}
          </div>
          {items.length > 0 && (
            <div className="assessment-notification-panel">
              {items.map((item) => (
                <ServerNotificationItem
                  key={item.id}
                  item={item}
                  unread={highlight.has(item.id) || !item.read_at}
                  onOpen={sectionForNotificationLink(item.link, workspace, availableSections) ? openItem : undefined}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
