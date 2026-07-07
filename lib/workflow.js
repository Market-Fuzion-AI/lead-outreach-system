// Pure browser-workflow helpers: stable lead identity + merging saved state.
// No DOM/localStorage access here, so this is unit-testable and reusable.
// (The thin localStorage read/write wrappers live in the client component.)

export const temperatureFromScore = (s) =>
  s >= 80 ? "Hot Lead" : s >= 60 ? "Good Lead" : s >= 40 ? "Maybe" : "Skip";

const extUrl = (u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

export function domainOf(website) {
  if (!website) return "";
  try {
    const h = new URL(extUrl(website)).hostname.replace(/^www\./, "");
    const p = h.split(".");
    return (p.length >= 2 ? p[p.length - 2] : p[0]) || "";
  } catch { return ""; }
}

// Stable identity for a lead across searches: normalized name + phone + website
// domain + city (whatever is available). No sensitive data beyond the lead itself.
export function leadKey(lead) {
  const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const name = norm(lead["Business Name"]);
  const phone = String(lead["Phone"] || "").replace(/\D/g, "");
  const domain = domainOf(lead["Website"]);
  const city = norm(String(lead["Location"] || "").split(",")[0]);
  return [name, phone, domain, city].filter(Boolean).join("|");
}

// Merge saved workflow state (status/approved/favorite/notes + a sticky score)
// back into fresh search results, keyed by lead identity. Returns the merged
// leads and the (possibly updated) saved map to persist.
export function mergeSaved(rawLeads, saved) {
  const next = { ...saved };
  const merged = rawLeads.map((l) => {
    const key = leadKey(l);
    const s = next[key] || {};
    let score = l["Fit Score"];
    if (typeof s.score === "number") score = s.score;   // reuse previous score for stability
    else next[key] = { ...s, score };                    // first sighting: remember this score
    return {
      ...l,
      _key: key,
      "Fit Score": score,
      "Lead Temperature": temperatureFromScore(score),
      "Status": s.status || l["Status"],
      "Approved To Contact": ("approved" in s) ? (s.approved ? "YES" : "NO") : l["Approved To Contact"],
      favorite: !!s.favorite,
      notes: s.notes || "",
    };
  });
  return { merged, next };
}
