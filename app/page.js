"use client";

import { useEffect, useRef, useState } from "react";
import { toCSV } from "../lib/schema";
import { mergeSaved } from "../lib/workflow";

const PRESETS = [
  "Fitness", "Med Spa / Aesthetics", "Dental", "Chiropractic", "Roofing",
  "HVAC / Plumbing / Electrical", "Legal", "Real Estate", "Coaching",
  "Restaurants", "Auto Detailing", "Home Services", "Beauty / Salon",
  "Wellness", "Photography", "Custom",
];

const FILTERS = [
  "All", "Hot Leads", "Warm Leads", "High Trust", "Needs Social Review",
  "Favorites", "Approved", "Ready to Contact", "Contacted",
  "Follow-Up Needed", "Booked Call", "Not a Fit",
];

const WORKFLOW = ["Search", "Review", "Approve", "Contact", "Export"];
const STORAGE_KEY = "mf-workflow-v1";

const extUrl = (u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);
const hostOf = (u) => {
  try { return new URL(extUrl(u)).hostname.replace(/^www\./, ""); }
  catch { return u; }
};

const scoreBand = (s) => (s >= 90 ? "hot" : s >= 65 ? "warm" : "cold");
const bandLabel = (b) => (b === "hot" ? "Red Hot" : b === "warm" ? "Warm" : "Cold");

const dataConfidence = (score) =>
  score >= 4 ? "High Confidence" : score >= 3 ? "Medium Confidence" : "Low Confidence";

const socialLabel = (c) =>
  c === "high" ? "High Confidence Match" : c === "medium" ? "Likely Match" : "Weak Match";
const socialKind = (c) => (c === "high" ? "verified" : c === "medium" ? "social" : "review");
const linkTypeLabel = (t) =>
  t === "profile" ? "Profile" : t === "page" ? "Page" : t === "post" ? "Post" : t === "video" ? "Video" : "Link";

const displayChannel = (ch) => (ch === "Facebook Messenger" ? "Facebook Message" : ch);
function bestFirstMove(lead) {
  const ch = lead["Recommended Channel"];
  if (ch === "Instagram DM" && !lead["Instagram"]) return lead["Website"] ? "Website Form" : "Phone/Text";
  if (ch === "Facebook Messenger" && !lead["Facebook"]) return lead["Website"] ? "Website Form" : "Phone/Text";
  return displayChannel(ch);
}
function bestMoveReason(lead) {
  const move = bestFirstMove(lead);
  if (move === "Instagram DM") return "A high-confidence Instagram profile was found.";
  if (move === "Facebook Message") return "A high-confidence Facebook page was found.";
  if (move === "Website Form") {
    return lead["Website"]
      ? "Website is available and the social match is not high-confidence."
      : "Website form is the safest verifiable first channel.";
  }
  if (move === "Phone/Text") {
    return lead["Phone"]
      ? "Phone is available; no high-confidence website or social profile to use first."
      : "Limited public contact data — verify before reaching out.";
  }
  if (move === "Email") return "Email is the available direct channel.";
  return "Based on the available public data.";
}

const STATUS_SLUG = {
  "New": "new", "Reviewing": "reviewing", "Ready to Contact": "ready",
  "Contacted": "contacted", "Follow-Up Needed": "followup",
  "Booked Call": "booked", "Not a Fit": "notfit",
};
const statusSlug = (s) => STATUS_SLUG[s] || "new";

function matchesFilter(lead, f) {
  switch (f) {
    case "Hot Leads": return scoreBand(lead["Fit Score"]) === "hot";
    case "Warm Leads": return scoreBand(lead["Fit Score"]) === "warm";
    case "High Trust": return lead["Trust Level"] === "High";
    case "Needs Social Review": return lead.socialEvidence === "possible";
    case "Favorites": return !!lead.favorite;
    case "Approved": return lead["Approved To Contact"] === "YES";
    case "Ready to Contact":
    case "Contacted":
    case "Follow-Up Needed":
    case "Booked Call":
    case "Not a Fit": return lead["Status"] === f;
    default: return true;
  }
}

