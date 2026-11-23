# Submission note

## What I pulled, and what I left out

The connector pulls four core canonical collections from Sage Accounting API v3.1:

1. **Accounts (`LedgerAccount[]`)**:
   - Pulled from `/ledger_accounts` (and `/bank_accounts` to link banking nominals).
   - Maps `id` to `sage:${id}`, `name` to account name, `nominal_code` to `code` (when present; absent otherwise), and classifies `type` into `"asset" | "liability" | "equity" | "income" | "expense"` based on Sage's `ledger_account_type` and UK chart of accounts code ranges.
   - Bank accounts from `/bank_accounts` are merged into asset ledger accounts so bank accounts can be resolved without dangling references.
   - Left out: tax settings, opening balance entries on nominal ledgers, and deletable flags, which are internal to Sage and not required by downstream briefs or module tables.

2. **Parties (`Party[]`)**:
   - Pulled from `/contacts`.
   - Maps `id` to `sage:${id}`, `name` to contact name, `contact_type_ids` / `contact_types` to `kind: "customer" | "supplier" | "both"`.
   - `email` is included when present on the contact or main contact person; strictly absent (never `""` or `null`) when absent in Sage.
   - Left out: physical addresses, telephone numbers, credit limits, and banking coordinates because Buki canonical party models only concern identity, role, and correspondence.

3. **Invoices (`Invoice[]`)**:
   - Pulled from `/sales_invoices` (kind: `"sales"`) and `/purchase_invoices` (kind: `"purchase"`).
   - Maps `id` to `sage:${id}`, `partyId` to `sage:${contact.id}`, `invoice_number` to `number` (absent if omitted), `date` to YYYY-MM-DD, `due_date` to `dueDate` (strictly absent when omitted so briefs know not to categorize it as overdue or current).
   - Status is mapped to `"draft" | "unpaid" | "part_paid" | "paid" | "void"`. Void and paid invoices have `outstanding` set to 0. Outstanding never exceeds `total`.
   - Lines map `description`, `ledger_account.id` to `accountId`, and `net_amount` to `net`.
   - **Net vs. VAT decision**: In Sage UK, invoice line amounts include VAT. Buki's canonical `InvoiceLine.net` takes Sage's `net_amount` (pre-tax expense/revenue) so that category spend analysis accurately reflects economic costs rather than tax liabilities. `Invoice.total` and `Invoice.outstanding` track the gross amount payable/receivable, ensuring receivables match cash flow requirements.
   - Left out: individual tax rate breakdown objects, payment terms text, delivery addresses, and PDF attachments.

4. **Bank Transactions (`BankTransaction[]`)**:
   - Pulled from `/bank_transactions` or synthesized across Sage banking movements: `/bank_transfers` (source outflow negative, destination inflow positive), `/contact_payments` (customer receipt positive, vendor payment negative), `/other_payments` (direct expenses negative, with `accountId`), and `/other_receipts` (positive).
   - Each movement has a signed `amount`, currency, `bankAccountId` referencing the canonical bank `LedgerAccount`, date, description, and optional `partyId` or `accountId`.
   - Left out: bank reconciliation match IDs and internal bank feed metadata.

## How it stays in sync

