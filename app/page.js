"use client";

import { useState } from "react";
import { COLUMNS, STATUS_OPTIONS, toCSV } from "../lib/schema";

const tempClass = (t) =>
  t === "Hot Lead" ? "hot" : t === "Good Lead" ? "good" : t === "Maybe" ? "maybe" : "skip";

export default function Page() {
  const [form, setForm] = useState({
    niche: "personal trainer",
    location: "Fairfax, VA",
    maxResults: 20,
    excludedFranchises: "Orangetheory, Planet Fitness, LA Fitness, Anytime Fitness, Gold's Gym",
  });
  const [leads, setLeads] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openRow, setOpenRow] = useState(null);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function runSearch() {
    setLoading(true);
    setError("");
    setLeads([]);
    setMeta(null);
    setOpenRow(null);
    try {
      const res = await fetch("/api/prospect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          niche: form.niche,
          location: form.location,
          maxResults: Number(form.maxResults),
          excludedFranchises: form.excludedFranchises,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Search failed.");
      setLeads(data.leads || []);
      setMeta(data.meta || null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function updateLead(index, key, value) {
    setLeads((prev) => prev.map((l, i) => (i === index ? { ...l, [key]: value } : l)));
  }

  function exportCSV() {
    const csv = toCSV(leads);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `mf_leads_${form.niche.replace(/\s+/g, "_")}_${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="wrap">
      <header>
        <h1>Market Fuzion — Prospecting Command Center</h1>
        <p>Research and prepare leads. You approve. You send. Nothing auto-contacts anyone.</p>
      </header>

      <div className="panel">
        <div className="form-grid">
          <div className="field">
            <label>Niche</label>
            <input value={form.niche} onChange={(e) => set("niche", e.target.value)} placeholder="personal trainer" />
          </div>
          <div className="field">
            <label>Location</label>
            <input value={form.location} onChange={(e) => set("location", e.target.value)} placeholder="Fairfax, VA" />
          </div>
          <div className="field">
            <label>Max Results (1–40)</label>
            <input type="number" min="1" max="40" value={form.maxResults} onChange={(e) => set("maxResults", e.target.value)} />
          </div>
          <div className="field">
            <label>Excluded Franchises (comma-separated)</label>
            <input value={form.excludedFranchises} onChange={(e) => set("excludedFranchises", e.target.value)} />
          </div>
        </div>
        <div className="row">
          <button onClick={runSearch} disabled={loading}>
            {loading ? <><span className="spinner" />Researching…</> : "Research Leads"}
          </button>
          <button className="secondary" onClick={exportCSV} disabled={!leads.length}>
            Export CSV ({leads.length})
          </button>
        </div>
        {error && <div className="error">⚠ {error}</div>}
      </div>

      {meta && (
        <div className="meta">
          Found {meta.found} · removed {meta.removedFranchises} franchise{meta.removedFranchises === 1 ? "" : "s"} · analyzed {meta.analyzed}. Sorted by Fit Score. Click a row for the audit + messages.
        </div>
      )}

      {leads.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Business</th>
                <th>Location</th>
                <th>Phone</th>
                <th>Fit</th>
                <th>Temp</th>
                <th>Conf</th>
                <th>Channel</th>
                <th>Status</th>
                <th>Approved</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l, i) => (
                <FragmentRow
                  key={i}
                  lead={l}
                  index={i}
                  open={openRow === i}
                  onToggle={() => setOpenRow(openRow === i ? null : i)}
                  onUpdate={updateLead}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FragmentRow({ lead, index, open, onToggle, onUpdate }) {
  return (
    <>
      <tr className="lead-row" onClick={onToggle}>
        <td><strong>{lead["Business Name"]}</strong></td>
        <td>{lead["Location"]}</td>
        <td>{lead["Phone"]}</td>
        <td className="score">{lead["Fit Score"]}</td>
        <td><span className={`pill ${tempClass(lead["Lead Temperature"])}`}>{lead["Lead Temperature"]}</span></td>
        <td className="conf">{lead["Confidence Score"]}/5</td>
        <td>{lead["Recommended Channel"]}</td>
        <td onClick={(e) => e.stopPropagation()}>
          <select value={lead["Status"]} onChange={(e) => onUpdate(index, "Status", e.target.value)}>
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </td>
        <td onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={lead["Approved To Contact"] === "YES"}
            onChange={(e) => onUpdate(index, "Approved To Contact", e.target.checked ? "YES" : "NO")}
          />
        </td>
      </tr>
      {open && (
        <tr className="detail">
          <td colSpan={9}>
            <div className="block">
              <h4>Mini-Audit</h4>
              <div><strong>Visible CTA:</strong> {lead["Visible CTA"]}</div>
              <div><strong>Likely Lead Gap:</strong> {lead["Likely Lead Gap"]}</div>
              <div><strong>Likely Follow-Up Gap:</strong> {lead["Likely Follow-Up Gap"]}</div>
              <div><strong>Automation Opportunity:</strong> {lead["Automation Opportunity"]}</div>
              {lead["Website"] && <div><strong>Website:</strong> {lead["Website"]}</div>}
              {lead["Notes"] && <div><strong>Notes:</strong> {lead["Notes"]}</div>}
            </div>
            <div className="block">
              <h4>First Message</h4>
              <div className="msg">{lead["First Message"] || "—"}</div>
            </div>
            <div className="block">
              <h4>Follow-Up 1</h4>
              <div className="msg">{lead["Follow-Up 1"] || "—"}</div>
            </div>
            <div className="block">
              <h4>Follow-Up 2</h4>
              <div className="msg">{lead["Follow-Up 2"] || "—"}</div>
            </div>
            <div className="block">
              <h4>Close-The-Loop</h4>
              <div className="msg">{lead["Close-The-Loop Message"] || "—"}</div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
