"use client";

import { useEffect, useRef, useState } from "react";
import {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
} from "firebase/auth";
import { toCSV } from "../lib/schema";
import { mergeSaved } from "../lib/workflow";
import { getStageForStatus } from "../lib/stages";
import {
  isFirebaseConfigured, auth, fetchSavedLeads, fetchSavedLeadDocs, saveLead, createUserProfile, touchUserLogin,
} from "../lib/firebase";

const PRESETS = [
  "Fitness", "Med Spa / Aesthetics", "Dental", "Chiropractic", "Roofing",
  "HVAC / Plumbing / Electrical", "Legal", "Real Estate", "Coaching",
  "Restaurants", "Auto Detailing", "Home Services", "Beauty / Salon",
  "Wellness", "Photography", "Custom",
];

// Primary workflow chips (the everyday pipeline view).
const PRIMARY_FILTERS = [
  "All", "Favorites", "Ready to Contact", "Contacted",
  "Follow-Up Needed", "Booked Call", "Not a Fit",
];
// Lead-quality filters live in a compact secondary dropdown.
const QUALITY_FILTERS = ["Hot Leads", "Warm Leads", "Cold Leads", "High Trust", "Needs Social Review"];

// Stage-based navigation tabs (shell only for now; Ready to Contact / Pipeline /
// Archive load saved leads in a later step).
const TABS = ["Research", "Review", "Ready to Contact", "Pipeline", "Archive"];
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
  "New": "new", "Reviewing": "reviewing", "Approved": "approved", "Ready to Contact": "ready",
  "Contacted": "contacted", "Follow-Up Needed": "followup", "Booked Call": "booked",
  "Proposal Sent": "proposal", "Won": "won", "In Delivery": "delivery", "Delivered": "delivered",
  "Not a Fit": "notfit", "Not Interested": "notinterested", "No Response": "noresponse",
  "Duplicate": "duplicate", "Wrong Match": "wrongmatch", "Do Not Contact": "donotcontact",
};
const statusSlug = (s) => STATUS_SLUG[s] || "new";

function matchesPrimary(lead, f) {
  switch (f) {
    case "Favorites": return !!lead.favorite;
    case "Ready to Contact":
    case "Contacted":
    case "Follow-Up Needed":
    case "Booked Call":
    case "Not a Fit": return lead["Status"] === f;
    default: return true; // "All"
  }
}
function matchesQuality(lead, q) {
  switch (q) {
    case "Hot Leads": return scoreBand(lead["Fit Score"]) === "hot";
    case "Warm Leads": return scoreBand(lead["Fit Score"]) === "warm";
    case "Cold Leads": return scoreBand(lead["Fit Score"]) === "cold";
    case "High Trust": return lead["Trust Level"] === "High";
    case "Needs Social Review": return lead.socialEvidence === "possible";
    default: return true; // "" = any quality
  }
}
const matchesFilter = (lead, primary, quality) =>
  matchesPrimary(lead, primary) && matchesQuality(lead, quality);

function groupSocial(mainUrl, candidates) {
  const main = candidates.find((c) => c.url === mainUrl) || null;
  const supporting = candidates.filter((c) => c !== main);
  return { main, supporting };
}

// ---- localStorage fallback (only used when Firebase is not configured) ----
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

