"use client";

import { useEffect, useState } from "react";
import { toCSV } from "../lib/schema";

const PRESETS = [
  "Fitness", "Med Spa / Aesthetics", "Dental", "Chiropractic", "Roofing",
  "HVAC / Plumbing / Electrical", "Legal", "Real Estate", "Coaching",
  "Restaurants", "Auto Detailing", "Home Services", "Beauty / Salon",
  "Wellness", "Photography", "Custom",
];

const FILTERS = [
  "All", "Hot Leads", "High Trust", "Needs Social Review",
  "Website Form", "Instagram DM", "Approved",
];

const WORKFLOW = ["Search", "Review", "Approve", "Contact", "Export"];

const extUrl = (u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);
const hostOf = (u) => {
  try { return new URL(extUrl(u)).hostname.replace(/^www\./, ""); }
  catch { return u; }
};

// Premium score bands (independent of the backend temperature label).
const scoreBand = (s) => (s >= 90 ? "hot" : s >= 65 ? "warm" : "cold");
const bandLabel = (b) => (b === "hot" ? "Red Hot" : b === "warm" ? "Warm" : "Cold");

const dataConfidence = (score) =>
  score >= 4 ? "High Confidence" : score >= 3 ? "Medium Confidence" : "Low Confidence";

// Social labels — prefer "High Confidence / Likely" over "Verified".
const socialLabel = (c) =>
  c === "high" ? "High Confidence Match"
    : c === "medium" ? "Likely Match — review manually"
      : "Weak Match — do not use without review";
const socialKind = (c) => (c === "high" ? "verified" : c === "medium" ? "social" : "review");
const linkTypeLabel = (t) =>
  t === "profile" ? "Profile" : t === "page" ? "Page" : t === "post" ? "Post" : t === "video" ? "Video" : "Link";

const displayChannel = (ch) => (ch === "Facebook Messenger" ? "Facebook Message" : ch);

// Best First Move: only surface a DM when a real profile/page main link exists.
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
      ? "Website is available with a likely contact path, and the social match is not high-confidence."
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

function whyThisLead(lead) {
  const trust = String(lead["Trust Level"]).toLowerCase();
  const conf = dataConfidence(lead["Confidence Score"]).toLowerCase();
  const parts = [
    `${lead["Lead Temperature"]} — scores ${lead["Fit Score"]}/100 with ${trust} trust and ${conf} in the public data.`,
  ];
  if (lead["Likely Lead Gap"] && lead["Likely Lead Gap"] !== "Unknown") {
    parts.push(`Likely gap: ${lead["Likely Lead Gap"]}`);
  }
  if (lead.opportunity?.offer) parts.push(`Where we could help: ${lead.opportunity.offer}`);
  return parts.join(" ");
}

const STATUS_SLUG = {
  "New": "new", "Reviewing": "reviewing", "Ready to Contact": "ready",
  "Contacted": "contacted", "Follow-Up Needed": "followup",
  "Booked Call": "booked", "Not a Fit": "notfit",
};
const statusSlug = (s) => STATUS_SLUG[s] || "new";

function matchesFilter(lead, filter) {
  switch (filter) {
    case "Hot Leads": return lead["Lead Temperature"] === "Hot Lead";
    case "High Trust": return lead["Trust Level"] === "High";
    case "Needs Social Review": return lead.socialEvidence === "possible";
    case "Website Form": return bestFirstMove(lead) === "Website Form";
    case "Instagram DM": return bestFirstMove(lead) === "Instagram DM";
    case "Approved": return lead["Approved To Contact"] === "YES";
    default: return true;
  }
}

// Split a platform's candidates into main / supporting posts / other possible.
function groupSocial(mainUrl, candidates) {
  const main = candidates.find((c) => c.url === mainUrl) || null;
  const rest = candidates.filter((c) => c !== main);
  const posts = rest.filter((c) => c.linkType === "post" || c.linkType === "video");
  const others = rest.filter((c) => c.linkType !== "post" && c.linkType !== "video");
  return { main, posts, others };
}

