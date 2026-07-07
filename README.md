# Market Fuzion — Prospecting Command Center (v1)

Research and prepare leads with **Serper.dev** (Google search / local business
discovery) + **OpenAI** (scoring, mini-audits, outreach drafts). You review,
approve, and send manually.

**Nothing auto-contacts anyone. No mass DMs. No Microsoft tools. No LeadsGorilla.**

---

## What it does

1. You enter niche, location, max results, excluded franchises.
2. Serper.dev finds local businesses via Google, using these queries:
   - `{niche} {location}` and `{niche} near {location}` (Places endpoint → phone, website, rating, category)
   - `site:instagram.com {niche} {location}` and `site:facebook.com {niche} {location}` (Search endpoint → social links)
3. Obvious franchises/chains are filtered out.
4. OpenAI scores each lead (100-pt model), writes a mini-audit + 4 outreach drafts.
5. Results show in a table, sorted by Fit Score. Click any row for the audit + messages.
6. Edit Status / tick "Approved To Contact", then export a Google-Sheets-ready CSV.

Social links are attached to a lead **only on a confident name match** (≥ 2 shared
distinctive words), so you never get the wrong Instagram/Facebook glued to a business.

---

## Setup (5 minutes)

```bash
npm install
cp .env.local.example .env.local   # then paste your two keys into .env.local
npm run dev                        # http://localhost:3000
```

You need:
- **SERPER_API_KEY** — https://serper.dev (generous free credits to start)
- **OPENAI_API_KEY** — https://platform.openai.com

Keys live only in `.env.local` and are used **server-side**. They are never sent to the browser. Do not commit `.env.local`.

## Firebase (Auth + saved leads)

Sign-in and saved pipeline state use Firebase. If the Firebase env vars are **not** set,
the app runs in local-only mode (workflow state saved in the browser). Once set, users
sign in with Google and their favorites / approvals / notes / status persist to Firestore.

Set up:
1. Create a Firebase project → add a **Web app** → copy the config.
2. In **Authentication**, enable the **Google** sign-in provider.
3. In **Firestore Database**, create a database (production mode).
4. Add these **public** client vars to `.env.local` (see `.env.local.example`):
   ```
   NEXT_PUBLIC_FIREBASE_API_KEY
   NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
   NEXT_PUBLIC_FIREBASE_PROJECT_ID
   NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
   NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
   NEXT_PUBLIC_FIREBASE_APP_ID
   NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID   # optional (Analytics only) — safe to omit
   ```
   These are safe to expose to the browser. **Serper/OpenAI keys stay server-side — never prefix them with `NEXT_PUBLIC_`.**

Sign-in is **email/password** (Firebase client auth — `createUserWithEmailAndPassword` /
`signInWithEmailAndPassword`). On account creation a profile doc is written to
`users/{uid}` (`uid`, `email`, `displayName`, `plan: "solo"`, `role: "owner"`, timestamps);
normal sign-in updates `lastLoginAt` / `updatedAt`. Profile writes are best-effort and never
block sign-in.

Data model:
- `users/{uid}` — the user profile doc.
- `users/{uid}/leads/{leadKey}` — one doc per saved lead, keyed by a stable lead key
  (normalized name + phone + website domain + city). Writes are merges, so a new search
  refreshes public info without clobbering your favorite / approval / status / notes.

**Firestore security rules** (Console → Firestore → Rules) — each user can only touch their
own profile and leads:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
      match /leads/{leadId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }
  }
}
```

**Authorized domains (required for production auth on Vercel):** add your deployed Vercel
domain(s) under **Firebase Console → Authentication → Settings → Authorized domains**,
otherwise sign-in will fail on the live site.

## Deploy to Vercel

```bash
# push to GitHub, import the repo in Vercel, then add the env vars in
# Project → Settings → Environment Variables.
```

Add these in Vercel:
- Server-side (secret): `SERPER_API_KEY`, `OPENAI_API_KEY`, and optionally `OPENAI_MODEL`.
- Firebase client (public): `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`,
  `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`,
  `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`
  (and optionally `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID`).

After deploying, add your Vercel domain to Firebase → Authentication → Settings → **Authorized domains**.

The `/api/prospect` route runs as a Node serverless function (`maxDuration = 60`).

---

## How to test it works

1. `npm run dev`, open localhost:3000.
2. Leave the defaults (personal trainer / Fairfax, VA / 20) and hit **Research Leads**.
3. Expect a meta line like "Found 20 · removed 4 franchises · analyzed 16".
4. Click a Hot lead — you should see a specific, non-hypey first message, and (when matched) an Instagram/Facebook link in the audit.
5. Tick a couple **Approved**, change a **Status**, hit **Export CSV**, open it in Google Sheets (File → Import → Comma). All 24 columns should line up.

If you get a config error, your `.env.local` keys are missing or misnamed.

---

## Scoring (computed server-side, not trusted to the model's math)

The model returns six sub-scores; the server clamps each to its cap and sums them:

| Category | Max |
|---|---|
| Inbound Lead Dependence | 20 |
| Follow-Up Urgency | 20 |
| Social Channel Fit | 15 |
| Automation Opportunity | 20 |
| Ability to Pay | 15 |
| Personalization Quality | 10 |

**Fit Score → Temperature:** 80–100 Hot · 60–79 Good · 40–59 Maybe · <40 Skip
**Confidence (1–5):** how much real public evidence existed. Trust low-confidence rows less.

---

## Honesty guardrails (built in)
- Uses only the public data Serper.dev returned. The model is instructed **never to invent** emails, phone numbers, or social handles.
- Social links are attached only on a strong name match; otherwise the column stays blank.
- Never states "you are losing leads" as fact — drafts use hedged, low-pressure phrasing.
- Failed AI calls don't kill the batch: that lead returns with a "retry" note so you never lose the search.

---

## Known limitations (by design, for v1)
- **Email is not returned** by Serper's local results — that column stays blank for manual fill or v2 website enrichment.
- Instagram/Facebook fill in only when a `site:` result confidently matches the business name. Expect partial coverage, not 100%.
- No database — results live in the page until you export. That's intentional; CSV → Google Sheets is the v1 store.
- No login. Add auth only if you fold this into the existing Market Fuzion app.

## Cost per search (ballpark)
- 4 Serper queries per run (2 places + 2 social). Serper's free tier covers plenty of testing.
- ~1 OpenAI call per surviving lead. With `gpt-4o-mini`, a 20-lead run is fractions of a cent to a few cents. Keep Max Results sane while testing.

---

## Files
```
app/
  page.js                  UI: form, table, expandable rows, CSV export
  layout.js, globals.css   shell + styling
  api/prospect/route.js    server orchestration + score computation
lib/
  serper.js                Serper.dev places + social discovery, normalize
  openai.js                per-lead analysis (strict JSON, honesty rules)
  franchises.js            chain filter (built-in + your exclusions)
  schema.js                24 columns + CSV builder (shared)
```

## Later (locked until v1 has real reps)
Website-scrape enrichment for email → save runs to Google Sheets/Drive →
Make automation → fold into the Market Fuzion app. None of it before real searches
produce real approved leads and real replies.
