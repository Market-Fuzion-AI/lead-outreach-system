import { NextResponse } from "next/server";
import { searchBusinesses, findSocialCandidates } from "../../../lib/serper";
import { analyzeLead } from "../../../lib/openai";
import { buildFranchiseMatchers, isFranchise } from "../../../lib/franchises";
import { buildScore, FALLBACK_MESSAGES, fallbackBusinessRead } from "../../../lib/scoring";

export const runtime = "nodejs";
export const maxDuration = 60; // give the batch time on Vercel

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

// "Recommended Opportunity" — the CSV column keeps one composed string; the UI
// gets the structured offer/first-offer pieces. Robust to a missing AI object.
function composeOpportunity(ai) {
  const offer = (ai?.opportunity_offer || "").trim() || "A simple inquiry-capture and instant follow-up system.";
  const firstOffer = (ai?.opportunity_first_offer || "").trim();
  const text = [
    offer && `Possible offer: ${offer}`,
    firstOffer && `Suggested first offer: ${firstOffer}`,
  ].filter(Boolean).join(" | ");
  return { offer, firstOffer, text: text || "Unknown" };
}

// Build a lead object keyed by the schema COLUMNS, plus camelCase UI-only extras.
// Scoring is unified + robust: AI values where valid, deterministic fallback
// otherwise, so a lead with verified data never scores 0. Missing outreach
// messages and Business Read also get deterministic fallbacks.
function assembleLead(b, ai, niche, social = {}) {
  const noteBits = [];
  if (hasVal(b.rating)) noteBits.push(`${b.rating}★`);
  if (hasVal(b.reviews)) noteBits.push(`${b.reviews} reviews`);
  const publicContext = noteBits.length ? ` (Google: ${noteBits.join(", ")})` : "";

  const trust = trustFrom(b);
  const igCands = social.instagramCandidates || [];
  const fbCands = social.facebookCandidates || [];
  const igConf = social.instagram ? "high" : (igCands[0]?.confidence || "none");
  const fbConf = social.facebook ? "high" : (fbCands[0]?.confidence || "none");
  const evidence = socialEvidenceLevel(social);

  // Unified 10-dimension score (max 100); fills any missing/invalid dimension
  // from verified public data.
  const score = buildScore(ai, b, social);
  const total = score.total;
  const dims = score.dims;
  const sorted = [...dims].sort((a, c) => c.score - a.score);
  const scoreStrong = sorted.slice(0, 3).map((d) => `${d.label} (${d.score}/10)`);
  const scoreWeak = sorted.slice(-2).map((d) => `${d.label} (${d.score}/10)`);

  // Confidence: never below data richness; capped by weak social evidence.
  const aiConf = ai ? Math.max(0, Math.min(5, Math.round(Number(ai.confidence_score) || 0))) : 0;
  let conf = Math.max(aiConf, score.dataConfidence);
  if (evidence === "possible") conf = Math.min(conf, 3);
  else if (evidence === "none") conf = Math.min(conf, 4);
  conf = Math.max(1, Math.min(5, conf));

  const opp = composeOpportunity(ai);
  const businessRead = (ai?.what_matters || "").trim() || fallbackBusinessRead(b, score.signals);
  const msg = (v, fb) => (String(v || "").trim() || fb);

  return {
    "Business Name": b.business_name,
    "Niche": niche,
    "Website": b.website,
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
    "Visible CTA": ai?.visible_cta || "Unknown",
    "Likely Lead Gap": ai?.likely_lead_gap || "Unknown",
    "Likely Follow-Up Gap": ai?.likely_follow_up_gap || "Unknown",
    "Automation Opportunity": opp.text,
    "Fit Score": total,
    "Lead Temperature": temperature(total),
    "Confidence Score": conf,
    "Confidence Explanation": confidenceExplanation(evidence),
    "Recommended Channel": ai?.recommended_channel || "Phone/Text",
    "First Message": msg(ai?.first_message, FALLBACK_MESSAGES.first),
    "Follow-Up 1": msg(ai?.follow_up_1, FALLBACK_MESSAGES.followUp1),
    "Follow-Up 2": msg(ai?.follow_up_2, FALLBACK_MESSAGES.followUp2),
    "Close-The-Loop Message": msg(ai?.close_the_loop, FALLBACK_MESSAGES.closeTheLoop),
    "Status": "New",
    "Approved To Contact": "NO",
    "Notes": `${ai?.notes || ""}${publicContext}`.trim(),
    // camelCase UI-only extras (excluded from CSV):
    rating: b.rating ?? "",
    reviews: b.reviews ?? "",
    category: b.category || "",
    instagramCandidates: igCands,
    facebookCandidates: fbCands,
    socialEvidence: evidence,
    scoreBreakdown: dims,
    scoreStrong,
    scoreWeak,
    scoreSource: score.source,
    opportunity: opp,
    whatMatters: businessRead,
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
