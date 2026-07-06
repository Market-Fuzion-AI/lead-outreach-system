// Franchise / big-chain filtering. We prefer owner-led, independent businesses.

const BUILTIN_FRANCHISES = [
  "orangetheory", "planet fitness", "la fitness", "anytime fitness",
  "gold's gym", "golds gym", "crunch fitness", "24 hour fitness", "f45",
  "snap fitness", "ymca", "lifetime fitness", "life time", "equinox",
  "supercuts", "great clips", "sport clips", "european wax", "massage envy",
  "the joint chiropractic", "amazing lash", "club pilates", "burn boot camp",
  "9round", "title boxing", "kumon", "sylvan learning", "mathnasium",
];

// Build a lowercase matcher list from built-ins + the user's excluded brands.
export function buildFranchiseMatchers(excluded = []) {
  const userTerms = (excluded || [])
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);
  return [...BUILTIN_FRANCHISES, ...userTerms];
}

// True if the business name contains any franchise term.
export function isFranchise(name, matchers) {
  const n = String(name || "").toLowerCase();
  return matchers.some((term) => term && n.includes(term));
}
