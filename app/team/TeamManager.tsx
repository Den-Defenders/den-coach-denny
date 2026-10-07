"use client";

import { useEffect, useMemo, useState } from "react";

type Role = "owner" | "csr" | "sales_rep" | "installer";

type Member = {
  email: string;
  displayName: string;
  role: Role;
  stTechnicianId: number | null;
  stTechnicianName: string | null;
  timeZone: string;
  active: boolean;
  updatedAt: string;
  updatedBy: string;
};

type Technician = {
  technicianId: number;
  name: string;
  positions: string[];
  team: string | null;
  email: string | null;
};

const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  csr: "CSR",
  sales_rep: "Sales rep",
  installer: "Installer",
};

const TIME_ZONES = [
  ["America/Los_Angeles", "Pacific (CA, NV, WA, OR)"],
  ["America/Phoenix", "Arizona"],
  ["America/Denver", "Mountain"],
  ["America/Chicago", "Central (TX)"],
] as const;

const EMPTY_FORM = {
  email: "",
  displayName: "",
  role: "installer" as Role,
  stTechnicianId: "",
  timeZone: "America/Los_Angeles",
  active: true,
};

function timeZoneLabel(zone: string) {
  return TIME_ZONES.find(([value]) => value === zone)?.[1] ?? zone;
}

