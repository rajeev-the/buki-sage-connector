import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  normalizeAccounts,
  normalizeParties,
  normalizeInvoices,
  normalizeBankMovements,
} from "./normalize";
import { answerBrief } from "../../../lib/brief/answer";
import type { Store } from "../../../lib/store/store";

describe("Sage Data & Brief Verification Tests", () => {
  // Load the actual raw mock Sage dataset
  const rawSagePath = resolve(process.cwd(), "mock/sage/data/sage.json");
  const rawSage = JSON.parse(readFileSync(rawSagePath, "utf8"));

  // Normalize all raw Sage collections using our pure normalization engine
  const accounts = normalizeAccounts(rawSage.ledger_accounts || [], rawSage.bank_accounts || []);
  const parties = normalizeParties(rawSage.contacts || []);
  const invoices = normalizeInvoices(rawSage.sales_invoices || [], rawSage.purchase_invoices || []);
  
  const bankAccountToLedger = new Map<string, string>();
  for (const acc of rawSage.bank_accounts || []) {
    if (acc.id && acc.ledger_account?.id) {
      bankAccountToLedger.set(acc.id, acc.ledger_account.id);
    }
  }
  const bankTransactions = normalizeBankMovements(
    { genericTransactions: rawSage.bank_transactions || [] },
    { bankAccountToLedgerAccountId: bankAccountToLedger }
  );

  // Construct a canonical store snapshot
  const mockStore: Store = {
    hr: { source: "bamboohr", syncedAt: "2026-11-23T17:23:00Z", employees: [] },
    finance: {
      source: "sage",
      syncedAt: "2026-11-23T17:23:00Z",
      accounts,
      parties,
      invoices,
      bankTransactions,
    },
    runs: [],
  };

  const evalDate = new Date("2026-11-23T12:00:00Z");

  it("1. Cash balance exactly matches raw Sage bank transactions ($253,615)", () => {
    const brief = answerBrief("how much cash do we have", mockStore, evalDate);
    expect(brief.answer).toContain("Cash is $253,615 across 2 bank accounts");
    
    const operatingFig = brief.figures.find((f) => f.label === "Operating account");
    const reserveFig = brief.figures.find((f) => f.label === "Reserve account");
    const allFig = brief.figures.find((f) => f.label === "All bank accounts");

    expect(operatingFig?.value).toBe("$63,520");
    expect(reserveFig?.value).toBe("$190,095");
    expect(allFig?.value).toBe("$253,615");
  });

  it("2. 'Who owes us money' matches overdue receivables ($12,000) and honestly omits un-dated invoices", () => {
    const brief = answerBrief("who owes us money", mockStore, evalDate);
    
    // Pinecrest ($9,500) + Tolliver ($2,500) = $12,000
    expect(brief.answer).toContain("2 invoices are overdue, $12,000 outstanding");
    expect(brief.answer).toContain("Pinecrest Health $9,500");
    expect(brief.answer).toContain("Tolliver & Reed LLP $2,500");

    // Must honestly report that 1 open invoice (SI-3006) has no due date
    expect(brief.answer).toContain("1 open invoice has no due date on file and is not counted");
    
    const overdueFig = brief.figures.find((f) => f.label === "Overdue outstanding");
    expect(overdueFig?.value).toBe("$12,000");
  });

  it("3. Software spending in October 2026 matches exact purchase invoice lines ($2,350)", () => {
    const brief = answerBrief("what did we spend on software in october 2026", mockStore, evalDate);
    expect(brief.answer).toContain("$2,350 was spent on Software subscriptions in October 2026, from 2 purchase invoice lines");
    
    const softwareFig = brief.figures.find((f) => f.label === "Software subscriptions");
    expect(softwareFig?.value).toBe("$2,350");
  });

  it("4. Strictly enforces Absent-Not-Default rule on missing due dates and emails", () => {
    // SI-3006 has no due date in raw Sage
    const undatedInvoice = invoices.find((inv) => inv.sourceId === "si-3006");
    expect(undatedInvoice).toBeDefined();
    expect(undatedInvoice?.dueDate).toBeUndefined();
    expect("dueDate" in (undatedInvoice || {})).toBe(false); // strictly omitted property

    // Contact without email in raw Sage (con-2003)
    const conWithoutEmail = parties.find((p) => p.sourceId === "con-2003");
    expect(conWithoutEmail).toBeDefined();
    expect(conWithoutEmail?.email).toBeUndefined();
    expect("email" in (conWithoutEmail || {})).toBe(false); // strictly omitted property
  });

  it("5. Strictly clamps outstanding = 0 on paid invoices", () => {
    const paidInvoice = invoices.find((inv) => inv.sourceId === "si-3001");
    expect(paidInvoice).toBeDefined();
    expect(paidInvoice?.status).toBe("paid");
    expect(paidInvoice?.outstanding).toBe(0);
  });

  it("6. Net vs. VAT: Invoice lines preserve pre-tax net expense", () => {
    const cloudInvoice = invoices.find((inv) => inv.sourceId === "pi-3102");
    expect(cloudInvoice).toBeDefined();
    expect(cloudInvoice?.lines.length).toBe(2);
    expect(cloudInvoice?.lines[0].net).toBe(1900);
    expect(cloudInvoice?.lines[1].net).toBe(450);
    expect(cloudInvoice?.total).toBe(2350);
  });
});
