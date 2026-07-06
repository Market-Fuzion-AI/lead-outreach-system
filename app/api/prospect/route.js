import { NextResponse } from "next/server";
import { searchLocalBusinesses } from "../../../lib/serper";
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
  if (hasVal(b.instagram_url)) ev.push("Instagram (possible)");
  if (hasVal(b.facebook_url)) ev.push("Facebook (possible)");

  return { level, summary: ev.join(", ") || "Limited public data" };
}

// A human-readable "possible match" line for CSV — never claims "official".
function possibleMatchText(url, match) {
  if (!hasVal(url)) return "No confident match found";
  const shared = match && Array.isArray(match.shared) ? match.shared : [];
  const strength = match && match.strength === "strong" ? "strong possible match" : "possible match";
  return shared.length
    ? `${url} (${strength}; shared terms: ${shared.join(", ")})`
    : `${url} (${strength})`;
}

function confidenceExplanation(hasIG, hasFB) {
  if (!hasIG && !hasFB) {
    return "Lower confidence because social profiles were not confidently matched. Based on public business data and website presence only.";
  }
  return "Confidence is based on available public business data, website presence, and social match quality.";
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
function assembleLead(b, ai, niche) {
  const noteBits = [];
  if (hasVal(b.rating)) noteBits.push(`${b.rating}★`);
  if (hasVal(b.reviews)) noteBits.push(`${b.reviews} reviews`);
  const publicContext = noteBits.length ? ` (Google: ${noteBits.join(", ")})` : "";

  const trust = trustFrom(b);
  const hasIG = hasVal(b.instagram_url);
  const hasFB = hasVal(b.facebook_url);

  // Verified fields + trust columns shared by both the success and failure paths.
  const base = {
    "Business Name": b.business_name,
    "Niche": niche,
    "Website": b.website,
    "Instagram": b.instagram_url || "",
    "Facebook": b.facebook_url || "",
    "Email": "",
    "Phone": b.phone,
    "Location": b.address,
    "Lead Source": "Serper.dev (Google)",
    "Trust Level": trust.level,
    "Evidence Summary": trust.summary,
    "Human Review Needed": "YES",
    "Possible Instagram Match": possibleMatchText(b.instagram_url, b.instagram_match),
    "Possible Facebook Match": possibleMatchText(b.facebook_url, b.facebook_match),
    // camelCase UI-only extras (not in COLUMNS, so excluded from CSV):
    rating: b.rating ?? "",
    reviews: b.reviews ?? "",
    category: b.category || "",
    igMatch: b.instagram_match || null,
    fbMatch: b.facebook_match || null,
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
      "Status": "Researched",
      "Approved To Contact": "NO",
      "Notes": `AI analysis failed — retry this lead.${publicContext}`,
      scoreBreakdown: [],
      scoreWhy: "Not scored — AI analysis failed. Re-run to generate a score.",
    };
  }

  const breakdown = scoreBreakdown(ai);
  const total = breakdown.reduce((sum, x) => sum + x.score, 0);
  const conf = Math.max(1, Math.min(5, Math.round(Number(ai.confidence_score) || 1)));

  return {
    ...base,
    "Visible CTA": ai.visible_cta || "Unknown",
    "Likely Lead Gap": ai.likely_lead_gap || "Unknown",
    "Likely Follow-Up Gap": ai.likely_follow_up_gap || "Unknown",
    "Automation Opportunity": ai.automation_opportunity || "Unknown",
    "Fit Score": total,
    "Lead Temperature": temperature(total),
    "Confidence Score": conf,
    "Confidence Explanation": confidenceExplanation(hasIG, hasFB),
    "Recommended Channel": ai.recommended_channel || "Phone/Text",
    "First Message": ai.first_message || "",
    "Follow-Up 1": ai.follow_up_1 || "",
    "Follow-Up 2": ai.follow_up_2 || "",
    "Close-The-Loop Message": ai.close_the_loop || "",
    "Status": "Researched",
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

  const niche = String(body.niche || "").trim();
  const location = String(body.location || "").trim();
  const maxResults = Math.max(1, Math.min(40, Number(body.maxResults) || 20));
  const excludedFranchises = Array.isArray(body.excludedFranchises)
    ? body.excludedFranchises
    : String(body.excludedFranchises || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

  if (!niche || !location) {
    return NextResponse.json(
      { error: "Both niche and location are required." },
      { status: 400 }
    );
  }

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
    businesses = await searchLocalBusinesses({ niche, location, maxResults, apiKey: serperKey });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }

  const matchers = buildFranchiseMatchers(excludedFranchises);
  const kept = businesses.filter((b) => !isFranchise(b.business_name, matchers));

  const leads = await mapWithConcurrency(kept, 4, async (b) => {
    try {
      const ai = await analyzeLead({ lead: b, niche, apiKey: openaiKey, model });
      return assembleLead(b, ai, niche);
    } catch {
      return assembleLead(b, null, niche);
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
