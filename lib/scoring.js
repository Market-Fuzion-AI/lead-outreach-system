// Unified lead qualification. Exactly 10 dimensions, each 0-10, total = sum
// (max 100). Robust to missing/invalid AI output: any dimension the model
// doesn't give us is filled deterministically from verified public data, so a
// lead with real data never scores 0. Shared by the prompt, parser, and UI.

export const SCORE_DIMENSIONS = [
  { key: "lead_capture_need", label: "Lead Capture Need" },
  { key: "follow_up_risk", label: "Follow-Up Risk" },
  { key: "automation_fit", label: "Automation Fit" },
  { key: "contactability", label: "Contactability" },
  { key: "local_service_fit", label: "Local Service Fit" },
  { key: "offer_fit", label: "Offer Fit" },
  { key: "ability_to_pay", label: "Ability to Pay" },
  { key: "public_demand_signals", label: "Public Demand Signals" },
  { key: "personalization_quality", label: "Personalization Quality" },
  { key: "channel_confidence", label: "Channel Confidence" },
];

const clamp10 = (n) => Math.max(0, Math.min(10, n));
const num = (v) => { const n = parseFloat(String(v)); return Number.isFinite(n) ? n : 0; };

// Coerce an AI value to a 0-10 int, or null if unusable (missing/invalid).
export function coerceScore(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return null;
  return clamp10(Math.round(n));
}

// Verified-data signals used for deterministic fallback scoring.
export function leadSignals(b = {}, social = {}) {
  const reviewCount = num(b.reviews);
  const ratingVal = num(b.rating);
  const hasIG = !!social.instagram;   // high-confidence main profile/page only
  const hasFB = !!social.facebook;
  const hasSocialCand = ((social.instagramCandidates || []).length + (social.facebookCandidates || []).length) > 0;
  const reviewTier = reviewCount >= 1000 ? 4 : reviewCount >= 200 ? 3 : reviewCount >= 50 ? 2 : reviewCount >= 10 ? 1 : 0;
  return {
    hasWebsite: !!b.website,
    hasPhone: !!b.phone,
    hasRating: ratingVal > 0,
    hasReviews: reviewCount > 0,
    hasCategory: !!b.category,
    hasIG, hasFB, hasSocialCand,
    ratingVal, reviewCount, reviewTier,
  };
}

// Deterministic 0-10 per dimension from verified public data. Bases are kept low
// so a lead with almost no verified data scores near 0, while a data-rich lead
// (website + phone + rating/reviews + social) scores high.
function fallbackDim(key, s) {
  const socialAny = s.hasIG || s.hasFB || s.hasSocialCand;
  switch (key) {
    case "lead_capture_need":
      return clamp10(2 + (s.hasWebsite ? 3 : 0) + (s.hasPhone ? 2 : 0) + (socialAny ? 2 : 0) + (s.reviewCount > 50 ? 1 : 0));
    case "follow_up_risk":
      return clamp10(2 + (s.hasWebsite ? 3 : 0) + (s.hasPhone ? 2 : 0) + (socialAny ? 2 : 0) + (s.reviewCount > 100 ? 1 : 0));
    case "automation_fit":
      return clamp10(2 + (s.hasWebsite ? 3 : 0) + (s.hasPhone ? 2 : 0) + (socialAny ? 1 : 0) + (s.hasCategory ? 1 : 0));
    case "contactability":
      return clamp10((s.hasWebsite ? 3 : 0) + (s.hasPhone ? 3 : 0) + (s.hasIG ? 2 : 0) + (s.hasFB ? 2 : 0));
    case "local_service_fit":
      return clamp10(2 + (s.hasPhone ? 2 : 0) + (s.hasWebsite ? 2 : 0) + (s.hasCategory ? 2 : 0) + (s.hasReviews ? 2 : 0));
    case "offer_fit":
      return clamp10(2 + (s.hasWebsite ? 3 : 0) + (s.hasPhone ? 1 : 0) + (socialAny ? 1 : 0) + (s.hasReviews ? 2 : 0) + (s.hasCategory ? 1 : 0));
    case "ability_to_pay":
      return clamp10(1 + (s.hasWebsite ? 2 : 0) + (s.ratingVal >= 4 ? 1 : 0) + s.reviewTier + (s.reviewTier >= 3 ? 1 : 0));
    case "public_demand_signals":
      return clamp10(1 + s.reviewTier + (s.hasWebsite ? 2 : 0) + ((s.hasIG || s.hasFB) ? 2 : 0) + (s.ratingVal >= 4.5 ? 1 : 0));
    case "personalization_quality":
      return clamp10(1 + (s.hasWebsite ? 1 : 0) + (s.hasPhone ? 1 : 0) + (s.hasRating ? 1 : 0) + (s.hasReviews ? 1 : 0) + (s.hasCategory ? 1 : 0) + ((s.hasIG || s.hasFB) ? 1 : 0));
    case "channel_confidence":
      return clamp10(1 + (s.hasWebsite ? 2 : 0) + (s.hasPhone ? 2 : 0) + ((s.hasIG || s.hasFB) ? 3 : 0) + (s.hasWebsite && s.hasPhone ? 1 : 0));
    default:
      return 5;
  }
}

