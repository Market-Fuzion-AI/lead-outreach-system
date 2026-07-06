// Serper.dev local business discovery. Server-side only (uses the secret key).
//
// Strategy:
//   - Google "places" endpoint for the two local queries -> structured business
//     data (phone, website, rating, category). This is the primary lead source.
//   - Google "search" endpoint for site:instagram.com / site:facebook.com ->
//     social profile links, attached to a lead ONLY on a confident name match.

const PLACES_URL = "https://google.serper.dev/places";
const SEARCH_URL = "https://google.serper.dev/search";

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
    instagram_url: "",
    facebook_url: "",
    // Populated by attachSocial() only on a confident name match.
    instagram_match: null, // { shared: string[], strength: "possible" | "strong" }
    facebook_match: null,
  };
}

// Distinctive tokens from a business name (drop short/common words).
function tokens(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 2);
}

// Attach a social link only when the result clearly matches the business name
// (>= 2 shared distinctive tokens). Conservative on purpose — no wrong socials.
// Records WHY it matched (the shared tokens) and a strength, so the UI can label
// it a "possible" vs "strong possible" match — never "official".
function attachSocial(place, socialResults, urlField, matchField) {
  const nameTokens = new Set(tokens(place.business_name));
  if (nameTokens.size === 0) return;
  for (const r of socialResults) {
    const hay = `${r.title || ""} ${r.link || ""}`;
    const rt = tokens(hay);
    const shared = [...new Set(rt.filter((t) => nameTokens.has(t)))];
    if (shared.length >= 2) {
      place[urlField] = r.link || "";
      place[matchField] = {
        shared,
        strength: shared.length >= 3 ? "strong" : "possible",
      };
      return;
    }
  }
}

export async function searchLocalBusinesses({ niche, location, maxResults, apiKey }) {
  // 1) Local business data (two phrasings, then dedupe)
  const [a, b] = await Promise.all([
    serper(PLACES_URL, `${niche} ${location}`, apiKey),
    serper(PLACES_URL, `${niche} near ${location}`, apiKey),
  ]);
  const rawPlaces = [...(a.places || []), ...(b.places || [])];

  const seen = new Set();
  const places = [];
  for (const p of rawPlaces) {
    const key = `${(p.title || "").toLowerCase()}|${p.phoneNumber || p.cid || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    places.push(normalizePlace(p, location));
  }

  // 2) Social discovery (best-effort, matched by name)
  const [ig, fb] = await Promise.all([
    serper(SEARCH_URL, `site:instagram.com ${niche} ${location}`, apiKey),
    serper(SEARCH_URL, `site:facebook.com ${niche} ${location}`, apiKey),
  ]);
  const igResults = ig.organic || [];
  const fbResults = fb.organic || [];
  for (const place of places) {
    attachSocial(place, igResults, "instagram_url", "instagram_match");
    attachSocial(place, fbResults, "facebook_url", "facebook_match");
  }

  return places.slice(0, maxResults);
}