- **First sync**: Full pull of all ledger accounts, contacts, sales and purchase invoices, and bank transactions. Records are normalized, validated against the absent-not-default rule, diffed against the store (all appearing as added), and atomically saved to `.data/store.json`.
- **Scheduled and incremental sync**: Handled by `npm run cron` (or the satellite's sync scheduler). On each tick:
  - If a `since` timestamp is passed, list queries pass `updated_or_created_since` to Sage.
  - The sync engine computes an ID-based diff against the existing store (`added`, `changed`, `removed`).
  - An invoice edited in Sage (e.g. changing an amount, status, or line) updates Sage's `updated_at`. On the next sync tick (default 300 seconds, or user-configured `SYNC_INTERVAL_SECONDS`), the sync engine detects the content change, updates the record in `.data/store.json`, and records `changed: 1`.
  - Modules and briefs read directly from the store at query time, so changes are immediately visible with zero downstream latency.

## When Sage is slow, down, or returns something unexpected

- **Slow responses**: All HTTP requests enforce a strict 10-second timeout via `AbortSignal.timeout(10_000)`. If Sage hangs, a typed `SageError("timeout", ...)` is raised.
- **Down / Network errors**: Network drops or server connection refusals are caught as `SageError("network", ...)`.
- **Unexpected responses / Auth expiry**: 401/403 triggers `SageError("auth", ...)`. Proactive OAuth refresh renews tokens before expiry. If Sage returns invalid JSON or non-envelope structures, `SageError("shape", ...)` is raised.
- **What the user sees**: `runSync` wraps domain syncs so errors never crash the process. The failed run is recorded with `ok: false` and the error message. The existing data in `.data/store.json` remains intact. The brief and Finance module show the cached data alongside a citation timestamp and note indicating the last successful sync.
- **What is never shown as a zero**: Missing salaries, missing invoice due dates, missing payment dates, or absent contact emails are never defaulted to `0`, `""`, or `null`. An open invoice without a due date is reported as "1 open invoice has no due date on file and is not counted", rather than arbitrarily defaulted to overdue or current.

## What I would still worry about

1. **Sage API Rate Limits (429)**: Real Sage tenants enforce throttling per minute. While our client parses `Retry-After`, in a large enterprise ledger with thousands of historical invoices, a rate-limited pagination walk could exceed standard job windows without backoff queues.
2. **Multi-currency exchange conversions**: Sage records invoice and payment currencies, but Buki preserves currencies independently ("\$12,000 and EUR 300"). In high-volume multi-currency environments, unrealized FX gain/loss adjustments in Sage journals need clear mapping.
3. **Credit Notes and Partial Allocations**: Complex credit note applications, unallocated customer deposits, and discounts require continuous reconciliation testing to ensure outstanding balance invariants (`outstanding <= total`) hold under every ledger state.

## Questions I asked

- Clarified Sage Accounting UK v3.1 API endpoint conventions for banking movements (transfers vs contact payments vs other payments) and confirmed canonical `bankAccountId` points to the `LedgerAccount` of the bank account.
- Confirmed handling of VAT vs Net in `InvoiceLine`: lines store `net_amount` for expense analytics, while invoice totals preserve gross amounts for cash and debtor tracking.

## 5-Minute Demonstration Plan

1. **Setup & Verification (0:00 - 1:00)**
   - Show environment configuration in `.env` (`FINANCE_SOURCE=sage`, `SAGE_BASE_URL`, `SAGE_BUSINESS_ID`).
   - Start the mock Sage server: `npm run mock:sage` (or authorize real Sage with `npm run sage:auth`).
   - Run `npm run health` to demonstrate active provider connectivity.

2. **Initial Sync & Store Inspection (1:00 - 2:00)**
   - Run `npm run sync`.
   - Highlight the console output: `finance/sage: pulled 32, added 32, changed 0, removed 0`.
   - Inspect `.data/store.json` to show normalized records without defaulted values.

3. **Finance Module & Financial Questions (2:00 - 3:30)**
   - Run `npm run show -- finance`: show cash per bank account, invoiced totals, overdue receivables table, and customer rankings.
   - Run the two core evaluation questions:
     - `npm run ask -- "who owes us money"`: highlights overdue invoices ($12,000 overdue; 1 invoice with no due date honestly omitted).
     - `npm run ask -- "what did we spend on software last month"`: highlights $2,350 from purchase invoice lines.
     - `npm run ask -- "how much cash do we have"`: highlights $253,615 cash across Operating and Reserve accounts.

4. **Change Detection & Scheduled Sync (3:30 - 4:30)**
   - Start scheduler loop: `npm run cron`.
   - In Sage (or in `mock/sage/data/sage.json`), edit an invoice (e.g., mark an invoice paid or alter line item).
   - Show the next scheduled tick detecting the update: `changed: 1`.
   - Re-run `npm run ask -- "who owes us money"` to show the live answer updated instantly.

5. **Test Suite Verification (4:30 - 5:00)**
   - Run `npm test && npm run typecheck` to show 100% passing tests (55 tests) and zero TypeScript errors.
