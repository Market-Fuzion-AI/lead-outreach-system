// Firebase client helper. Uses ONLY public NEXT_PUBLIC_FIREBASE_* config —
// Serper/OpenAI keys stay server-side and never touch this file.
//
// If the config is absent (e.g. local dev without Firebase set up), the app
// degrades gracefully to browser-only localStorage persistence.

import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import {
  getFirestore, collection, doc, getDocs, setDoc, serverTimestamp,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId
);

let auth = null;
let db = null;
let googleProvider = null;

if (isFirebaseConfigured) {
  try {
    const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    googleProvider = new GoogleAuthProvider();
  } catch {
    // Leave nulls — the app falls back to local-only mode.
  }
}

export { auth, db, googleProvider };

const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const clean = (v, fallback = "") => (v === undefined || v === null ? fallback : v);

// Map an in-memory lead to the Firestore document shape (public info + user state).
function leadToDoc(lead) {
  const opp = lead.opportunity || {};
  return {
    leadKey: lead._key || "",
    businessName: clean(lead["Business Name"]),
    normalizedName: norm(lead["Business Name"]),
    category: clean(lead.category || lead["Niche"]),
    location: clean(lead["Location"]),
    phone: clean(lead["Phone"]),
    website: clean(lead["Website"]),
    instagram: clean(lead["Instagram"]),
    facebook: clean(lead["Facebook"]),
    email: clean(lead["Email"]),
    rating: clean(lead.rating),
    reviews: clean(lead.reviews),
    source: clean(lead["Lead Source"], "Serper.dev (Google)"),
    fitScore: clean(lead["Fit Score"], 0),
    temperature: clean(lead["Lead Temperature"]),
    trustLevel: clean(lead["Trust Level"]),
    confidenceScore: clean(lead["Confidence Score"], 0),
    recommendedChannel: clean(lead["Recommended Channel"]),
    whyThisLead: clean(opp.problem),
    opportunityProblem: clean(opp.problem),
    opportunityOffer: clean(opp.offer),
    opportunityWhy: clean(opp.why),
    opportunityFirstOffer: clean(opp.firstOffer),
    firstMessage: clean(lead["First Message"]),
    followUp1: clean(lead["Follow-Up 1"]),
    followUp2: clean(lead["Follow-Up 2"]),
    closeTheLoop: clean(lead["Close-The-Loop Message"]),
    approved: lead["Approved To Contact"] === "YES",
    favorite: !!lead.favorite,
    status: clean(lead["Status"], "New"),
    notes: clean(lead.notes),
  };
}

// Read every saved lead for a user into a compact state map keyed by leadKey.
export async function fetchSavedLeads(uid) {
  if (!db) return {};
  const snap = await getDocs(collection(db, "users", uid, "leads"));
  const map = {};
  snap.forEach((d) => {
    const x = d.data();
    map[d.id] = {
      status: x.status || "New",
      approved: !!x.approved,
      favorite: !!x.favorite,
      notes: x.notes || "",
      score: typeof x.fitScore === "number" ? x.fitScore : undefined,
    };
  });
  return map;
}

// Merge-write a lead doc. Public fields refresh; user state (from patch) wins;
// existing user state is preserved because unspecified fields aren't touched.
export async function saveLead(uid, lead, patch, isNew) {
  if (!db) throw new Error("Firestore not configured");
  const ref = doc(db, "users", uid, "leads", lead._key);
  const data = {
    ...leadToDoc(lead),
    ...patch, // { favorite? , approved? , status? , notes? }
    updatedAt: serverTimestamp(),
    lastSeenAt: serverTimestamp(),
  };
  if (isNew) data.createdAt = serverTimestamp();
  await setDoc(ref, data, { merge: true });
}
