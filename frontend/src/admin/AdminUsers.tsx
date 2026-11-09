import { useEffect, useState } from "react";
import { getAdminUsers, updateAdminUser } from "../api";
import { useAuth } from "../auth";
import type { AdminUser } from "../types";

function AccessIcon({ disabled }: { disabled: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="5" y="10" width="14" height="11" rx="2" />
    {disabled
      ? <path d="M8 10V7a4 4 0 0 1 7.4-2" />
      : <path d="M8 10V7a4 4 0 0 1 8 0v3" />}
  </svg>;
}

export default function AdminUsers() {
  const { user } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingEmail, setSavingEmail] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    getAdminUsers()
      .then(setUsers)
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, []);

  async function toggleAccess(accessUser: AdminUser) {
    const disabling = !accessUser.is_disabled;
    if (disabling && !window.confirm(`Disable access for ${accessUser.emailid}?`)) return;
    setSavingEmail(accessUser.emailid);
    setError("");
    setNotice("");
    try {
      const saved = await updateAdminUser(accessUser.emailid, { is_disabled: disabling });
      setUsers((current) => current.map((item) => item.emailid === saved.emailid ? saved : item));
      setNotice(disabling ? "Access disabled." : "Access enabled.");
      if (saved.emailid === user.email && saved.is_disabled) window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update access.");
    } finally {
      setSavingEmail(null);
    }
  }

  return <section className="content-page admin-users-page">
    <header className="content-page-header"><div><p className="eyebrow">ACCESS MANAGEMENT</p><h1>Admin users</h1><p>Review users and control access to AI Harness.</p></div></header>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {notice && <div className="admin-notice" role="status">{notice}</div>}
    {loading ? <div className="analytics-state"><p>Loading users...</p></div> : <div className="admin-table-wrap"><table className="admin-users-table"><thead><tr><th>Email ID</th><th>First name</th><th>Last name</th><th>Admin</th><th>Status</th><th><span className="sr-only">Access</span></th></tr></thead><tbody>{users.map((accessUser) => <tr key={accessUser.emailid}><td data-label="Email ID">{accessUser.emailid}</td><td data-label="First name">{accessUser.firstname}</td><td data-label="Last name">{accessUser.last_name || "-"}</td><td data-label="Admin"><span className={`status-pill ${accessUser.is_admin ? "available" : ""}`}>{accessUser.is_admin ? "Yes" : "No"}</span></td><td data-label="Status"><span className={`status-pill ${accessUser.is_disabled ? "unavailable" : "available"}`}>{accessUser.is_disabled ? "Disabled" : "Enabled"}</span></td><td data-label="Access"><div className="admin-row-actions"><button type="button" className={accessUser.is_disabled ? "enable" : "danger"} disabled={savingEmail !== null} onClick={() => void toggleAccess(accessUser)} aria-label={`${accessUser.is_disabled ? "Enable" : "Disable"} ${accessUser.emailid}`} title={accessUser.is_disabled ? "Enable access" : "Disable access"}><AccessIcon disabled={accessUser.is_disabled} /></button></div></td></tr>)}</tbody></table></div>}
  </section>;
}
