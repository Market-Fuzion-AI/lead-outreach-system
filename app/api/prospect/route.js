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

// Build a 24-column lead object from raw business + AI result.
function assembleLead(b, ai, niche) {
  const noteBits = [];
  if (b.rating) noteBits.push(`${b.rating}★`);
  if (b.reviews) noteBits.push(`${b.reviews} reviews`);
  const publicContext = noteBits.length ? ` (Google: ${noteBits.join(", ")})` : "";

  if (!ai) {
    return {
      "Business Name": b.business_name, "Niche": niche, "Website": b.website,
      "Instagram": b.instagram_url || "", "Facebook": b.facebook_url || "",
      "Email": "", "Phone": b.phone,
      "Location": b.address, "Lead Source": "Serper.dev (Google)",
      "Visible CTA": "Unknown", "Likely Lead Gap": "Unknown",
      "Likely Follow-Up Gap": "Unknown", "Automation Opportunity": "Unknown",
      "Fit Score": 0, "Lead Temperature": "Skip", "Confidence Score": 1,
      "Recommended Channel": "Phone/Text", "First Message": "", "Follow-Up 1": "",
      "Follow-Up 2": "", "Close-The-Loop Message": "", "Status": "Researched",
      "Approved To Contact": "NO",
      "Notes": `AI analysis failed — retry this lead.${publicContext}`,
    };
  }

  const total =
    clampInt(ai.inbound_lead_dependence, SCORE_CAPS.inbound_lead_dependence) +
    clampInt(ai.follow_up_urgency, SCORE_CAPS.follow_up_urgency) +
    clampInt(ai.social_channel_fit, SCORE_CAPS.social_channel_fit) +
    clampInt(ai.automation_opportunity_score, SCORE_CAPS.automation_opportunity_score) +
    clampInt(ai.ability_to_pay, SCORE_CAPS.ability_to_pay) +
    clampInt(ai.personalization_quality, SCORE_CAPS.personalization_quality);

  const conf = Math.max(1, Math.min(5, Math.round(Number(ai.confidence_score) || 1)));

  return {
    "Business Name": b.business_name,
    "Niche": niche,
    "Website": b.website,
    "Instagram": b.instagram_url || "",
    "Facebook": b.facebook_url || "",
    "Email": "",
    "Phone": b.phone,
    "Location": b.address,
    "Lead Source": "Serper.dev (Google)",
    "Visible CTA": ai.visible_cta || "Unknown",
    "Likely Lead Gap": ai.likely_lead_gap || "Unknown",
    "Likely Follow-Up Gap": ai.likely_follow_up_gap || "Unknown",
    "Automation Opportunity": ai.automation_opportunity || "Unknown",
    "Fit Score": total,
    "Lead Temperature": temperature(total),
    "Confidence Score": conf,
    "Recommended Channel": ai.recommended_channel || "Phone/Text",
    "First Message": ai.first_message || "",
    "Follow-Up 1": ai.follow_up_1 || "",
    "Follow-Up 2": ai.follow_up_2 || "",
    "Close-The-Loop Message": ai.close_the_loop || "",
    "Status": "Researched",
    "Approved To Contact": "NO",
    "Notes": `${ai.notes || ""}${publicContext}`.trim(),
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
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
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
