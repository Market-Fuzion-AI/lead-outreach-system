// Serper.dev discovery. Server-side only (uses the secret key).
//
// Two responsibilities:
//   1) searchBusinesses()      — local business data via the "places" endpoint,
//      driven by specific keyword phrases (falls back to the broad category).
//   2) findSocialCandidates()  — per-business Instagram/Facebook lookup that
//      scores each result and only promotes a "main" link on strong evidence.
//
// The social matcher is deliberately conservative: generic business words never
// justify a match on their own, so we don't glue the wrong profile to a lead.

const PLACES_URL = "https://google.serper.dev/places";
const SEARCH_URL = "https://google.serper.dev/search";

// Generic business terms that must NOT, on their own, justify a social match.
const STOPWORDS = new Set([
  "fitness", "training", "personal", "gym", "yoga", "coach", "coaching",
  "wellness", "health", "studio", "strength", "performance", "llc", "inc",
  "co", "the", "and", "for", "services", "service", "group", "company", "near",
]);

async function serper(url, q, apiKey) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Serper request failed (${res.status}). ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ---- text helpers ----
const normalize = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
const alnum = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const tokenize = (s) => normalize(s).split(" ").filter((w) => w.length > 2);
// Distinctive = tokens that survive stopword + length filtering.
const distinctiveTokens = (name) =>
  [...new Set(tokenize(name).filter((t) => !STOPWORDS.has(t)))];

function domainCore(website) {
  if (!website) return "";
  try {
    const host = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname;
    const parts = host.replace(/^www\./, "").split(".");
    return (parts.length >= 2 ? parts[parts.length - 2] : parts[0]) || "";
  } catch {
    return "";
  }
}

const cityOf = (location) => (String(location || "").split(",")[0] || "").trim();

function normalizePlace(p, fallbackLocation) {
  return {
    business_name: p.title || "",
    website: p.website || "",
    phone: p.phoneNumber || p.phone || "",
    address: p.address || fallbackLocation || "",
    rating: p.rating ?? "",
    reviews: p.ratingCount ?? p.reviews ?? "",
    category: p.category || (Array.isArray(p.types) ? p.types.join(", ") : "") || "",
    hours: p.openingHours ? "see listing" : "",
    maps_link: p.cid ? `https://www.google.com/maps?cid=${p.cid}` : "",
  };
}

// ------------------------------------------------------------------ //
// 1) Business discovery — combine category + specific keywords.       //
// ------------------------------------------------------------------ //
export async function searchBusinesses({ category, keywords, location, maxResults, apiKey }) {
  const kw = (Array.isArray(keywords) ? keywords : String(keywords || "").split(","))
    .map((s) => String(s).trim())
    .filter(Boolean);

  // Keywords, when given, are the precise search phrases. Otherwise search the
  // broad category with two phrasings. Cap keyword queries to bound API calls.
  const queries = kw.length
    ? kw.slice(0, 8).map((k) => `${k} ${location}`)
    : [`${category} ${location}`, `${category} near ${location}`];

  const responses = await Promise.all(queries.map((q) => serper(PLACES_URL, q, apiKey)));
  const rawPlaces = responses.flatMap((r) => r.places || []);

  // Dedupe by name + phone + website domain (whatever is available).
  const seen = new Set();
  const places = [];
  for (const p of rawPlaces) {
    const name = (p.title || "").toLowerCase().trim();
    if (!name) continue;
    const phone = (p.phoneNumber || p.phone || "").replace(/\D/g, "");
    const site = domainCore(p.website || "");
    const key = [name, phone, site].filter(Boolean).join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    places.push(normalizePlace(p, location));
  }

  return places.slice(0, maxResults);
}

// ------------------------------------------------------------------ //
// 2) Social matching — score one result against a specific business.  //
// ------------------------------------------------------------------ //
const RANK = { high: 3, medium: 2, low: 1 };

function evaluateCandidate(r, name, website, city, platformHost) {
  const url = r.link || "";
  if (!url.toLowerCase().includes(platformHost)) return null;

  const hay = `${r.title || ""} ${r.snippet || ""} ${url}`;
  const hayNorm = normalize(hay);
  const hayAlnum = alnum(hay);
  const hayTokens = new Set(tokenize(hay));

  const distName = distinctiveTokens(name);
  const shared = distName.filter((t) => hayTokens.has(t));

  const domain = domainCore(website);
  const domainMatch = domain.length >= 4 && !STOPWORDS.has(domain) && hayAlnum.includes(domain);

  const nameNorm = normalize(name);
  const exactNameMatch = distName.length >= 1 && nameNorm.length >= 4 && hayNorm.includes(nameNorm);

  const cityTokens = tokenize(city);
  const locationMatch = cityTokens.length > 0 && cityTokens.some((t) => hayTokens.has(t));

  let confidence;
  if (domainMatch || exactNameMatch || (shared.length >= 2 && locationMatch)) confidence = "high";
  else if (shared.length >= 2 || (shared.length >= 1 && locationMatch)) confidence = "medium";
  else if (shared.length >= 1) confidence = "low";
  else return null; // no distinctive overlap at all — discard

  const reasons = [];
  if (exactNameMatch) reasons.push("exact business name appears in result");
  if (domainMatch) reasons.push("website domain appears in result");
  if (shared.length) reasons.push(`shared distinctive terms: ${shared.join(", ")}`);
  if (locationMatch) reasons.push("city appears in result");

  return {
    url,
    title: r.title || "",
    snippet: r.snippet || "",
    confidence,
    matchReason: reasons.join("; ") || "weak signal",
    sharedDistinctiveTerms: shared,
  };
}

function buildCandidates(results, name, website, city, platformHost) {
  const cands = [];
  for (const r of results) {
    const c = evaluateCandidate(r, name, website, city, platformHost);
    if (c) cands.push(c);
  }
  cands.sort(
    (a, b) =>
      RANK[b.confidence] - RANK[a.confidence] ||
      b.sharedDistinctiveTerms.length - a.sharedDistinctiveTerms.length
  );
  const seen = new Set();
  const out = [];
  for (const c of cands) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  return out.slice(0, 3);
}

// Per-business social discovery. Searches Instagram/Facebook scoped to THIS
// business + city, then returns scored candidates. The "main" link is set only
// when the top candidate is high-confidence — never on a guess.
export async function findSocialCandidates({ businessName, website, location, apiKey }) {
  const city = cityOf(location);
  const q = `${businessName}${city ? ` ${city}` : ""}`.trim();

  const [ig, fb] = await Promise.all([
    serper(SEARCH_URL, `site:instagram.com ${q}`, apiKey),
    serper(SEARCH_URL, `site:facebook.com ${q}`, apiKey),
  ]);

  const instagramCandidates = buildCandidates(ig.organic || [], businessName, website, city, "instagram.com");
  const facebookCandidates = buildCandidates(fb.organic || [], businessName, website, city, "facebook.com");

  return {
    instagram: instagramCandidates[0]?.confidence === "high" ? instagramCandidates[0].url : "",
    facebook: facebookCandidates[0]?.confidence === "high" ? facebookCandidates[0].url : "",
    instagramCandidates,
    facebookCandidates,
  };
}