export default function TeamManager() {
  const [members, setMembers] = useState<Member[]>([]);
  const [roster, setRoster] = useState<Technician[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState("Loading team…");
  const [rosterStatus, setRosterStatus] = useState("Loading ServiceTitan roster…");
  const [saving, setSaving] = useState(false);

  async function loadMembers() {
    const response = await fetch("/api/team", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setStatus(data.error || "Could not load the team.");
      return;
    }
    setMembers(data.members || []);
    setStatus("");
  }

  useEffect(() => {
    // Initial load of the team list and the ServiceTitan roster.
    loadMembers();
    fetch("/api/team/roster", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Could not load the roster.");
        setRoster(data.technicians || []);
        setRosterStatus("");
      })
      .catch((error: unknown) => setRosterStatus(error instanceof Error ? error.message : "Could not load the roster."));
  }, []);

  const needsTechnician = form.role === "sales_rep" || form.role === "installer";
  const selectedTech = useMemo(
    () => roster.find((tech) => String(tech.technicianId) === form.stTechnicianId) || null,
    [roster, form.stTechnicianId]
  );

  function pickTechnician(value: string) {
    const tech = roster.find((candidate) => String(candidate.technicianId) === value);
    setForm((current) => ({
      ...current,
      stTechnicianId: value,
      displayName: current.displayName || tech?.name || "",
      email: current.email || tech?.email || "",
      role: !editing && tech && current.role === "installer" && tech.positions.includes("Sales") && !tech.positions.includes("Installer")
        ? "sales_rep"
        : current.role,
    }));
  }

  function typeEmail(value: string) {
    setForm((current) => {
      const match = roster.find((tech) => tech.email && tech.email === value.trim().toLowerCase());
      return {
        ...current,
        email: value,
        stTechnicianId: current.stTechnicianId || (match ? String(match.technicianId) : ""),
        displayName: current.displayName || match?.name || "",
      };
    });
  }

  function editMember(member: Member) {
    setEditing(true);
    setForm({
      email: member.email,
      displayName: member.displayName,
      role: member.role,
      stTechnicianId: member.stTechnicianId ? String(member.stTechnicianId) : "",
      timeZone: member.timeZone,
      active: member.active,
    });
    setStatus("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function resetForm() {
    setEditing(false);
    setForm(EMPTY_FORM);
  }

  async function save(overrides?: Partial<typeof form>, technicianName?: string | null) {
    const payload = { ...form, ...overrides };
    setSaving(true);
    setStatus("Saving…");
    try {
      const response = await fetch("/api/team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          stTechnicianId: payload.stTechnicianId ? Number(payload.stTechnicianId) : null,
          stTechnicianName: technicianName !== undefined ? technicianName : selectedTech?.name ?? null,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setStatus(data.error || "Could not save.");
        return;
      }
      setStatus(`Saved ${data.member.displayName}. Changes apply within about 30 seconds.`);
      resetForm();
      await loadMembers();
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(member: Member) {
    await save({
      email: member.email,
      displayName: member.displayName,
      role: member.role,
      stTechnicianId: member.stTechnicianId ? String(member.stTechnicianId) : "",
      timeZone: member.timeZone,
      active: !member.active,
    }, member.stTechnicianName);
  }

  return (
    <div className="team-page">
      <section className="owner-hero">
        <div>
          <p className="eyebrow">Owner tools</p>
          <h1>Den Coach Denny team</h1>
          <p>Add installers, sales reps, CSRs and owners. People sign in with their Auth0 login; this list decides what they see.</p>
        </div>
      </section>

      <section className="surface team-form">
        <h2>{editing ? "Edit team member" : "Add a team member"}</h2>
        <div className="team-grid">
          <label>
            <span>ServiceTitan technician {needsTechnician ? "(required)" : "(optional)"}</span>
            <select value={form.stTechnicianId} onChange={(event) => pickTechnician(event.target.value)}>
              <option value="">{rosterStatus || "— Not linked —"}</option>
              {roster.map((tech) => (
                <option key={tech.technicianId} value={tech.technicianId}>
                  {tech.name}{tech.positions.length ? ` · ${tech.positions.join(", ")}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Login email (their Auth0 email)</span>
            <input type="email" value={form.email} disabled={editing} onChange={(event) => typeEmail(event.target.value)} placeholder="name@dendefenders.com" />
          </label>
          <label>
            <span>Name Denny will use</span>
            <input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="Juan" />
          </label>
          <label>
            <span>Role</span>
            <select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as Role })}>
              {(Object.keys(ROLE_LABELS) as Role[]).map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
            </select>
          </label>
          <label>
            <span>Time zone for their schedule</span>
            <select value={form.timeZone} onChange={(event) => setForm({ ...form, timeZone: event.target.value })}>
              {TIME_ZONES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="team-check">
            <input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} />
            <span>Access turned on</span>
          </label>
        </div>
        <p className="team-hint">
          {form.role === "owner" && "Owners see everything, including this page and the Owner Dashboard."}
          {form.role === "csr" && "CSRs see Chat, Let Denny Listen and the Smart Scheduler."}
          {needsTechnician && "Sales reps and installers see the Smart Scheduler and Talk with Coach Denny. \"My schedule\" uses the ServiceTitan technician picked above."}
        </p>
        <div className="hero-actions">
          <button className="btn btn-teal" disabled={saving} onClick={() => save()}>{editing ? "Save changes" : "Add to team"}</button>
          {editing && <button className="btn btn-outline" disabled={saving} onClick={resetForm}>Cancel</button>}
        </div>
        {status && <div className="notice" style={{ marginTop: 12 }}>{status}</div>}
      </section>

      <section className="surface team-list">
        <h2>Team list</h2>
        {members.length === 0 ? (
          <p className="team-hint">No one has been added yet. Signed-in people who are not on this list are treated as CSRs.</p>
        ) : (
          <div className="owner-table-wrap">
            <table className="team-table">
              <thead>
                <tr><th>Name</th><th>Email</th><th>Role</th><th>ServiceTitan</th><th>Time zone</th><th>Access</th><th /></tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.email} className={member.active ? "" : "team-inactive"}>
                    <td>{member.displayName}</td>
                    <td>{member.email}</td>
                    <td>{ROLE_LABELS[member.role]}</td>
                    <td>{member.stTechnicianName || (member.stTechnicianId ? `#${member.stTechnicianId}` : "—")}</td>
                    <td>{timeZoneLabel(member.timeZone)}</td>
                    <td>{member.active ? "On" : "Off"}</td>
                    <td className="team-actions">
                      <button className="team-link" onClick={() => editMember(member)}>Edit</button>
                      <button className="team-link" disabled={saving} onClick={() => toggleActive(member)}>{member.active ? "Turn off" : "Turn on"}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
