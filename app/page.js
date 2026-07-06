"use client";

import { useEffect, useState } from "react";
import { STATUS_OPTIONS, toCSV } from "../lib/schema";

const PRESETS = [
  "Fitness", "Med Spa / Aesthetics", "Dental", "Chiropractic", "Roofing",
  "HVAC / Plumbing / Electrical", "Legal", "Real Estate", "Coaching",
  "Restaurants", "Auto Detailing", "Home Services", "Beauty / Salon",
  "Wellness", "Photography", "Custom",
];

const tempClass = (t) =>
  t === "Hot Lead" ? "hot" : t === "Good Lead" ? "good" : t === "Maybe" ? "maybe" : "skip";

const trustClass = (t) =>
  t === "High" ? "high" : t === "Medium" ? "medium" : "low";

const extUrl = (u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);
const hostOf = (u) => {
  try { return new URL(extUrl(u)).hostname.replace(/^www\./, ""); }
  catch { return u; }
};

const confLabel = (c) =>
  c === "high" ? "High confidence" : c === "medium" ? "Possible match" : "Weak match — verify manually";
const confKind = (c) =>
  c === "high" ? "verified" : c === "medium" ? "social" : "review";

function Badge({ kind, children }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

export default function Page() {
  const [form, setForm] = useState({
    categoryPreset: "Fitness",
    customCategory: "",
    keywords: "yoga studio, pilates, personal training",
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
  const effectiveCategory = form.categoryPreset === "Custom" ? form.customCategory : form.categoryPreset;

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
          category: effectiveCategory,
          keywords: form.keywords,
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
    a.download = `mf_leads_${(effectiveCategory || "leads").replace(/\s+/g, "_")}_${stamp}.csv`;
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
            <label>Business Category / Niche</label>
            <select value={form.categoryPreset} onChange={(e) => set("categoryPreset", e.target.value)}>
              {PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          {form.categoryPreset === "Custom" && (
            <div className="field">
              <label>Custom Category</label>
              <input value={form.customCategory} onChange={(e) => set("customCategory", e.target.value)} placeholder="e.g. Pet Grooming" />
            </div>
          )}
          <div className="field full">
            <label>Specific Keywords (comma-separated)</label>
            <input value={form.keywords} onChange={(e) => set("keywords", e.target.value)} placeholder="yoga studio, pilates, personal training" />
            <div className="helper">Use Category for broad market, Keywords for specific business type. Example — Category: Fitness · Keywords: yoga studio, pilates, personal training.</div>
          </div>
          <div className="field">
            <label>Location</label>
            <input value={form.location} onChange={(e) => set("location", e.target.value)} placeholder="Fairfax, VA" />
          </div>
          <div className="field">
            <label>Max Results (1–40)</label>
            <input type="number" min="1" max="40" value={form.maxResults} onChange={(e) => set("maxResults", e.target.value)} />
          </div>
          <div className="field full">
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

function CandidateRow({ c }) {
  return (
    <li className="cand-row">
      <a className="ev-link" href={extUrl(c.url)} target="_blank" rel="noreferrer">{hostOf(c.url)}</a>
      <Badge kind={confKind(c.confidence)}>{confLabel(c.confidence)}</Badge>
      <div className="cand-meta">{c.matchReason}</div>
    </li>
  );
}

function SocialPlatform({ name, mainUrl, candidates }) {
  if (!candidates || candidates.length === 0) {
    return (
      <div className="social-plat">
        <div className="social-head">{name}</div>
        <div className="ev-none">No confident match found.</div>
      </div>
    );
  }
  const main = candidates.find((c) => c.url === mainUrl && c.confidence === "high") || null;
  const rest = candidates.filter((c) => !main || c.url !== main.url);
  return (
    <div className="social-plat">
      <div className="social-head">{name}</div>
      {main ? (
        <div className="cand-row main">
          <span className="cand-lead">Main match</span>
          <a className="ev-link" href={extUrl(main.url)} target="_blank" rel="noreferrer">{hostOf(main.url)}</a>
          <Badge kind="verified">High confidence</Badge>
          <div className="cand-meta">{main.matchReason}</div>
        </div>
      ) : (
        <div className="social-warn">No high-confidence match — the items below are unverified guesses and require human review.</div>
      )}
      {rest.length > 0 && (
        <ul className="cand-list">
          {rest.map((c, i) => <CandidateRow key={i} c={c} />)}
        </ul>
      )}
    </div>
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
          <Badge kind="verified">Verified from Serper</Badge>
        </div>
        <div className="field-line">{lead["Evidence Summary"]}</div>
        <div className="ai-note">Social profiles are reviewed separately below — they are not counted as verified evidence.</div>
      </section>

      {/* Social Match Review */}
      <section className="sec">
        <div className="sec-head">
          <h4>Social Match Review</h4>
          <Badge kind="review">Human review required</Badge>
        </div>
        <SocialPlatform name="Instagram" mainUrl={lead["Instagram"]} candidates={lead.instagramCandidates || []} />
        <SocialPlatform name="Facebook" mainUrl={lead["Facebook"]} candidates={lead.facebookCandidates || []} />
        <div className="ai-note">Only a “High confidence” match is treated as the business’s real profile. Possible / weak matches are guesses — open and confirm each one before any outreach.</div>
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
