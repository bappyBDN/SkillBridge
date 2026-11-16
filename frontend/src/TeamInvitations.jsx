import { useEffect, useState } from "react";
import { api } from "./api.js";
import { WorkspaceIcon, WorkspaceLoading } from "./WorkspaceUI.jsx";

export default function TeamInvitations({ onJoined }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api("/company/invitations", { signal: controller.signal }).then((data) => setItems(data.items || []))
      .catch((e) => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  const accept = async (invitation) => {
    setBusy(invitation.id);
    setError("");
    try {
      await api("/company/team/accept/" + encodeURIComponent(invitation.invite_token), { method: "POST" });
      await onJoined();
    } catch (e) { setError(e.message || "Could not accept the invitation."); }
    finally { setBusy(""); }
  };
  return <section className="ws-invitation-inbox" aria-label="Your team invitations">
    <div className="panel-heading"><div><h2>Invited to a team?</h2><p>Join with the email address your colleague invited. You don’t need to create a company.</p></div><button type="button" className="cr-icon-btn" aria-label="Refresh invitations" onClick={() => setRevision((value) => value + 1)} disabled={loading || Boolean(busy)}><WorkspaceIcon name="refresh" size={17} /></button></div>
    {loading && <WorkspaceLoading label="Checking your invitations…" />}
    {error && <p className="err" role="alert">{error}</p>}
    {!loading && !error && !items.length && <p className="ws-invitation-empty">No pending invitations for this account. Ask your workspace owner to invite your sign-in email.</p>}
    {items.map((item) => <div className="ws-invitation" key={item.id}><span className="cr-person-avatar"><WorkspaceIcon name="team" /></span><div><strong>{item.company_name}</strong><small>{item.company_role.replaceAll("_", " ")}</small></div><button type="button" className="cr-primary" onClick={() => accept(item)} disabled={Boolean(busy)}>{busy === item.id ? "Joining…" : "Join team"}</button></div>)}
  </section>;
}
