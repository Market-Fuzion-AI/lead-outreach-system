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

// Merge previously-saved workflow state (status/approved/favorite/notes + the
// score at save time) back into fresh search results, keyed by lead identity.
// Only SAVED leads (ones the user acted on) carry state and a sticky score;
// untouched leads pass through unchanged and are flagged _saved: false.
export function mergeSaved(rawLeads, saved) {
  const merged = rawLeads.map((l) => {
    const key = leadKey(l);
    const s = saved[key];
    if (!s) return { ...l, _key: key, _saved: false, favorite: false, notes: "" };
    const score = typeof s.score === "number" ? s.score : l["Fit Score"];
    return {
      ...l,
      _key: key,
      _saved: true,
      "Fit Score": score,
      "Lead Temperature": temperatureFromScore(score),
      "Status": s.status || l["Status"],
      "Approved To Contact": s.approved ? "YES" : "NO",
      favorite: !!s.favorite,
      notes: s.notes || "",
    };
  });
  return { merged };
}
