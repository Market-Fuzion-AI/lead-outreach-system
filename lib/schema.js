// Shared, pure functions — safe to import in both server routes and client components.

// The 24 required columns, in order. Lead objects are keyed by these exact labels
// so CSV export and table rendering both read straight from the object.
export const COLUMNS = [
  "Business Name", "Niche", "Website", "Instagram", "Facebook", "Email", "Phone",
  "Location", "Lead Source", "Visible CTA", "Likely Lead Gap", "Likely Follow-Up Gap",
  "Automation Opportunity", "Fit Score", "Lead Temperature", "Confidence Score",
  "Recommended Channel", "First Message", "Follow-Up 1", "Follow-Up 2",
  "Close-The-Loop Message", "Status", "Approved To Contact", "Notes",
];

export const STATUS_OPTIONS = [
  "New", "Researched", "Approved", "Contacted",
  "Replied", "Booked", "Not Fit", "Follow Up Later",
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
