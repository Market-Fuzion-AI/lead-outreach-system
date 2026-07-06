"use client";

import { useEffect, useState } from "react";
import { STATUS_OPTIONS, toCSV } from "../lib/schema";

const tempClass = (t) =>
  t === "Hot Lead" ? "hot" : t === "Good Lead" ? "good" : t === "Maybe" ? "maybe" : "skip";

const trustClass = (t) =>
  t === "High" ? "high" : t === "Medium" ? "medium" : "low";

// Ensure a URL is clickable; show a friendly host label.
const extUrl = (u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);
const hostOf = (u) => {
  try { return new URL(extUrl(u)).hostname.replace(/^www\./, ""); }
  catch { return u; }
};

function Badge({ kind, children }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

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
  const [theme, setTheme] = useState("light");

  // Reflect the theme chosen by the pre-paint script (layout.js).
  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    setTheme(current);
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("mf-theme", next); } catch {}
  }

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
      <div className="topbar">
        <div className="brand">
          <h1>Market Fuzion — Prospecting Command Center</h1>
          <p>Research and prepare leads. You approve. You send. Nothing auto-contacts anyone.</p>
        </div>
        <button className="theme-btn" onClick={toggleTheme} aria-label="Toggle color theme">
          {theme === "dark" ? "☀︎ Light" : "☾ Dark"}
        </button>
      </div>

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
          Found {meta.found} · removed {meta.removedFranchises} franchise{meta.removedFranchises === 1 ? "" : "s"} · analyzed {meta.analyzed}. Sorted by Fit Score. Click a row for the evidence drawer.
        </div>
      )}

      {leads.length > 0 && (
        <>
          <div className="legend">
            <span className="legend-item"><span className="legend-dot" style={{ background: "var(--verified)" }} /> Verified from Serper</span>
            <span className="legend-item"><span className="legend-dot" style={{ background: "var(--social)" }} /> Possible social match</span>
            <span className="legend-item"><span className="legend-dot" style={{ background: "var(--ai)" }} /> AI-generated — human review required</span>
          </div>

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
        </>
      )}
    </div>
  );
}

function FragmentRow({ lead, index, open, onToggle, onUpdate }) {
  return (
    <>
      <tr className={`lead-row${open ? " is-open" : ""}`} onClick={onToggle}>
        <td>
          <div className="biz-cell">
            <span className="biz-name">{lead["Business Name"]}</span>
            <span className={`trust-chip ${trustClass(lead["Trust Level"])}`}>{lead["Trust Level"]} trust</span>
          </div>
        </td>
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
            <EvidenceDrawer lead={lead} />
          </td>
        </tr>
      )}
    </>
  );
}

function SocialRow({ label, url, match }) {
  if (!url) {
    return (
      <li className="ev-row">
        <span className="ev-label">{label}</span>
        <span className="ev-none">No confident match found</span>
      </li>
    );
  }
  const shared = match && Array.isArray(match.shared) ? match.shared : [];
  const strong = match && match.strength === "strong";
  return (
    <li className="ev-row">
      <span className="ev-label">{label}</span>
      <a className="ev-link" href={extUrl(url)} target="_blank" rel="noreferrer">{hostOf(url)}</a>
      <Badge kind="social">{strong ? "Strong possible match" : "Possible match"}</Badge>
      {shared.length > 0 && <span className="ev-reason">shared terms: {shared.join(", ")}</span>}
    </li>
  );
}