function StarButton({ on, onClick }) {
  return (
    <button className={`star${on ? " on" : ""}`} onClick={onClick} aria-label={on ? "Remove favorite" : "Add favorite"} title={on ? "Favorited" : "Add to favorites"}>
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
    <button className="secondary sm" disabled={!text}
      onClick={async () => {
        try { await navigator.clipboard.writeText(text || ""); setDone(true); setTimeout(() => setDone(false), 1200); }
        catch { /* clipboard unavailable */ }
      }}>
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

function ThemeButton({ theme, onToggle }) {
  return (
    <button className="theme-btn" onClick={onToggle} aria-label="Toggle color theme">
      {theme === "dark" ? "☀︎ Light" : "☾ Dark"}
    </button>
  );
}

// Map Firebase auth error codes to clear, human inline messages.
function authErrorMessage(code) {
  switch (code) {
    case "auth/invalid-email": return "Enter a valid email address.";
    case "auth/missing-password": return "Enter your password.";
    case "auth/wrong-password": return "Incorrect password.";
    case "auth/user-not-found": return "No account found with that email.";
    case "auth/invalid-credential": return "Incorrect email or password.";
    case "auth/email-already-in-use": return "An account with that email already exists.";
    case "auth/weak-password": return "Password should be at least 6 characters.";
    case "auth/too-many-requests": return "Too many attempts. Please wait a moment and try again.";
    case "auth/network-request-failed": return "Network error. Check your connection and try again.";
    default: return "Something went wrong. Please try again.";
  }
}

// Email/password auth card. Google is intentionally omitted (popup was unreliable
// on Safari/Vercel). onAuthStateChanged in Page lifts the gate after success.
function AuthScreen({ theme, onToggleTheme }) {
  const [mode, setMode] = useState("signin"); // "signin" | "create"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function switchMode(m) { setMode(m); setErr(""); }

  async function submit(e) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (mode === "signin") {
        const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
        await touchUserLogin(cred.user.uid, cred.user.email);
      } else {
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
        await createUserProfile(cred.user.uid, cred.user.email);
      }
      // Gate lifts via Page's onAuthStateChanged listener.
    } catch (e2) {
      setErr(authErrorMessage(e2?.code));
      setBusy(false);
    }
  }

  return (
    <div className="wrap">
      <div className="topbar">
        <div className="brand">
          <h1>Market Fuzion — Prospecting Command Center</h1>
          <p>Research and prepare leads. You approve. You send.</p>
        </div>
        <ThemeButton theme={theme} onToggle={onToggleTheme} />
      </div>
      <div className="auth-card">
        <h2>Sign in to your Prospecting Command Center</h2>
        <p className="auth-sub">Save leads, statuses, favorites, and notes across sessions.</p>

        <div className="auth-tabs">
          <button className={mode === "signin" ? "active" : ""} onClick={() => switchMode("signin")} type="button">Sign In</button>
          <button className={mode === "create" ? "active" : ""} onClick={() => switchMode("create")} type="button">Create Account</button>
        </div>

        <form onSubmit={submit} className="auth-form">
          <input
            type="email" placeholder="Email" value={email} autoComplete="email" required
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            type="password" placeholder="Password" value={password} required
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            onChange={(e) => setPassword(e.target.value)}
          />
          {err && <div className="auth-error">⚠ {err}</div>}
          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? <><span className="spinner" />Please wait…</> : (mode === "signin" ? "Sign In" : "Create Account")}
          </button>
        </form>

        {mode === "create" && <p className="auth-hint">Use this for your private Market Fuzion workspace.</p>}
      </div>
    </div>
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
  const [quality, setQuality] = useState("");
  const [tab, setTab] = useState("Research");
  const [savedLeadDocs, setSavedLeadDocs] = useState([]);
  const [flashId, setFlashId] = useState(null);
  const [theme, setTheme] = useState("light");
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(!isFirebaseConfigured);
  const [toast, setToast] = useState(null);
  const savedRef = useRef({});
  const notesTimer = useRef(null);

  useEffect(() => { setTheme(document.documentElement.getAttribute("data-theme") || "light"); }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  // Auth + saved-state loading. Local-only fallback when Firebase isn't configured.
  useEffect(() => {
    if (!isFirebaseConfigured) {
      const s = loadSaved();
      savedRef.current = s;
      return;
    }
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setAuthReady(true);
      if (u) {
        try {
          // Compact map (drives search-result merge) — unchanged behavior.
          const map = await fetchSavedLeads(u.uid);
          savedRef.current = map;
          setLeads((prev) => mergeSaved(prev, map).merged);
          // Full docs for the stage tabs (Ready to Contact / Pipeline / Archive).
          setSavedLeadDocs(await fetchSavedLeadDocs(u.uid));
        } catch { showToast("Couldn't load saved leads.", "error"); }
      } else {
        savedRef.current = {};
        setSavedLeadDocs([]);
        setLeads((prev) => mergeSaved(prev, {}).merged);
      }
    });
    return () => unsub();
  }, []);

  // Simple refresh of the full saved docs (used after status moves). No realtime listeners.
  async function refreshSavedDocs() {
    if (!user) return;
    try { setSavedLeadDocs(await fetchSavedLeadDocs(user.uid)); } catch { /* keep current */ }
  }

  function showToast(msg, kind = "ok") { setToast({ msg, kind }); }
  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("mf-theme", next); } catch {}
  }
  async function signOutUser() { try { await signOut(auth); } catch { /* ignore */ } }

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const effectiveCategory = form.categoryPreset === "Custom" ? form.customCategory : form.categoryPreset;

  async function runSearch() {
    setLoading(true); setError(""); setLeads([]); setMeta(null); setOpenRow(null); setFilter("All"); setQuality("");
    try {
      const res = await fetch("/api/prospect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: effectiveCategory, keywords: form.keywords, location: form.location,
          maxResults: Number(form.maxResults), excludedFranchises: form.excludedFranchises,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Search failed.");
      const { merged } = mergeSaved(data.leads || [], savedRef.current);
      setLeads(merged);
      setMeta(data.meta || null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  // Persist a lead's workflow change to Firestore (signed in) or localStorage (local mode).
  async function commitSaved(lead, patch) {
    const key = lead._key;
    if (user) {
      try {
        await saveLead(user.uid, lead, patch, !lead._saved);
        savedRef.current = { ...savedRef.current, [key]: { ...(savedRef.current[key] || {}), ...patch, score: savedRef.current[key]?.score ?? lead["Fit Score"] } };
        showToast("Saved");
      } catch { showToast("Couldn't save. Try again.", "error"); }
    } else if (!isFirebaseConfigured) {
      const next = { ...savedRef.current, [key]: { ...(savedRef.current[key] || {}), ...patch, score: savedRef.current[key]?.score ?? lead["Fit Score"] } };
      savedRef.current = next;
      persistSaved(next);
      showToast("Saved");
    }
  }

  function toggleFavorite(index) {
    const lead = leads[index]; if (!lead) return;
    const fav = !lead.favorite;
    setLeads((prev) => prev.map((l, i) => (i === index ? { ...l, favorite: fav, _saved: true } : l)));
    commitSaved(lead, { favorite: fav });
  }
  function approveLead(index) {
    const lead = leads[index]; if (!lead) return;
    setLeads((prev) => prev.map((l, i) => (i === index ? { ...l, "Approved To Contact": "YES", "Status": "Ready to Contact", _saved: true } : l)));
    commitSaved(lead, { approved: true, status: "Ready to Contact" }).then(refreshSavedDocs);
    setFlashId(index);
    setTimeout(() => setFlashId((cur) => (cur === index ? null : cur)), 1300);
  }
  function setStatus(index, status) {
    const lead = leads[index]; if (!lead) return;
    setLeads((prev) => prev.map((l, i) => (i === index ? { ...l, "Status": status, _saved: true } : l)));
    commitSaved(lead, { status }).then(refreshSavedDocs);
  }
  function setNotes(index, notes) {
    const lead = leads[index]; if (!lead) return;
    setLeads((prev) => prev.map((l, i) => (i === index ? { ...l, notes, _saved: true } : l)));
    clearTimeout(notesTimer.current);
    notesTimer.current = setTimeout(() => commitSaved({ ...lead, notes }, { notes }), 700);
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

  // Gate behind email/password sign-in when Firebase is configured.
  if (isFirebaseConfigured && !authReady) {
    return <div className="wrap"><div className="loading-screen"><span className="spinner" />Loading…</div></div>;
  }
  if (isFirebaseConfigured && !user) {
    return <AuthScreen theme={theme} onToggleTheme={toggleTheme} />;
  }

  const shown = leads.map((l, i) => ({ l, i })).filter(({ l }) => matchesFilter(l, filter, quality));

  // Saved leads grouped into stage tabs (by stored status). Unknown statuses map
  // to Review via getStageForStatus, so they simply don't appear in these three
  // tabs rather than disappearing/erroring.
  const readyDocs = savedLeadDocs.filter((d) => getStageForStatus(d.status) === "Ready to Contact");
  const pipelineDocs = savedLeadDocs.filter((d) => {
    const st = getStageForStatus(d.status);
    return st === "Pipeline" || st === "Client / Delivery";
  });
  const archiveDocs = savedLeadDocs.filter((d) => getStageForStatus(d.status) === "Archive");

  // Researched-leads results (filters + table). Shown under Research and Review.
  const resultsSection = (
    <>
      {meta && (
        <div className="meta">
          Found {meta.found} · removed {meta.removedFranchises} franchise{meta.removedFranchises === 1 ? "" : "s"} · analyzed {meta.analyzed}. Click a lead to review, approve, and copy outreach.
        </div>
      )}

      <div className="filters">
        {PRIMARY_FILTERS.map((f) => {
          const count = leads.filter((l) => matchesFilter(l, f, quality)).length;
          return (
            <button key={f} className={`chip${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>
              {f} <span className="chip-count">{count}</span>
            </button>
          );
        })}
        <div className="filters-spacer" />
        <select className="quality-select" value={quality} onChange={(e) => setQuality(e.target.value)} aria-label="Lead quality filter">
          <option value="">All quality</option>
          {QUALITY_FILTERS.map((q) => <option key={q} value={q}>{q}</option>)}
        </select>
      </div>
      <div className="filters-help">
        {user ? "Saved to your account — favorites, status, and notes follow you across devices." : "Statuses and favorites are saved in this browser only."}
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
                  key={i} lead={l} index={i} open={openRow === i} flash={flashId === i}
                  onToggle={() => setOpenRow(openRow === i ? null : i)}
                  onApprove={approveLead} onStatus={setStatus} onFavorite={toggleFavorite} onNotes={setNotes}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );

  return (
    <div className="wrap">
      <GradientDefs />
      <div className="topbar">
        <div className="brand">
          <h1>Market Fuzion — Prospecting Command Center</h1>
          <p>Research and prepare leads. You approve. You send. Nothing auto-contacts anyone.</p>
        </div>
        <div className="top-actions">
          {user && (
            <div className="user-chip">
              {user.photoURL ? <img src={user.photoURL} alt="" /> : <span className="avatar-fallback">{(user.email || "?")[0].toUpperCase()}</span>}
              <span className="user-email">{user.email}</span>
              <button className="linklike" onClick={signOutUser}>Sign out</button>
            </div>
          )}
          <ThemeButton theme={theme} onToggle={toggleTheme} />
        </div>
      </div>

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t} className={`tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </nav>

      {tab === "Research" && (
        <>
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
          {leads.length > 0 && resultsSection}
        </>
      )}

      {tab === "Review" && (
        leads.length > 0
          ? resultsSection
          : <div className="tab-empty">Run a search first to review leads.</div>
      )}

      {tab === "Ready to Contact" && (
        <SavedList docs={readyDocs} empty="No leads ready to contact yet. Move a reviewed lead here first." />
      )}
      {tab === "Pipeline" && (
        <SavedList docs={pipelineDocs} empty="No active pipeline leads yet." />
      )}
      {tab === "Archive" && (
        <SavedList docs={archiveDocs} empty="No archived leads yet." />
      )}

      {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
    </div>
  );
}

// Best first move from a saved Firestore doc (camelCase fields).
function docBestMove(d) {
  const ch = d.recommendedChannel || "Phone/Text";
  if (ch === "Instagram DM" && !d.instagram) return d.website ? "Website Form" : "Phone/Text";
  if (ch === "Facebook Messenger" && !d.facebook) return d.website ? "Website Form" : "Phone/Text";
  return displayChannel(ch);
}

// Compact card for a saved lead in the Ready to Contact / Pipeline / Archive tabs.
function SavedLeadCard({ doc }) {
  const slug = statusSlug(doc.status);
  const notes = String(doc.notes || "").trim();
  return (
    <div className="saved-card">
      <div className="saved-head">
        <ScoreRing score={Number(doc.fitScore) || 0} />
        <div className="saved-id">
          <div className="saved-name">{doc.businessName || "Untitled lead"}</div>
          <span className={`status-pill ${slug}`}>{doc.status || "New"}</span>
        </div>
      </div>
      <div className="saved-facts">
        <div className="saved-fact"><span>Best first move</span>{docBestMove(doc)}</div>
        <div className="saved-fact"><span>Phone</span>{doc.phone || "—"}</div>
        <div className="saved-fact"><span>Website</span>{doc.website ? <a href={extUrl(doc.website)} target="_blank" rel="noreferrer">{hostOf(doc.website)}</a> : "—"}</div>
      </div>
      {notes && <div className="saved-notes"><span>Notes</span>{notes.length > 160 ? `${notes.slice(0, 160)}…` : notes}</div>}
    </div>
  );
}

function SavedList({ docs, empty }) {
  if (!docs || docs.length === 0) return <div className="tab-empty">{empty}</div>;
  return <div className="saved-list">{docs.map((d) => <SavedLeadCard key={d.id} doc={d} />)}</div>;
}

function FragmentRow({ lead, index, open, flash, onToggle, onApprove, onStatus, onFavorite, onNotes }) {
  const approved = lead["Approved To Contact"] === "YES";
  const slug = statusSlug(lead["Status"]);
  return (
    <>
      <tr className={`lead-row status-${slug}${open ? " is-open" : ""}${approved ? " row-approved" : ""}${flash ? " flash" : ""}`} onClick={onToggle}>
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
            <EvidenceDrawer lead={lead} index={index} onApprove={onApprove} onStatus={onStatus} onFavorite={onFavorite} onNotes={onNotes} />
          </td>
        </tr>
      )}
    </>
  );
}

// A Facebook URL that points at a person, not a business page.
const isPersonProfile = (url) => /profile\.php|\/people\//i.test(String(url || ""));
function presenceLabel(platform, c) {
  if (platform === "Facebook" && isPersonProfile(c.url)) return `Owner / person match on ${platform}`;
  return `Official ${platform} ${linkTypeLabel(c.linkType).toLowerCase()}`;
}

function MainMatch({ platform, c }) {
  const person = platform === "Facebook" && isPersonProfile(c.url);
  return (
    <div className="pmatch">
      <div className="pmatch-top">
        <span className="pmatch-plat">{presenceLabel(platform, c)}</span>
        <Badge kind={person ? "review" : "verified"}>{person ? "Verify — not confirmed as page" : "High confidence"}</Badge>
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
        {open ? "Hide" : "Show"} related social links ({items.length})
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

function QualificationBreakdown({ lead }) {
  const [open, setOpen] = useState(false);
  const dims = Array.isArray(lead.scoreBreakdown) ? lead.scoreBreakdown : [];
  const total = lead["Fit Score"];
  const source = lead.scoreSource || "Directional";
  return (
    <section className="sec">
      <div className="sec-head"><h4>Qualification Breakdown</h4><Badge kind={source === "AI scored" ? "ai" : "social"}>{source}</Badge></div>
      <div className="score-exp">Each dimension is scored 0–10. The total lead score is the sum of all dimensions.</div>
      <button className="collapse-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide qualification breakdown" : "View qualification breakdown"}
      </button>
      {open && (
        <>
          <div className="qb-total">Total Lead Score: <strong>{total}/100</strong></div>
          {lead.scoreStrong?.length > 0 && <div className="qb-line"><b>Strongest:</b> {lead.scoreStrong.join(", ")}</div>}
          {lead.scoreWeak?.length > 0 && <div className="qb-line"><b>Weakest:</b> {lead.scoreWeak.join(", ")}</div>}
          <div className="bars">
            {dims.map((b) => (
              <div className="bar-row" key={b.label}>
                <span className="bar-label">{b.label}</span>
                <span className="bar-track"><span className="bar-fill" style={{ width: `${b.max ? (b.score / b.max) * 100 : 0}%` }} /></span>
                <span className="bar-val">{b.score}/10</span>
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
      {/* 1. Lead Overview — summary + verified info combined */}
      <section className="sec lead-header">
        <div className="lh-top">
          <ScoreRing score={lead["Fit Score"]} size={72} showLabel />
          <div className="lh-id">
            <div className="lh-name-row">
              <StarButton on={lead.favorite} onClick={() => onFavorite(index)} />
              <span className="lh-name">{lead["Business Name"]}</span>
            </div>
            <div className="lh-stats">
              <span><em>Temperature</em>{lead["Lead Temperature"]}</span>
              <span><em>Trust</em>{lead["Trust Level"]}</span>
              <span><em>Confidence</em>{dataConfidence(lead["Confidence Score"])}</span>
              <span><em>Status</em>{lead["Status"]}</span>
            </div>
          </div>
          <div className="spacer" />
          <button className={`btn-approve${approved ? " done" : ""}`} onClick={() => onApprove(index)} disabled={approved}>
            {approved ? "✓ In Ready to Contact" : "Move to Ready to Contact"}
          </button>
        </div>
        <div className="lh-move">Best First Move: <strong>{bestFirstMove(lead)}</strong></div>
        {approved && <div className="approve-help">✓ Now in your Ready to Contact queue.</div>}
        <div className="facts overview-facts">
          <div className="fact"><span>Phone</span>{lead["Phone"] || "—"}</div>
          <div className="fact"><span>Location</span>{lead["Location"] || "—"}</div>
          <div className="fact"><span>Rating</span>{lead.rating !== "" && lead.rating != null ? `${lead.rating}★${lead.reviews !== "" && lead.reviews != null ? ` · ${lead.reviews} reviews` : ""}` : "—"}</div>
          <div className="fact"><span>Category</span>{lead.category || "—"}</div>
        </div>
      </section>

      {/* 2. Online Presence */}
      <section className="sec">
        <div className="sec-head">
          <h4>Online Presence</h4>
          {mains.length ? <Badge kind="verified">Verified match</Badge> : <Badge kind="review">Review needed</Badge>}
        </div>
        {website && (
          <div className="pmatch">
            <div className="pmatch-top">
              <span className="pmatch-plat">Website</span>
              <Badge kind="verified">Verified</Badge>
              <a className="btn-link sm" href={extUrl(website)} target="_blank" rel="noreferrer">Open</a>
            </div>
            <a className="pmatch-url" href={extUrl(website)} target="_blank" rel="noreferrer">{hostOf(website)}</a>
          </div>
        )}
        {mains.length
          ? mains.map((m, i) => <MainMatch key={i} platform={m.platform} c={m.c} />)
          : <div className="ev-none">No verified business profile or page matched yet.</div>}
        {supporting.length > 0 && <SupportingEvidence items={supporting} />}
      </section>

      {/* 3. Business Read */}
      <section className="sec">
        <div className="sec-head"><h4>Business Read</h4><Badge kind="ai">Directional</Badge></div>
        <div className="matters-text">
          {lead.whatMatters || opp?.offer || "Based on public data, this business may benefit from faster inquiry capture and follow-up."}
        </div>
      </section>

      {/* 4. Outreach Plan — next action + messages + pipeline + notes */}
      <section className="sec">
        <div className="sec-head"><h4>Outreach Plan</h4><Badge kind="review">Human review</Badge></div>
        <div className="move-box">
          <div className="move-big">{bestFirstMove(lead)}</div>
          <div className="move-why">{bestMoveReason(lead)}</div>
        </div>
        <div className="actions">
          {website && <a className="btn-link" href={extUrl(website)} target="_blank" rel="noreferrer">Open Website</a>}
          {lead["Phone"] && <a className="btn-link" href={`tel:${lead["Phone"]}`}>Call</a>}
          {lead["Instagram"] && <a className="btn-link" href={extUrl(lead["Instagram"])} target="_blank" rel="noreferrer">Open Instagram</a>}
          {lead["Facebook"] && <a className="btn-link" href={extUrl(lead["Facebook"])} target="_blank" rel="noreferrer">Open Facebook</a>}
        </div>
        {opp?.firstOffer && <div className="field-line"><span className="k">Suggested opener: </span>{opp.firstOffer}</div>}
        <Draft title="First Message" text={lead["First Message"]} />
        <Draft title="Follow-Up 1" text={lead["Follow-Up 1"]} />
        <Draft title="Follow-Up 2" text={lead["Follow-Up 2"]} />
        <Draft title="Close-The-Loop" text={lead["Close-The-Loop Message"]} />
        <div className="ai-note">AI-generated suggestions. Review and edit before any manual outreach — nothing is sent automatically.</div>
        <div className="status-actions">
          <button className={`secondary sm status-btn${lead["Status"] === "Contacted" ? " active" : ""}`} onClick={() => onStatus(index, "Contacted")}>
            {lead["Status"] === "Contacted" ? "✓ Contacted" : "Mark Contacted"}
          </button>
          <button className={`secondary sm status-btn${lead["Status"] === "Follow-Up Needed" ? " active" : ""}`} onClick={() => onStatus(index, "Follow-Up Needed")}>
            {lead["Status"] === "Follow-Up Needed" ? "✓ Follow-Up Needed" : "Follow-Up Needed"}
          </button>
          <button className={`secondary sm status-btn${lead["Status"] === "Booked Call" ? " active" : ""}`} onClick={() => onStatus(index, "Booked Call")}>
            {lead["Status"] === "Booked Call" ? "✓ Booked Call" : "Booked Call"}
          </button>
          <button className={`secondary sm status-btn${lead["Status"] === "Not a Fit" ? " active" : ""}`} onClick={() => onStatus(index, "Not a Fit")}>
            {lead["Status"] === "Not a Fit" ? "✓ Not a Fit" : "Not a Fit"}
          </button>
        </div>
        <div className="notes-label">Private notes</div>
        <textarea
          className="notes" placeholder="Private notes (only you can see these)…"
          defaultValue={lead.notes || ""} onChange={(e) => onNotes(index, e.target.value)}
        />
      </section>

      {/* 5. Qualification Breakdown (collapsed) */}
      <QualificationBreakdown lead={lead} />
    </div>
  );
}