function groupSocial(mainUrl, candidates) {
  const main = candidates.find((c) => c.url === mainUrl) || null;
  const supporting = candidates.filter((c) => c !== main);
  return { main, supporting };
}

// ---- localStorage wrappers (browser-only workflow state; no keys/PII beyond the lead) ----
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
  catch { return {}; }
}
function persistSaved(map) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch { /* quota/unavailable */ }
}

function Badge({ kind, children }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

function StarButton({ on, onClick, className = "" }) {
  return (
    <button
      className={`star${on ? " on" : ""} ${className}`}
      onClick={onClick}
      aria-label={on ? "Remove favorite" : "Add favorite"}
      title={on ? "Favorited" : "Add to favorites"}
    >
      {on ? "★" : "☆"}
    </button>
  );
}

function ScoreRing({ score, size = 46, showLabel = false }) {
  const band = scoreBand(score);
  const stroke = size >= 60 ? 6 : 4;
  const r = (size - stroke) / 2 - 1;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, Number(score) || 0)) / 100;
  const mid = size / 2;
  return (
    <div className={`ring-wrap ${band}`}>
      <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle className="ring-bg" cx={mid} cy={mid} r={r} strokeWidth={stroke} fill="none" />
        <circle
          className="ring-fg" cx={mid} cy={mid} r={r} strokeWidth={stroke} fill="none"
          stroke={`url(#mf-grad-${band})`} strokeLinecap="round"
          strokeDasharray={`${c * pct} ${c - c * pct}`} transform={`rotate(-90 ${mid} ${mid})`}
        />
        <text className="ring-num" x={mid} y={mid} dominantBaseline="central" textAnchor="middle" style={{ fontSize: size >= 60 ? 20 : 14 }}>{score}</text>
      </svg>
      {showLabel && <span className={`ring-label ${band}`}>{bandLabel(band)}</span>}
    </div>
  );
}

function CopyButton({ label, text }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="secondary sm" disabled={!text}
      onClick={async () => {
        try { await navigator.clipboard.writeText(text || ""); setDone(true); setTimeout(() => setDone(false), 1200); }
        catch { /* clipboard unavailable */ }
      }}
    >
      {done ? "Copied ✓" : label}
    </button>
  );
}

function GradientDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <linearGradient id="mf-grad-hot" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#ff8095" /><stop offset="100%" stopColor="#ff2d55" /></linearGradient>
        <linearGradient id="mf-grad-warm" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#ffd27a" /><stop offset="100%" stopColor="#ff8a00" /></linearGradient>
        <linearGradient id="mf-grad-cold" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#6db3ff" /><stop offset="100%" stopColor="#0071e3" /></linearGradient>
      </defs>
    </svg>
  );
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
  const [filter, setFilter] = useState("All");
  const [flashId, setFlashId] = useState(null);
  const [theme, setTheme] = useState("light");
  const [saved, setSaved] = useState({});
  const savedRef = useRef({});

  useEffect(() => {
    setTheme(document.documentElement.getAttribute("data-theme") || "light");
    const s = loadSaved();
    setSaved(s);
    savedRef.current = s;
  }, []);
  useEffect(() => { savedRef.current = saved; }, [saved]);

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
    setFilter("All");
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
      const { merged, next } = mergeSaved(data.leads || [], savedRef.current);
      setLeads(merged);
      setSaved(next);
      savedRef.current = next;
      persistSaved(next);
      setMeta(data.meta || null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function commitSaved(key, patch) {
    setSaved((prev) => {
      const next = { ...prev, [key]: { ...(prev[key] || {}), ...patch } };
      persistSaved(next);
      savedRef.current = next;
      return next;
    });
  }
  function setStatus(index, status) {
    const lead = leads[index]; if (!lead) return;
    setLeads((prev) => prev.map((l, i) => (i === index ? { ...l, "Status": status } : l)));
    commitSaved(lead._key, { status });
  }
  function approveLead(index) {
    const lead = leads[index]; if (!lead) return;
    setLeads((prev) => prev.map((l, i) => (i === index ? { ...l, "Approved To Contact": "YES", "Status": "Ready to Contact" } : l)));
    commitSaved(lead._key, { approved: true, status: "Ready to Contact" });
    setFlashId(index);
    setTimeout(() => setFlashId((cur) => (cur === index ? null : cur)), 1300);
  }
  function toggleFavorite(index) {
    const lead = leads[index]; if (!lead) return;
    const fav = !lead.favorite;
    setLeads((prev) => prev.map((l, i) => (i === index ? { ...l, favorite: fav } : l)));
    commitSaved(lead._key, { favorite: fav });
  }
  function setNotes(index, notes) {
    const lead = leads[index]; if (!lead) return;
    setLeads((prev) => prev.map((l, i) => (i === index ? { ...l, notes } : l)));
    commitSaved(lead._key, { notes });
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

  const shown = leads.map((l, i) => ({ l, i })).filter(({ l }) => matchesFilter(l, filter));

  return (
    <div className="wrap">
      <GradientDefs />
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

      {leads.length > 0 && (
        <>
          <div className="workflow">
            {WORKFLOW.map((step, i) => (
              <span key={step} className="wf-step">
                <span className="wf-dot">{i + 1}</span>{step}
                {i < WORKFLOW.length - 1 && <span className="wf-arrow">→</span>}
              </span>
            ))}
          </div>

          {meta && (
            <div className="meta">
              Found {meta.found} · removed {meta.removedFranchises} franchise{meta.removedFranchises === 1 ? "" : "s"} · analyzed {meta.analyzed}. Click a lead to review, approve, and copy outreach.
            </div>
          )}

          <div className="filters">
            {FILTERS.map((f) => {
              const count = f === "All" ? leads.length : leads.filter((l) => matchesFilter(l, f)).length;
              return (
                <button key={f} className={`chip${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>
                  {f} <span className="chip-count">{count}</span>
                </button>
              );
            })}
          </div>
          <div className="filters-help">Statuses and favorites are saved in this browser only.</div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Lead</th>
                  <th>Contact</th>
                  <th>Lead Score</th>
                  <th>Best First Move</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr><td colSpan={6} className="empty-cell">No leads match “{filter}”.</td></tr>
                ) : (
                  shown.map(({ l, i }) => (
                    <FragmentRow
                      key={i}
                      lead={l}
                      index={i}
                      open={openRow === i}
                      flash={flashId === i}
                      onToggle={() => setOpenRow(openRow === i ? null : i)}
                      onApprove={approveLead}
                      onStatus={setStatus}
                      onFavorite={toggleFavorite}
                      onNotes={setNotes}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function FragmentRow({ lead, index, open, flash, onToggle, onApprove, onStatus, onFavorite, onNotes }) {
  const approved = lead["Approved To Contact"] === "YES";
  const slug = statusSlug(lead["Status"]);
  return (
    <>
      <tr
        className={`lead-row status-${slug}${open ? " is-open" : ""}${approved ? " row-approved" : ""}${flash ? " flash" : ""}`}
        onClick={onToggle}
      >
        <td>
          <div className="biz-cell">
            <div className="biz-line">
              <StarButton on={lead.favorite} onClick={(e) => { e.stopPropagation(); onFavorite(index); }} />
              <span className="biz-name">{lead["Business Name"]}</span>
            </div>
            <span className={`trust-chip ${String(lead["Trust Level"]).toLowerCase()}`}>{lead["Trust Level"]} trust</span>
          </div>
        </td>
        <td>
          <div className="contact-cell">
            <span>{lead["Phone"] || "—"}</span>
            <span className="contact-sub">{lead["Location"]}</span>
          </div>
        </td>
        <td><ScoreRing score={lead["Fit Score"]} showLabel /></td>
        <td><span className="move-label">{bestFirstMove(lead)}</span></td>
        <td><span className={`status-pill ${slug}`}>{lead["Status"]}</span></td>
        <td className="chev-cell"><span className="chev">{open ? "▾" : "▸"}</span></td>
      </tr>
      {open && (
        <tr className="detail">
          <td colSpan={6}>
            <EvidenceDrawer
              lead={lead} index={index}
              onApprove={onApprove} onStatus={onStatus} onFavorite={onFavorite} onNotes={onNotes}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function MainMatch({ platform, c }) {
  return (
    <div className="pmatch">
      <div className="pmatch-top">
        <span className="pmatch-plat">{platform} {linkTypeLabel(c.linkType)}</span>
        <Badge kind="verified">High Confidence Match</Badge>
        <a className="btn-link sm" href={extUrl(c.url)} target="_blank" rel="noreferrer">Open</a>
      </div>
      <a className="pmatch-url" href={extUrl(c.url)} target="_blank" rel="noreferrer">{hostOf(c.url)}</a>
    </div>
  );
}

function SupportingEvidence({ items }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="supporting">
      <button className="collapse-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide" : "Show"} supporting evidence ({items.length})
      </button>
      {open && (
        <div className="supporting-list">
          {items.map(({ platform, c }, i) => (
            <div className="scand" key={i}>
              <div className="scand-top">
                <span className="scand-plat">{platform} · {linkTypeLabel(c.linkType)}</span>
                <Badge kind={socialKind(c.confidence)}>{socialLabel(c.confidence)}</Badge>
                <a className="btn-link sm" href={extUrl(c.url)} target="_blank" rel="noreferrer">Open</a>
              </div>
              <div className="scand-reason">{c.matchReason}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ScoreDetails({ lead }) {
  const [open, setOpen] = useState(false);
  const breakdown = Array.isArray(lead.scoreBreakdown) ? lead.scoreBreakdown : [];
  return (
    <section className="sec">
      <div className="sec-head"><h4>Score Details</h4><Badge kind="ai">AI / directional</Badge></div>
      <div className="score-exp">Score is based on public data, social match confidence, and AI-estimated automation opportunity.</div>
      <button className="collapse-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide score breakdown" : "View score breakdown"}
      </button>
      {open && (
        <>
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
        </>
      )}
    </section>
  );
}

function Draft({ title, text }) {
  return (
    <div className="draft">
      <div className="draft-head">
        <span className="msg-title">{title}</span>
        <CopyButton label={`Copy ${title}`} text={text} />
      </div>
      <div className="msg">{text || "—"}</div>
    </div>
  );
}

function EvidenceDrawer({ lead, index, onApprove, onStatus, onFavorite, onNotes }) {
  const [savedMsg, setSavedMsg] = useState(false);
  useEffect(() => {
    if (!savedMsg) return;
    const t = setTimeout(() => setSavedMsg(false), 1600);
    return () => clearTimeout(t);
  }, [savedMsg]);
  const flash = () => setSavedMsg(true);

  const website = lead["Website"];
  const approved = lead["Approved To Contact"] === "YES";
  const opp = lead.opportunity;

  const igG = groupSocial(lead["Instagram"], lead.instagramCandidates || []);
  const fbG = groupSocial(lead["Facebook"], lead.facebookCandidates || []);
  const mains = [
    ...(igG.main ? [{ platform: "Instagram", c: igG.main }] : []),
    ...(fbG.main ? [{ platform: "Facebook", c: fbG.main }] : []),
  ];
  const supporting = [
    ...igG.supporting.map((c) => ({ platform: "Instagram", c })),
    ...fbG.supporting.map((c) => ({ platform: "Facebook", c })),
  ];

  return (
    <div className="drawer">
      {/* A. Lead Header */}
      <section className="sec lead-header">
        <div className="lh-top">
          <ScoreRing score={lead["Fit Score"]} size={72} showLabel />
          <div className="lh-id">
            <div className="lh-name-row">
              <StarButton on={lead.favorite} onClick={() => { onFavorite(index); flash(); }} />
              <span className="lh-name">{lead["Business Name"]}</span>
            </div>
            <div className="lh-stats">
              <span><em>Temperature</em>{lead["Lead Temperature"]}</span>
              <span><em>Trust</em>{lead["Trust Level"]}</span>
              <span><em>Confidence</em>{dataConfidence(lead["Confidence Score"])}</span>
            </div>
          </div>
          <div className="spacer" />
          <button className={`btn-approve${approved ? " done" : ""}`} onClick={() => { onApprove(index); flash(); }} disabled={approved}>
            {approved ? "✓ Approved" : "Approve Lead"}
          </button>
        </div>
        <div className="lh-move">Best First Move: <strong>{bestFirstMove(lead)}</strong></div>
        <div className="status-actions">
          <button className="secondary sm" onClick={() => { onStatus(index, "Contacted"); flash(); }}>Mark Contacted</button>
          <button className="secondary sm" onClick={() => { onStatus(index, "Follow-Up Needed"); flash(); }}>Follow-Up Needed</button>
          <button className="secondary sm" onClick={() => { onStatus(index, "Booked Call"); flash(); }}>Booked Call</button>
          <button className="secondary sm" onClick={() => { onStatus(index, "Not a Fit"); flash(); }}>Not a Fit</button>
        </div>
        {savedMsg && <div className="saved-msg">Saved in this browser.</div>}
        {approved && <div className="approve-help">✓ Now in your Ready to Contact queue.</div>}
        <textarea
          className="notes" placeholder="Your notes (saved in this browser)…"
          value={lead.notes || ""} onChange={(e) => { onNotes(index, e.target.value); flash(); }}
        />
      </section>

      {/* B. What matters */}
      <section className="sec">
        <div className="sec-head"><h4>What matters</h4></div>
        <div className="matters">
          <p><b>Worth a look:</b> {opp?.problem || "May benefit from faster inquiry capture and follow-up, based on public data."}</p>
          <p><b>Likely gap:</b> {lead["Likely Lead Gap"] && lead["Likely Lead Gap"] !== "Unknown" ? lead["Likely Lead Gap"] : "Not clear from public data."}</p>
          <p><b>What we could offer first:</b> {opp?.offer || lead["Automation Opportunity"]}</p>
          {opp?.firstOffer && <p className="matters-quote">“{opp.firstOffer}”</p>}
        </div>
      </section>

      {/* C. Verified Info */}
      <section className="sec">
        <div className="sec-head"><h4>Verified Info</h4><Badge kind="verified">Public data</Badge></div>
        <div className="facts">
          <div className="fact"><span>Website</span>{website ? <a href={extUrl(website)} target="_blank" rel="noreferrer">{hostOf(website)}</a> : "—"}</div>
          <div className="fact"><span>Phone</span>{lead["Phone"] || "—"}</div>
          <div className="fact"><span>Location</span>{lead["Location"] || "—"}</div>
          <div className="fact"><span>Rating</span>{lead.rating !== "" && lead.rating != null ? `${lead.rating}★${lead.reviews !== "" && lead.reviews != null ? ` · ${lead.reviews} reviews` : ""}` : "—"}</div>
          <div className="fact"><span>Category</span>{lead.category || "—"}</div>
        </div>
      </section>

      {/* D. Social Profiles */}
      <section className="sec">
        <div className="sec-head">
          <h4>Social Profiles</h4>
          {mains.length ? <Badge kind="verified">Match found</Badge> : <Badge kind="review">Review needed</Badge>}
        </div>
        {mains.length
          ? mains.map((m, i) => <MainMatch key={i} platform={m.platform} c={m.c} />)
          : <div className="ev-none">No verified profile or page match yet — check supporting evidence.</div>}
        {supporting.length > 0 && <SupportingEvidence items={supporting} />}
      </section>

      {/* E. Suggested Outreach */}
      <section className="sec">
        <div className="sec-head"><h4>Suggested Outreach</h4><Badge kind="review">Human review</Badge></div>
        <div className="field-line"><span className="k">Recommended channel: </span>{bestFirstMove(lead)}</div>
        <div className="move-why">{bestMoveReason(lead)}</div>
        <Draft title="First Message" text={lead["First Message"]} />
        <Draft title="Follow-Up 1" text={lead["Follow-Up 1"]} />
        <Draft title="Follow-Up 2" text={lead["Follow-Up 2"]} />
        <Draft title="Close-The-Loop" text={lead["Close-The-Loop Message"]} />
        <div className="ai-note">AI-generated suggestions. Review and edit before any manual outreach — nothing is sent automatically.</div>
      </section>

      {/* F. Score Details (collapsed) */}
      <ScoreDetails lead={lead} />
    </div>
  );
}