function EvidenceDrawer({ lead }) {
  const website = lead["Website"];
  const breakdown = Array.isArray(lead.scoreBreakdown) ? lead.scoreBreakdown : [];

  return (
    <div className="drawer">
      {/* Scoring strip — clearly AI / directional */}
      <div className="scorestrip">
        <div className="col">
          <span className="lbl">Fit Score</span>
          <span className="big">{lead["Fit Score"]}</span>
        </div>
        <div className="col">
          <span className="lbl">Temperature</span>
          <span className={`pill ${tempClass(lead["Lead Temperature"])}`}>{lead["Lead Temperature"]}</span>
        </div>
        <div className="col">
          <span className="lbl">Confidence</span>
          <span className="big" style={{ fontSize: 18 }}>{lead["Confidence Score"]}/5</span>
        </div>
        <div className="spacer" />
        <Badge kind="ai">AI-generated recommendation</Badge>
      </div>
      <div className="conf-exp">{lead["Confidence Explanation"]}</div>

      {/* 1. Business Snapshot */}
      <section className="sec">
        <div className="sec-head">
          <h4>Business Snapshot</h4>
          <Badge kind="verified">Verified from Serper</Badge>
        </div>
        <div className="snapshot">
          <div className="snap-item"><span className="k">Category</span>{lead.category || "—"}</div>
          <div className="snap-item"><span className="k">Location</span>{lead["Location"] || "—"}</div>
          <div className="snap-item"><span className="k">Phone</span>{lead["Phone"] || "—"}</div>
          <div className="snap-item">
            <span className="k">Website</span>
            {website ? <a href={extUrl(website)} target="_blank" rel="noreferrer">{hostOf(website)}</a> : "—"}
          </div>
          <div className="snap-item">
            <span className="k">Google Rating</span>
            {lead.rating !== "" && lead.rating != null
              ? `${lead.rating}★${lead.reviews !== "" && lead.reviews != null ? ` · ${lead.reviews} reviews` : ""}`
              : "—"}
          </div>
        </div>
      </section>

      {/* 2. Evidence Found */}
      <section className="sec">
        <div className="sec-head">
          <h4>Evidence Found</h4>
          <Badge kind="social">Matched social profile</Badge>
        </div>
        <ul className="evidence">
          <li className="ev-row"><span className="ev-label">Verified</span>{lead["Evidence Summary"]}</li>
          <SocialRow label="Instagram" url={lead["Instagram"]} match={lead.igMatch} />
          <SocialRow label="Facebook" url={lead["Facebook"]} match={lead.fbMatch} />
        </ul>
      </section>

      {/* Why this score */}
      <section className="sec">
        <div className="sec-head">
          <h4>Why This Score</h4>
          <Badge kind="ai">AI / directional</Badge>
        </div>
        <div className="score-why">{lead.scoreWhy}</div>
        <div className="bars">
          {breakdown.map((b) => (
            <div className="bar-row" key={b.label}>
              <span className="bar-label">{b.label}</span>
              <span className="bar-track"><span className="bar-fill" style={{ width: `${b.max ? (b.score / b.max) * 100 : 0}%` }} /></span>
              <span className="bar-val">{b.score}/{b.max}</span>
            </div>
          ))}
        </div>
      </section>

      {/* 3. Marketing Gap Hypothesis */}
      <section className="sec">
        <div className="sec-head">
          <h4>Marketing Gap Hypothesis</h4>
          <Badge kind="ai">AI-generated recommendation</Badge>
        </div>
        <div className="field-line"><span className="k">Visible CTA: </span>{lead["Visible CTA"]}</div>
        <div className="field-line"><span className="k">Likely Lead Gap: </span>{lead["Likely Lead Gap"]}</div>
        <div className="field-line"><span className="k">Likely Follow-Up Gap: </span>{lead["Likely Follow-Up Gap"]}</div>
      </section>

      {/* 4. Automation Opportunity */}
      <section className="sec">
        <div className="sec-head">
          <h4>Automation Opportunity</h4>
          <Badge kind="ai">AI-generated recommendation</Badge>
        </div>
        <div className="field-line">{lead["Automation Opportunity"]}</div>
      </section>

      {/* 5. Outreach Angle */}
      <section className="sec">
        <div className="sec-head">
          <h4>Outreach Angle</h4>
          <Badge kind="ai">AI-generated recommendation</Badge>
        </div>
        <div className="field-line"><span className="k">Recommended Channel: </span>{lead["Recommended Channel"]}</div>
        {lead["Notes"] && <div className="field-line"><span className="k">Notes: </span>{lead["Notes"]}</div>}
      </section>

      {/* 6. Message Drafts */}
      <section className="sec">
        <div className="sec-head">
          <h4>Message Drafts</h4>
          <Badge kind="review">Human review required</Badge>
        </div>
        <div className="msg-title">First Message</div>
        <div className="msg">{lead["First Message"] || "—"}</div>
        <div className="msg-title">Follow-Up 1</div>
        <div className="msg">{lead["Follow-Up 1"] || "—"}</div>
        <div className="msg-title">Follow-Up 2</div>
        <div className="msg">{lead["Follow-Up 2"] || "—"}</div>
        <div className="msg-title">Close-The-Loop</div>
        <div className="msg">{lead["Close-The-Loop Message"] || "—"}</div>
        <div className="ai-note">These drafts are AI-generated suggestions. Review and edit before any manual outreach — nothing is sent automatically.</div>
      </section>
    </div>
  );
}
