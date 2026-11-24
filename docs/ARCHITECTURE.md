lik# Buki Sage Connector Architecture & Visual Guides

This document provides visual diagrams and architectural deep-dives for the Sage Accounting integration into Buki.

---

## 1. Visual End-to-End Flow (Auth ➔ Sync ➔ Store ➔ Answer Question)

A clean, text-free visual pipeline tracing data from initial authorization through incremental synchronization, canonical normalization, atomic storage, and downstream question answering:

![Visual End-to-End Flow](./images/01-system-architecture.png)

### The 4 Stages of the Pipeline:

1. **Stage 1 — Authentication:** `OAuth 2.0 PKCE` ➔ `Sage Consent Portal` ➔ `Proactive Mutex Lock` (60s buffer) ➔ `.data/sage-tokens.json` (`0600`).
2. **Stage 2 — Sync & Ingestion:** `Watermark Trigger` (`since`) ➔ `Sage API v3.1 / Mock` ➔ `Resilient Client` (10s timeout, 429 backoff) ➔ `$next Envelope Traversal`.
3. **Stage 3 — Normalize & Store:** `Absent-Not-Default Rule` ➔ `Net vs VAT Pre-tax Line Logic` ➔ `Tri-State Diff` (`added`, `changed`, `removed`) ➔ `.data/store.json` (Atomic snapshot).
4. **Stage 4 — Answer Question:** `User Question` ("Who owes us money?") ➔ `Brief Engine` (`answer.ts`) ➔ `Honest Exclusion` (citations for missing dates) ➔ `Cited Answer` ($12,000 overdue across 4 clients).

---

## 2. Authentication Flow & Token Lifecycle

Sage uses OAuth 2.0 with PKCE and state verification. The integration provides interactive developer authentication, token rotation, and runtime proactive refresh.

![Sage OAuth 2.0 & Token Lifecycle](./images/02-authentication-flow.png)

### Lifecycle Stages:

1. **Interactive CLI Authorization (`npm run sage:auth`)**:
   - Generates a cryptographically random `state` parameter.
   - Spawns a temporary local HTTP server on `http://localhost:3000/api/sage/callback`.
   - Opens the browser to Sage Central OAuth. The user logs in and grants consent to their Accounting trial business.
   - Sage redirects back to the local listener with `code` and `state`.
   - Verifies `state`, exchanges `code` for an access token (300s lifetime) and a refresh token (rolling 31-day lifetime).
   - Atomically saves tokens with POSIX `0o600` permissions (`.data/sage-tokens.json`).

2. **Proactive Runtime Token Refresh (`src/data/canonical/sage/auth.ts`)**:
   - Before any outgoing API request, checks the access token's `expiresAt` with a **60-second proactive buffer**.
   - An in-flight promise lock ensures concurrent API calls never initiate duplicate refresh requests.
   - Automatically rotates the refresh token when a new pair is issued.
   - If an unexpected 401 is received mid-request, triggers one immediate token recovery retry before surfacing an error.
   - **Cloud Environment Auto-seeding:** In cloud environments (e.g., Render), tokens auto-seed from `SAGE_ACCESS_TOKEN` and `SAGE_REFRESH_TOKEN` environment variables without requiring browser intervention.

---

## 3. Incremental Sync & Auto-Sync Engine

Syncing keeps Buki up-to-date with Sage continuously or on demand with zero downstream latency.

![Auto-Sync and Sync Architecture](./images/03-auto-sync-and-sync-architecture.png)

### How It Works:

1. **Triggering**:
   - Manual: `npm run sync` (one-off sync).
   - Continuous: `npm run cron` (scheduled daemon running every `SYNC_INTERVAL_SECONDS`, default: 300s).

2. **Incremental Fetching**:
   - Reads `last_sync_at` watermark timestamp.
   - Queries Sage endpoints with `updated_or_created_since=ISO8601`.
   - Follows pagination envelopes (`$next`) to guarantee complete record sets.

3. **Tri-State Diffing**:
   - Compares incoming normalized records against the existing store:
     - `added`: Records with new IDs.
     - `changed`: Existing records with modified content hashes (e.g., invoice marked paid).
     - `removed`: Records deleted at source.
   - Atomically writes to `.data/store.json`.

4. **Change Detection Walkthrough ("A change in Sage")**:
   - **Step A:** Invoice #1042 has `outstanding: $1,200`. The brief answers: *"$12,000 overdue across 4 clients"*.
   - **Step B:** Invoice is marked paid in Sage (or edited in `mock/sage/data/sage.json`).
   - **Step C:** Next cron sync tick detects the updated timestamp and diffs the record: `finance/sage: changed: 1`.
   - **Step D:** Re-asking *"who owes us money"* immediately reflects the change: *"$10,800 overdue across 3 clients"*, with updated audit timestamp.
