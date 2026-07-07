import { NextResponse } from "next/server";
import { searchBusinesses, findSocialCandidates } from "../../../lib/serper";
import { analyzeLead } from "../../../lib/openai";
import { buildFranchiseMatchers, isFranchise } from "../../../lib/franchises";

export const runtime = "nodejs";
export const maxDuration = 60; // give the batch time on Vercel

// Six dimensions, each rated 0-10 by the model. Weights sum to 100 so the
// overall Fit Score stays 0-100, while every breakdown category displays as 0-10.
const SCORE_DIMENSIONS = [
  { key: "lead_capture_need", label: "Lead Capture Need", weight: 20 },
  { key: "follow_up_risk", label: "Follow-Up Risk", weight: 20 },
  { key: "channel_reachability", label: "Channel Reachability", weight: 15 },
  { key: "automation_fit", label: "Automation Fit", weight: 20 },
  { key: "business_strength", label: "Business Strength", weight: 15 },
  { key: "outreach_personalization", label: "Outreach Personalization", weight: 10 },
];

function clampInt(v, max) {
  const n = Math.round(Number(v));
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(max, n));
}

function temperature(total) {
  if (total >= 80) return "Hot Lead";
  if (total >= 60) return "Good Lead";
  if (total >= 40) return "Maybe";
  return "Skip";
}

// Run async fn over items with a concurrency limit (avoids OpenAI rate spikes).
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return out;
}

const hasVal = (v) => v !== "" && v !== null && v !== undefined;

// Overall trust level + a plain-English evidence summary, from the verified
// (Serper) fields only. AI output never raises trust.
function trustFrom(b) {
  const checks = [
    hasVal(b.phone), hasVal(b.website), hasVal(b.rating),
    hasVal(b.reviews), hasVal(b.category),
  ];
  const points = checks.filter(Boolean).length;
  const level = points >= 4 ? "High" : points >= 2 ? "Medium" : "Low";

  const ev = [];
  if (hasVal(b.phone)) ev.push("Phone");
  if (hasVal(b.website)) ev.push("Website");
  if (hasVal(b.rating)) ev.push(`${b.rating}★`);
  if (hasVal(b.reviews)) ev.push(`${b.reviews} reviews`);
  if (hasVal(b.category)) ev.push(b.category);

  return { level, summary: ev.join(", ") || "Limited public data" };
}

// Social evidence level: "high" only when a real profile/page main link was
// promoted; "possible" when we only have supporting/weak candidates; else "none".
function socialEvidenceLevel(social = {}) {
  if (social.instagram || social.facebook) return "high";
  const has = (social.instagramCandidates || []).length || (social.facebookCandidates || []).length;
  return has ? "possible" : "none";
}

// Human-readable "possible match" line for CSV — never claims "official".
function possibleMatchText(cands = []) {
  const c = cands[0];
  if (!c) return "No confident match found";
  const label =
    c.confidence === "high" ? "high confidence"
      : c.confidence === "medium" ? "possible match"
        : "weak match — verify manually";
  return `${c.url} (${label}; ${c.matchReason})`;
}

const candidateLinks = (cands = []) => cands.map((c) => c.url).join(" | ");

function socialMatchNotes(social = {}) {
  const line = (label, mainUrl, cands) => {
    if (mainUrl) return `${label}: high-confidence profile/page match (${mainUrl})`;
    const c = cands[0];
    return c ? `${label}: ${c.confidence} ${c.linkType} — ${c.matchReason}` : `${label}: no candidate found`;
  };
  return `${line("Instagram", social.instagram, social.instagramCandidates || [])}. ${line("Facebook", social.facebook, social.facebookCandidates || [])}.`;
}

function confidenceExplanation(evidence) {
  if (evidence === "high") {
    return "Confidence reflects verified public business data plus a high-confidence social match.";
  }
  if (evidence === "possible") {
    return "Only possible/weak social matches were found — treated as unverified. Confidence is lowered; verify the social profiles manually before any outreach.";
  }
  return "No confident social match was found — social evidence is incomplete. Confidence is based on public business data and website presence only.";
}

// Deterministic score breakdown (per-category points) — computed from clamped
// sub-scores, not trusted to the model's own arithmetic.
// Every category displays as 0-10; the model's raw values are clamped here.
function scoreBreakdown(ai) {
  return SCORE_DIMENSIONS.map((d) => ({
    label: d.label,
    score: clampInt(ai[d.key], 10),
    max: 10,
    weight: d.weight,
  }));
}

