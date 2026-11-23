import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBrief } from "../../../lib/brief/answer";
import { runSync } from "../../../lib/sync/runSync";
import { emptyStore, readStore, writeStore, type Store } from "../../../lib/store/store";
import { saveTokens } from "./auth";
import type { FinanceProvider } from "../providers/types";
import type { BankTransaction, Invoice, LedgerAccount, Party } from "../types";

describe("Sage End-to-End Integration", () => {
  const testStoreDir = resolve(process.cwd(), ".data/test-store");
  const testTokenPath = resolve(testStoreDir, "sage-tokens.json");

  const originalEnv = { ...process.env };
  let originalStore: Store;

  beforeEach(async () => {
    await fs.mkdir(testStoreDir, { recursive: true });
    originalStore = await readStore();
    await writeStore(emptyStore());

    await saveTokens(
      {
        access_token: "test-token",
        refresh_token: "test-refresh",
        expires_at: Date.now() + 300_000,
      },
      testTokenPath,
    );

    process.env.SAGE_CLIENT_ID = "test-client";
    process.env.SAGE_CLIENT_SECRET = "test-secret";
    process.env.SAGE_BUSINESS_ID = "halden-labs-uk";
    process.env.SAGE_TOKEN_PATH = testTokenPath;
    process.env.FINANCE_SOURCE = "sage";
    process.env.HR_SOURCE = "bamboohr";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    await writeStore(originalStore);
    await fs.rm(testStoreDir, { recursive: true, force: true });
  });

  const sampleAccounts: LedgerAccount[] = [
    { id: "sage:acc-1200", source: "sage", sourceId: "acc-1200", code: "1200", name: "Operating account", type: "asset" },
    { id: "sage:acc-1210", source: "sage", sourceId: "acc-1210", code: "1210", name: "Reserve account", type: "asset" },
    { id: "sage:acc-4000", source: "sage", sourceId: "acc-4000", code: "4000", name: "Sales", type: "income" },
    { id: "sage:acc-7500", source: "sage", sourceId: "acc-7500", code: "7500", name: "Software subscriptions", type: "expense" },
  ];

  const sampleParties: Party[] = [
    { id: "sage:con-2001", source: "sage", sourceId: "con-2001", name: "Northgate Analytics", kind: "customer" },
    { id: "sage:con-2002", source: "sage", sourceId: "con-2002", name: "Pinecrest Health", kind: "customer" },
  ];

  const initialInvoices: Invoice[] = [
    {
      id: "sage:si-3001",
      source: "sage",
      sourceId: "si-3001",
      kind: "sales",
      partyId: "sage:con-2001",
      number: "SI-3001",
      date: "2026-09-04",
      dueDate: "2026-10-04",
      status: "paid",
      currency: "USD",
      total: 18000,
      outstanding: 0,
      lines: [{ description: "Platform licence", accountId: "sage:acc-4000", net: 18000 }],
    },
    {
      id: "sage:si-3002",
      source: "sage",
      sourceId: "si-3002",
      kind: "sales",
      partyId: "sage:con-2002",
      number: "SI-3002",
      date: "2026-09-15",
      dueDate: "2026-10-15",
      status: "unpaid",
      currency: "USD",
      total: 9500,
      outstanding: 9500,
      lines: [{ description: "Implementation", accountId: "sage:acc-4000", net: 9500 }],
    },
    {
      id: "sage:pi-3101",
      source: "sage",
      sourceId: "pi-3101",
      kind: "purchase",
      partyId: "sage:con-2001",
      number: "PI-3101",
      date: "2026-10-03",
      dueDate: "2026-11-02",
      status: "unpaid",
      currency: "USD",
      total: 2350,
      outstanding: 2350,
      lines: [{ description: "Cloud software", accountId: "sage:acc-7500", net: 2350 }],
    },
  ];

  const sampleBankTransactions: BankTransaction[] = [
    {
      id: "sage:bt-5001",
      source: "sage",
      sourceId: "bt-5001",
      bankAccountId: "sage:acc-1200",
      date: "2026-09-01",
      amount: 63520,
      currency: "USD",
      description: "Balance in",
    },
    {
      id: "sage:bt-5002",
      source: "sage",
      sourceId: "bt-5002",
      bankAccountId: "sage:acc-1210",
      date: "2026-09-01",
      amount: 190095,
      currency: "USD",
      description: "Reserve deposit",
    },
  ];

  it("handles initial sync, change detection, and duplicate prevention", async () => {
    let currentInvoices = [...initialInvoices];

    const mockFinanceProvider: FinanceProvider = {
      source: "sage",
      health: async () => ({ ok: true, detail: "Mock Sage Connected" }),
      accounts: async () => sampleAccounts,
      parties: async () => sampleParties,
      invoices: async () => currentInvoices,
      bankTransactions: async () => sampleBankTransactions,
    };

    // 1. Initial sync
    const initialReport = await runSync({ financeProvider: mockFinanceProvider });
    const finRun1 = initialReport.runs.find((r) => r.domain === "finance")!;

    expect(finRun1.ok).toBe(true);
    expect(finRun1.added).toBe(4 + 2 + 3 + 2); // 11 records added
    expect(finRun1.changed).toBe(0);
    expect(finRun1.removed).toBe(0);

    // 2. Duplicate prevention (re-syncing identical data results in 0 added, 0 changed)
    const secondReport = await runSync({ financeProvider: mockFinanceProvider });
    const finRun2 = secondReport.runs.find((r) => r.domain === "finance")!;

    expect(finRun2.ok).toBe(true);
    expect(finRun2.added).toBe(0);
    expect(finRun2.changed).toBe(0);
    expect(finRun2.removed).toBe(0);

    // 3. Edit invoice in Sage (e.g. customer makes partial payment, reducing outstanding from 9500 to 5000)
    currentInvoices = currentInvoices.map((inv) =>
      inv.id === "sage:si-3002"
        ? { ...inv, status: "part_paid", outstanding: 5000, sourceUpdatedAt: "2026-11-23T12:00:00Z" }
        : inv,
    );

    const thirdReport = await runSync({ financeProvider: mockFinanceProvider });
    const finRun3 = thirdReport.runs.find((r) => r.domain === "finance")!;

    expect(finRun3.ok).toBe(true);
    expect(finRun3.changed).toBe(1);
    expect(finRun3.added).toBe(0);
    expect(finRun3.removed).toBe(0);

    // 4. Verify store holds the updated invoice
    const store = await readStore();
    const updatedInvoice = store.finance.invoices.find((i) => i.id === "sage:si-3002")!;
    expect(updatedInvoice.status).toBe("part_paid");
    expect(updatedInvoice.outstanding).toBe(5000);
  });

  it("recovers gracefully from provider failure without deleting existing data", async () => {
    const validProvider: FinanceProvider = {
      source: "sage",
      health: async () => ({ ok: true, detail: "Mock Sage Connected" }),
      accounts: async () => sampleAccounts,
      parties: async () => sampleParties,
      invoices: async () => initialInvoices,
      bankTransactions: async () => sampleBankTransactions,
    };

    // First successful sync
    await runSync({ financeProvider: validProvider });
    const storeBefore = await readStore();
    expect(storeBefore.finance.invoices).toHaveLength(3);

    // Second sync fails (e.g. Sage outage or timeout)
    const failingProvider: FinanceProvider = {
      source: "sage",
      health: async () => ({ ok: false, detail: "Sage is down" }),
      accounts: async () => {
        throw new Error("Sage API gateway timeout");
      },
      parties: async () => [],
      invoices: async () => [],
      bankTransactions: async () => [],
    };

    const failReport = await runSync({ financeProvider: failingProvider });
    const finRun = failReport.runs.find((r) => r.domain === "finance")!;

    expect(finRun.ok).toBe(false);
    expect(finRun.error).toContain("Sage API gateway timeout");

    // Existing records remain intact
    const storeAfter = await readStore();
    expect(storeAfter.finance.invoices).toHaveLength(3);
    expect(storeAfter.finance.invoices[0].id).toBe("sage:si-3001");
  });

  it("answers 'who owes us money' and 'what did we spend on software last month'", async () => {
    const store: Store = {
      hr: { source: null, syncedAt: null, employees: [] },
      finance: {
        source: "sage",
        syncedAt: "2026-11-23T10:00:00Z",
        accounts: sampleAccounts,
        parties: sampleParties,
        invoices: initialInvoices,
        bankTransactions: sampleBankTransactions,
      },
      runs: [],
    };

    // Question 1: Who owes us money?
    const novNow = new Date("2026-11-23T10:00:00Z");
    const overdueAnswer = answerBrief("who owes us money", store, novNow);

    expect(overdueAnswer.answer).toContain("Pinecrest Health $9,500 due 15 Oct 2026");
    expect(overdueAnswer.figures.find((f) => f.label === "Overdue outstanding")?.value).toBe("$9,500");

    // Question 2: What did we spend on software last month? (In Nov 2026, last month is Oct 2026)
    const spendAnswer = answerBrief("what did we spend on software last month", store, novNow);

    expect(spendAnswer.answer).toContain("$2,350 was spent on Software subscriptions in October 2026");
    expect(spendAnswer.figures.find((f) => f.label === "Software subscriptions")?.value).toBe("$2,350");

    // Question 3: How much cash do we have?
    const cashAnswer = answerBrief("how much cash do we have", store, novNow);

    expect(cashAnswer.answer).toContain("Cash is $253,615 across 2 bank accounts");
    expect(cashAnswer.figures.find((f) => f.label === "All bank accounts")?.value).toBe("$253,615");
  });
});