function Badge({ kind, children }) {
  return <span className={`badge ${kind}`}>{children}</span>;
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
      className="secondary sm"
      disabled={!text}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text || "");
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch { /* clipboard unavailable */ }
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
        <linearGradient id="mf-grad-hot" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ff8095" /><stop offset="100%" stopColor="#ff2d55" />
        </linearGradient>
        <linearGradient id="mf-grad-warm" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffd27a" /><stop offset="100%" stopColor="#ff8a00" />
        </linearGradient>
        <linearGradient id="mf-grad-cold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6db3ff" /><stop offset="100%" stopColor="#0071e3" />
        </linearGradient>
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

  useEffect(() => {
    setTheme(document.documentElement.getAttribute("data-theme") || "light");
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
      setLeads(data.leads || []);
      setMeta(data.meta || null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function setStatus(index, status) {
    setLeads((prev) => prev.map((l, i) => (i === index ? { ...l, "Status": status } : l)));
  }

  function approveLead(index) {
    setLeads((prev) =>
      prev.map((l, i) =>
        i === index ? { ...l, "Approved To Contact": "YES", "Status": "Ready to Contact" } : l
      )
    );
    setFlashId(index);
    setTimeout(() => setFlashId((cur) => (cur === index ? null : cur)), 1300);
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

function FragmentRow({ lead, index, open, flash, onToggle, onApprove, onStatus }) {
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
            <span className="biz-name">{lead["Business Name"]}</span>
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
            <EvidenceDrawer lead={lead} index={index} onApprove={onApprove} onStatus={onStatus} />
          </td>
        </tr>
      )}
    </>
  );
}

function CandidateItem({ platform, c, isMain }) {
  return (
    <div className={`smatch${isMain ? " main" : ""}`}>
      <div className="smatch-top">
        <span className="smatch-plat">{platform}</span>
        <span className="smatch-type">{linkTypeLabel(c.linkType)}</span>
        <Badge kind={socialKind(c.confidence)}>{socialLabel(c.confidence)}</Badge>
        <a className="btn-link sm" href={extUrl(c.url)} target="_blank" rel="noreferrer">Open</a>
      </div>
      <div className="smatch-reason">{c.matchReason}</div>
      {c.sharedDistinctiveTerms?.length > 0 && (
        <div className="smatch-terms">Shared terms: {c.sharedDistinctiveTerms.join(", ")}</div>
      )}
    </div>
  );
}

function SocialMatchReview({ lead }) {
  const ig = groupSocial(lead["Instagram"], lead.instagramCandidates || []);
  const fb = groupSocial(lead["Facebook"], lead.facebookCandidates || []);
  const tag = (platform, arr) => arr.map((c) => ({ platform, c }));

  const mains = [
    ...(ig.main ? tag("Instagram", [ig.main]) : []),
    ...(fb.main ? tag("Facebook", [fb.main]) : []),
  ];
  const posts = [...tag("Instagram", ig.posts), ...tag("Facebook", fb.posts)];
  const others = [...tag("Instagram", ig.others), ...tag("Facebook", fb.others)];

  return (
    <>
      <div className="smatch-group">
        <div className="smatch-h">Main Profile / Page Match</div>
        {mains.length
          ? mains.map(({ platform, c }, i) => <CandidateItem key={i} platform={platform} c={c} isMain />)
          : <div className="ev-none">No high-confidence profile or page match — manual review required.</div>}
      </div>
      <div className="smatch-group">
        <div className="smatch-h">Supporting Posts Found</div>
        {posts.length
          ? posts.map(({ platform, c }, i) => <CandidateItem key={i} platform={platform} c={c} />)
          : <div className="ev-none">None.</div>}
      </div>
      <div className="smatch-group">
        <div className="smatch-h">Other Possible Matches</div>
        {others.length
          ? others.map(({ platform, c }, i) => <CandidateItem key={i} platform={platform} c={c} />)
          : <div className="ev-none">None.</div>}
      </div>
    </>
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

function socialStatus(mainUrl, cands) {
  if (mainUrl) return { text: "High Confidence Match", kind: "verified" };
  if (cands.length) return { text: "Needs review", kind: "social" };
  return { text: "No confident match", kind: "review" };
}

function EvidenceDrawer({ lead, index, onApprove, onStatus }) {
  const website = lead["Website"];
  const approved = lead["Approved To Contact"] === "YES";
  const breakdown = Array.isArray(lead.scoreBreakdown) ? lead.scoreBreakdown : [];
  const opp = lead.opportunity;
  const igStatus = socialStatus(lead["Instagram"], lead.instagramCandidates || []);
  const fbStatus = socialStatus(lead["Facebook"], lead.facebookCandidates || []);

  return (
    <div className="drawer">
      {/* A. Lead Summary */}
      <section className="sec summary">
        <div className="summary-main">
          <ScoreRing score={lead["Fit Score"]} size={72} showLabel />
          <div className="summary-info">
            <div className="summary-name">{lead["Business Name"]}</div>
            <div className="summary-stats">
              <span><em>Temperature</em>{lead["Lead Temperature"]}</span>
              <span><em>Trust</em>{lead["Trust Level"]}</span>
              <span><em>Confidence</em>{dataConfidence(lead["Confidence Score"])}</span>
            </div>
          </div>
          <div className="spacer" />
          <button className={`btn-approve${approved ? " done" : ""}`} onClick={() => onApprove(index)} disabled={approved}>
            {approved ? "✓ Approved" : "Approve Lead"}
          </button>
        </div>
        <div className="status-actions">
          <button className="secondary sm" onClick={() => onStatus(index, "Contacted")}>Mark Contacted</button>
          <button className="secondary sm" onClick={() => onStatus(index, "Follow-Up Needed")}>Follow-Up Needed</button>
          <button className="secondary sm" onClick={() => onStatus(index, "Booked Call")}>Booked Call</button>
          <button className="secondary sm" onClick={() => onStatus(index, "Not a Fit")}>Not a Fit</button>
        </div>
        {approved && <div className="approve-help">✓ This lead is now in your Ready to Contact queue.</div>}
      </section>

      {/* B. Why This Lead */}
      <section className="sec">
        <div className="sec-head"><h4>Why This Lead</h4></div>
        <div className="field-line">{whyThisLead(lead)}</div>
      </section>

      {/* C. Trust & Evidence — compact cards */}
      <section className="sec">
        <div className="sec-head">
          <h4>Trust &amp; Evidence</h4>
          <Badge kind="verified">Public data via Serper</Badge>
        </div>
        <div className="cards">
          <div className="card">
            <div className="card-h">Business Info</div>
            <div className="kv"><span>Category</span><b>{lead.category || "—"}</b></div>
            <div className="kv"><span>Business name</span><b>{lead["Business Name"]}</b></div>
            <div className="kv"><span>Location</span><b>{lead["Location"] || "—"}</b></div>
          </div>
          <div className="card">
            <div className="card-h">Contact Info</div>
            <div className="kv"><span>Phone</span><b>{lead["Phone"] || "—"}</b></div>
            <div className="kv"><span>Website</span>{website ? <a href={extUrl(website)} target="_blank" rel="noreferrer">{hostOf(website)}</a> : <b>—</b>}</div>
            <div className="kv"><span>Email</span><b>{lead["Email"] || "Not available"}</b></div>
          </div>
          <div className="card">
            <div className="card-h">Public Signals</div>
            <div className="kv"><span>Rating</span><b>{lead.rating !== "" && lead.rating != null ? `${lead.rating}★` : "—"}</b></div>
            <div className="kv"><span>Reviews</span><b>{lead.reviews !== "" && lead.reviews != null ? lead.reviews : "—"}</b></div>
            <div className="kv"><span>Source</span><b>Serper / Google public data</b></div>
          </div>
          <div className="card">
            <div className="card-h">Social Evidence</div>
            <div className="kv"><span>Instagram</span><Badge kind={igStatus.kind}>{igStatus.text}</Badge></div>
            <div className="kv"><span>Facebook</span><Badge kind={fbStatus.kind}>{fbStatus.text}</Badge></div>
            <div className="kv"><span>Human review</span><b>Needed</b></div>
          </div>
        </div>
      </section>

      {/* D. Social Match Review — grouped */}
      <section className="sec">
        <div className="sec-head">
          <h4>Social Match Review</h4>
          <Badge kind="review">Human review required</Badge>
        </div>
        <SocialMatchReview lead={lead} />
        <div className="ai-note">A social link becomes the main profile only on a high-confidence profile/page match. Posts and weak matches are supporting evidence — confirm manually before any outreach.</div>
      </section>

      {/* E. Recommended Opportunity */}
      <section className="sec">
        <div className="sec-head">
          <h4>Recommended Opportunity</h4>
          <Badge kind="ai">AI-generated recommendation</Badge>
        </div>
        {opp && (opp.problem || opp.offer || opp.why || opp.firstOffer) ? (
          <div className="opp">
            {opp.problem && <div className="opp-row"><span className="opp-k">Problem</span><span>{opp.problem}</span></div>}
            {opp.offer && <div className="opp-row"><span className="opp-k">Possible offer</span><span>{opp.offer}</span></div>}
            {opp.why && <div className="opp-row"><span className="opp-k">Why it matters</span><span>{opp.why}</span></div>}
            {opp.firstOffer && <div className="opp-row"><span className="opp-k">Suggested first offer</span><span>{opp.firstOffer}</span></div>}
          </div>
        ) : (
          <div className="field-line">{lead["Automation Opportunity"]}</div>
        )}
        <div className="ai-note">Based on available public data only. Uses “may” / “likely” — verify before pitching.</div>
      </section>

      {/* F. Suggested Outreach */}
      <section className="sec">
        <div className="sec-head">
          <h4>Suggested Outreach</h4>
          <Badge kind="review">Human review required</Badge>
        </div>
        <div className="move-box">
          <div className="move-big">{bestFirstMove(lead)}</div>
          <div className="move-why">{bestMoveReason(lead)}</div>
        </div>

        <div className="actions">
          {website && <a className="btn-link" href={extUrl(website)} target="_blank" rel="noreferrer">Open Website</a>}
          {lead["Instagram"] && <a className="btn-link" href={extUrl(lead["Instagram"])} target="_blank" rel="noreferrer">Open Instagram</a>}
          {lead["Facebook"] && <a className="btn-link" href={extUrl(lead["Facebook"])} target="_blank" rel="noreferrer">Open Facebook</a>}
        </div>

        <Draft title="First Message" text={lead["First Message"]} />
        <Draft title="Follow-Up 1" text={lead["Follow-Up 1"]} />
        <Draft title="Follow-Up 2" text={lead["Follow-Up 2"]} />
        <Draft title="Close-The-Loop" text={lead["Close-The-Loop Message"]} />
        <div className="ai-note">These drafts are AI-generated suggestions. Review and edit before any manual outreach.</div>
      </section>

      {/* G. Score Breakdown */}
      <section className="sec">
        <div className="sec-head">
          <h4>Score Breakdown</h4>
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
    </div>
  );
}