// Weighted 0-100 total from the 0-10 dimensions (weights sum to 100).
function totalFromBreakdown(breakdown) {
  const sum = breakdown.reduce((acc, b) => acc + (b.score / 10) * b.weight, 0);
  return Math.round(sum);
}

// Plain-English "why this score" grounded in the actual 0-10 dimensions.
function scoreWhy(breakdown) {
  const byScore = [...breakdown].sort((a, b) => b.score - a.score);
  const top = byScore.slice(0, 2).map((x) => `${x.label} (${x.score}/10)`);
  const low = byScore[byScore.length - 1];
  return `Strongest: ${top.join(" and ")}. Weakest: ${low.label} (${low.score}/10). Directional estimate from public data — verify before outreach.`;
}

// "Recommended Opportunity" — the CSV column keeps one composed string; the UI
// gets the structured offer/first-offer pieces.
function composeOpportunity(ai) {
  const offer = (ai.opportunity_offer || "").trim();
  const firstOffer = (ai.opportunity_first_offer || "").trim();
  const text = [
    offer && `Possible offer: ${offer}`,
    firstOffer && `Suggested first offer: ${firstOffer}`,
  ].filter(Boolean).join(" | ");
  return { offer, firstOffer, text: text || "Unknown" };
}

// Build a lead object keyed by the schema COLUMNS, plus camelCase UI-only extras
// (rating/reviews/category/scoreBreakdown/opportunity/social) that never hit CSV.
function assembleLead(b, ai, niche, social = {}) {
  const noteBits = [];
  if (hasVal(b.rating)) noteBits.push(`${b.rating}★`);
  if (hasVal(b.reviews)) noteBits.push(`${b.reviews} reviews`);
  const publicContext = noteBits.length ? ` (Google: ${noteBits.join(", ")})` : "";

  const trust = trustFrom(b);
  const igCands = social.instagramCandidates || [];
  const fbCands = social.facebookCandidates || [];
  // Report the main-match confidence: "high" when a profile/page was promoted.
  const igConf = social.instagram ? "high" : (igCands[0]?.confidence || "none");
  const fbConf = social.facebook ? "high" : (fbCands[0]?.confidence || "none");
  const evidence = socialEvidenceLevel(social);

  // Verified fields + trust/social columns shared by both success and failure.
  const base = {
    "Business Name": b.business_name,
    "Niche": niche,
    "Website": b.website,
    // Main IG/FB link only when the top candidate is high-confidence.
    "Instagram": social.instagram || "",
    "Facebook": social.facebook || "",
    "Email": "",
    "Phone": b.phone,
    "Location": b.address,
    "Lead Source": "Serper.dev (Google)",
    "Trust Level": trust.level,
    "Evidence Summary": trust.summary,
    "Human Review Needed": "YES",
    "Possible Instagram Match": possibleMatchText(igCands),
    "Possible Facebook Match": possibleMatchText(fbCands),
    "Instagram Match Confidence": igConf,
    "Facebook Match Confidence": fbConf,
    "Instagram Candidate Links": candidateLinks(igCands),
    "Facebook Candidate Links": candidateLinks(fbCands),
    "Social Match Notes": socialMatchNotes(social),
    // camelCase UI-only extras (not in COLUMNS, so excluded from CSV):
    rating: b.rating ?? "",
    reviews: b.reviews ?? "",
    category: b.category || "",
    instagramCandidates: igCands,
    facebookCandidates: fbCands,
    socialEvidence: evidence,
  };

  if (!ai) {
    return {
      ...base,
      "Visible CTA": "Unknown",
      "Likely Lead Gap": "Unknown",
      "Likely Follow-Up Gap": "Unknown",
      "Automation Opportunity": "Unknown",
      "Fit Score": 0,
      "Lead Temperature": "Skip",
      "Confidence Score": 1,
      "Confidence Explanation": "AI analysis failed for this lead — re-run to score it.",
      "Recommended Channel": "Phone/Text",
      "First Message": "",
      "Follow-Up 1": "",
      "Follow-Up 2": "",
      "Close-The-Loop Message": "",
      "Status": "New",
      "Approved To Contact": "NO",
      "Notes": `AI analysis failed — retry this lead.${publicContext}`,
      scoreBreakdown: [],
      scoreWhy: "Not scored — AI analysis failed. Re-run to generate a score.",
      opportunity: null,
      whatMatters: "",
    };
  }

  const opp = composeOpportunity(ai);

  const breakdown = scoreBreakdown(ai);
  const total = totalFromBreakdown(breakdown);

  // Model confidence, capped by how trustworthy the social evidence is.
  // Possible/weak matches carry real risk of being the wrong profile, so they
  // lower confidence more than simply having no match (incomplete, not misleading).
  let conf = Math.max(1, Math.min(5, Math.round(Number(ai.confidence_score) || 1)));
  if (evidence === "possible") conf = Math.min(conf, 3);
  else if (evidence === "none") conf = Math.min(conf, 4);

  return {
    ...base,
    "Visible CTA": ai.visible_cta || "Unknown",
    "Likely Lead Gap": ai.likely_lead_gap || "Unknown",
    "Likely Follow-Up Gap": ai.likely_follow_up_gap || "Unknown",
    "Automation Opportunity": opp.text,
    "Fit Score": total,
    "Lead Temperature": temperature(total),
    "Confidence Score": conf,
    "Confidence Explanation": confidenceExplanation(evidence),
    "Recommended Channel": ai.recommended_channel || "Phone/Text",
    "First Message": ai.first_message || "",
    "Follow-Up 1": ai.follow_up_1 || "",
    "Follow-Up 2": ai.follow_up_2 || "",
    "Close-The-Loop Message": ai.close_the_loop || "",
    "Status": "New",
    "Approved To Contact": "NO",
    "Notes": `${ai.notes || ""}${publicContext}`.trim(),
    scoreBreakdown: breakdown,
    scoreWhy: scoreWhy(breakdown),
    opportunity: opp,
    whatMatters: (ai.what_matters || "").trim(),
  };
}

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const category = String(body.category || "").trim();
  const keywords = (Array.isArray(body.keywords)
    ? body.keywords
    : String(body.keywords || "").split(","))
    .map((s) => String(s).trim())
    .filter(Boolean);
  const location = String(body.location || "").trim();
  const maxResults = Math.max(1, Math.min(40, Number(body.maxResults) || 20));
  const excludedFranchises = Array.isArray(body.excludedFranchises)
    ? body.excludedFranchises
    : String(body.excludedFranchises || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

  if (!location || (!category && keywords.length === 0)) {
    return NextResponse.json(
      { error: "Provide a location and at least a category or one keyword." },
      { status: 400 }
    );
  }

  // Label used for the AI context and the "Niche" column.
  const niche = category || keywords.join(", ");

  const serperKey = process.env.SERPER_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-5.4-mini";
  if (!serperKey || !openaiKey) {
    return NextResponse.json(
      { error: "Server missing SERPER_API_KEY or OPENAI_API_KEY. Check .env.local." },
      { status: 500 }
    );
  }

  let businesses;
  try {
    businesses = await searchBusinesses({ category, keywords, location, maxResults, apiKey: serperKey });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }

  const matchers = buildFranchiseMatchers(excludedFranchises);
  const kept = businesses.filter((b) => !isFranchise(b.business_name, matchers));

  const leads = await mapWithConcurrency(kept, 4, async (b) => {
    // Per-business social discovery (scored candidates); failures leave it empty.
    let social = { instagram: "", facebook: "", instagramCandidates: [], facebookCandidates: [] };
    try {
      social = await findSocialCandidates({
        businessName: b.business_name,
        website: b.website,
        location,
        apiKey: serperKey,
      });
    } catch {
      /* leave social empty — the lead is still analyzed */
    }
    const evidence = socialEvidenceLevel(social);

    try {
      const ai = await analyzeLead({
        lead: b,
        niche,
        keywords,
        social: { instagram: social.instagram, facebook: social.facebook, evidence },
        apiKey: openaiKey,
        model,
      });
      return assembleLead(b, ai, niche, social);
    } catch {
      return assembleLead(b, null, niche, social);
    }
  });

  leads.sort((a, b) => b["Fit Score"] - a["Fit Score"]);

  return NextResponse.json({
    leads,
    meta: {
      found: businesses.length,
      removedFranchises: businesses.length - kept.length,
      analyzed: leads.length,
    },
  });
}
