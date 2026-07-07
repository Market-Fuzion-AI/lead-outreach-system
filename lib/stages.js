// Pure stage-mapping helpers for the future stage-based workflow (Research →
// Review → Ready to Contact → Pipeline → Client/Delivery, with Archive off to
// the side). No Firebase, no browser APIs, no secrets — safe to import anywhere
// and to unit-test. This is foundation only; nothing is wired into the UI yet.

export const STAGES = [
  "Research",          // finding businesses (no saved status yet)
  "Review",            // qualify / decide if worth contacting
  "Ready to Contact",  // the outreach action queue
  "Pipeline",          // active sales conversations
  "Client / Delivery", // won / delivering
  "Archive",           // out of the active workflow
];

// Lead status -> workflow stage. "Research" has no status because those leads
// aren't saved yet. "Approved" is a legacy status treated as Ready to Contact.
export const STATUS_TO_STAGE = {
  "New": "Review",
  "Reviewing": "Review",
  "Approved": "Ready to Contact", // legacy alias
  "Ready to Contact": "Ready to Contact",
  "Contacted": "Pipeline",
  "Follow-Up Needed": "Pipeline",
  "Booked Call": "Pipeline",
  "Proposal Sent": "Pipeline",
  "Won": "Client / Delivery",
  "In Delivery": "Client / Delivery",
  "Delivered": "Client / Delivery",
  "Not a Fit": "Archive",
  "Not Interested": "Archive",
  "No Response": "Archive",
  "Duplicate": "Archive",
  "Wrong Match": "Archive",
  "Do Not Contact": "Archive",
};

// Unknown / blank / future status falls back to Review so a lead never
// disappears from the workflow.
const DEFAULT_STAGE = "Review";

export function getStageForStatus(status) {
  return STATUS_TO_STAGE[status] || DEFAULT_STAGE;
}

export const isReviewStatus = (status) => getStageForStatus(status) === "Review";
export const isReadyToContactStatus = (status) => getStageForStatus(status) === "Ready to Contact";
export const isPipelineStatus = (status) => getStageForStatus(status) === "Pipeline";
export const isClientStatus = (status) => getStageForStatus(status) === "Client / Delivery";
export const isArchiveStatus = (status) => getStageForStatus(status) === "Archive";

// All statuses that belong to a given stage — handy for future tab filtering.
export function statusesForStage(stage) {
  return Object.keys(STATUS_TO_STAGE).filter((s) => STATUS_TO_STAGE[s] === stage);
}
