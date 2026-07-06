// Shared, pure functions — safe to import in both server routes and client components.

// The required columns, in order. Lead objects are keyed by these exact labels
// so CSV export and table rendering both read straight from the object.
// The trailing six are trust/evidence columns added in v2 (appended so existing
// column positions stay stable for anyone re-importing into the same sheet).
export const COLUMNS = [
  "Business Name", "Niche", "Website", "Instagram", "Facebook", "Email", "Phone",
  "Location", "Lead Source", "Visible CTA", "Likely Lead Gap", "Likely Follow-Up Gap",
  "Automation Opportunity", "Fit Score", "Lead Temperature", "Confidence Score",
  "Recommended Channel", "First Message", "Follow-Up 1", "Follow-Up 2",
  "Close-The-Loop Message", "Status", "Approved To Contact", "Notes",
  "Trust Level", "Evidence Summary", "Confidence Explanation", "Human Review Needed",
  "Possible Instagram Match", "Possible Facebook Match",
  "Instagram Match Confidence", "Facebook Match Confidence",
  "Instagram Candidate Links", "Facebook Candidate Links", "Social Match Notes",
];

// Pipeline stages, in order. New leads default to "New".
export const STATUS_OPTIONS = [
  "New", "Reviewing", "Ready to Contact", "Contacted",
  "Follow-Up Needed", "Booked Call", "Not a Fit",
];

// Escape one CSV field: wrap in quotes if it contains a comma, quote, or newline.
function csvEscape(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Build a Google-Sheets-friendly CSV string from an array of lead objects.
export function toCSV(leads) {
  const header = COLUMNS.map(csvEscape).join(",");
  const rows = leads.map((l) => COLUMNS.map((c) => csvEscape(l[c])).join(","));
  return [header, ...rows].join("\r\n");
}