// Build the 10-dimension score. AI values fill where valid; missing/invalid
// dimensions fall back to deterministic values. Returns dims, total, source,
// dataConfidence, and the raw signals.
export function buildScore(ai, b, social) {
  const s = leadSignals(b, social);
  let aiValid = 0;
  const dims = SCORE_DIMENSIONS.map((d) => {
    const c = ai ? coerceScore(ai[d.key]) : null;
    if (c !== null) { aiValid += 1; return { key: d.key, label: d.label, score: c, max: 10 }; }
    return { key: d.key, label: d.label, score: fallbackDim(d.key, s), max: 10 };
  });
  const total = dims.reduce((sum, x) => sum + x.score, 0);
  const source = aiValid >= 5 ? "AI scored" : "Directional";
  // Confidence 1-5 from data richness (floors the displayed confidence).
  const points = [s.hasWebsite, s.hasPhone, s.hasRating, s.hasReviews, s.hasCategory, s.hasIG || s.hasFB].filter(Boolean).length;
  const dataConfidence = Math.max(1, Math.min(5, Math.round((points * 5) / 6)));
  return { dims, total, source, dataConfidence, signals: s };
}

export const FALLBACK_MESSAGES = {
  first: "Quick question. Do you already have a simple way to follow up when someone reaches out through your website, phone, or social pages?",
  followUp1: "Wanted to check back on this. A simple follow-up flow can help make sure new inquiries do not get lost between the website, phone, and social pages.",
  followUp2: "Happy to show you a simple version that captures inquiries, asks a couple of quick questions, and points people to the right next step.",
  closeTheLoop: "Totally understand if this is not a priority right now. I'll close the loop here. Thought it might be useful since missed follow-up is easy to overlook until leads start slipping.",
};

const cityFrom = (addr) => String(addr || "").split(",")[0].trim();

// Deterministic "Business Read" when the model doesn't provide one.
export function fallbackBusinessRead(b = {}, s) {
  const name = b.business_name || "This business";
  const cat = b.category ? String(b.category).toLowerCase() : "local service";
  const city = cityFrom(b.address);
  const out = [`${name} appears to be a ${cat} business${city ? ` in ${city}` : ""}.`];
  if (s.hasReviews) {
    out.push(`Public signals look ${s.reviewCount >= 200 ? "strong" : "present"}, with around ${b.reviews} reviews${s.hasRating ? ` at ${b.rating}★` : ""}, which likely means steady inbound interest.`);
  }
  const channels = [s.hasWebsite && "a website", s.hasPhone && "phone", (s.hasIG || s.hasFB) && "social profiles"].filter(Boolean);
  if (channels.length) {
    out.push(`Customers likely reach them through ${channels.join(", ")}, so inquiries may arrive from a few different places.`);
  }
  out.push("A simple inquiry-capture and instant follow-up flow may help make sure those leads don't slip through. Based on public data.");
  return out.join(" ");
}
