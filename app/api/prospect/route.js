import { NextResponse } from "next/server";
import { searchBusinesses, findSocialCandidates } from "../../../lib/serper";
import { analyzeLead } from "../../../lib/openai";
import { buildFranchiseMatchers, isFranchise } from "../../../lib/franchises";

export const runtime = "nodejs";
export const maxDuration = 60; // give the batch time on Vercel

const SCORE_CAPS = {
  inbound_lead_dependence: 20,
  follow_up_urgency: 20,
  social_channel_fit: 15,
  automation_opportunity_score: 20,
  ability_to_pay: 15,
  personalization_quality: 10,
};

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

const CONF_RANK = { high: 3, medium: 2, low: 1, none: 0 };

// Overall social evidence level, from the best candidate across both platforms.
function socialEvidenceLevel(igCands = [], fbCands = []) {
  const best = Math.max(
    CONF_RANK[igCands[0]?.confidence] || 0,
    CONF_RANK[fbCands[0]?.confidence] || 0
  );
  if (best >= 3) return "high";
  if (best >= 1) return "possible";
  return "none";
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

function socialMatchNotes(igCands = [], fbCands = []) {
  const line = (label, cands) => {
    const c = cands[0];
    return c ? `${label}: ${c.confidence} (${c.matchReason})` : `${label}: no candidate found`;
  };
  return `${line("Instagram", igCands)}. ${line("Facebook", fbCands)}.`;
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
function scoreBreakdown(ai) {
  return [
    { label: "Inbound Lead Dependence", score: clampInt(ai.inbound_lead_dependence, SCORE_CAPS.inbound_lead_dependence), max: SCORE_CAPS.inbound_lead_dependence },
    { label: "Follow-Up Urgency", score: clampInt(ai.follow_up_urgency, SCORE_CAPS.follow_up_urgency), max: SCORE_CAPS.follow_up_urgency },
    { label: "Social Channel Fit", score: clampInt(ai.social_channel_fit, SCORE_CAPS.social_channel_fit), max: SCORE_CAPS.social_channel_fit },
    { label: "Automation Opportunity", score: clampInt(ai.automation_opportunity_score, SCORE_CAPS.automation_opportunity_score), max: SCORE_CAPS.automation_opportunity_score },
    { label: "Ability to Pay", score: clampInt(ai.ability_to_pay, SCORE_CAPS.ability_to_pay), max: SCORE_CAPS.ability_to_pay },
    { label: "Personalization Quality", score: clampInt(ai.personalization_quality, SCORE_CAPS.personalization_quality), max: SCORE_CAPS.personalization_quality },
  ];
}

// Plain-English "why this score" grounded in the actual sub-scores.
function scoreWhy(breakdown) {
  const byPct = [...breakdown].sort((a, b) => b.score / b.max - a.score / a.max);
  const top = byPct.slice(0, 2).map((x) => `${x.label} (${x.score}/${x.max})`);
  const low = byPct[byPct.length - 1];
  return `Strongest signals: ${top.join(" and ")}. Weakest: ${low.label} (${low.score}/${low.max}). AI estimate from public data — verify before outreach.`;
}

// Build a lead object keyed by the schema COLUMNS, plus camelCase UI-only extras
// (rating/reviews/category/scoreBreakdown/social match details) that never hit CSV.
function assembleLead(b, ai, niche, social = {}) {
  const noteBits = [];
  if (hasVal(b.rating)) noteBits.push(`${b.rating}★`);
  if (hasVal(b.reviews)) noteBits.push(`${b.reviews} reviews`);
  const publicContext = noteBits.length ? ` (Google: ${noteBits.join(", ")})` : "";

  const trust = trustFrom(b);
  const igCands = social.instagramCandidates || [];
  const fbCands = social.facebookCandidates || [];
  const igConf = igCands[0]?.confidence || "none";
  const fbConf = fbCands[0]?.confidence || "none";
  const evidence = socialEvidenceLevel(igCands, fbCands);

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
    "Social Match Notes": socialMatchNotes(igCands, fbCands),
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
    };
  }

  const breakdown = scoreBreakdown(ai);
  const total = breakdown.reduce((sum, x) => sum + x.score, 0);

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
    "Automation Opportunity": ai.automation_opportunity || "Unknown",
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
    const evidence = socialEvidenceLevel(social.instagramCandidates, social.facebookCandidates);

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
