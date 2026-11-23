import { describe, expect, it } from "vitest";
import { validateFinanceSet } from "../../../lib/check/validate";
import type {
  SageBankAccount,
  SageBankTransfer,
  SageContact,
  SageContactPayment,
  SageInvoice,
  SageLedgerAccount,
  SageOtherPayment,
  SageOtherReceipt,
} from "./raw/types";
import {
  canonicalId,
  normalizeAccountType,
  normalizeAccounts,
  normalizeBankMovements,
  normalizeInvoice,
  normalizeInvoices,
  normalizeLedgerAccount,
  normalizeParties,
  normalizeParty,
} from "./normalize";

describe("Sage Normalize", () => {
  describe("normalizeAccountType", () => {
    it("classifies standard Sage types correctly", () => {
      expect(normalizeAccountType("sales")).toBe("income");
      expect(normalizeAccountType("other_income")).toBe("income");
      expect(normalizeAccountType("direct_expenses")).toBe("expense");
      expect(normalizeAccountType("overheads")).toBe("expense");
      expect(normalizeAccountType("bank")).toBe("asset");
      expect(normalizeAccountType("current_assets")).toBe("asset");
      expect(normalizeAccountType("current_liabilities")).toBe("liability");
      expect(normalizeAccountType("equity")).toBe("equity");
    });

    it("falls back to nominal code ranges when type is missing", () => {
      expect(normalizeAccountType(undefined, undefined, 1200)).toBe("asset");
      expect(normalizeAccountType(undefined, undefined, 2100)).toBe("liability");
      expect(normalizeAccountType(undefined, undefined, 3000)).toBe("equity");
      expect(normalizeAccountType(undefined, undefined, 4000)).toBe("income");
      expect(normalizeAccountType(undefined, undefined, 7500)).toBe("expense");
    });
  });

  describe("normalizeAccounts", () => {
    it("strictly preserves the absent-not-default rule for optional fields", () => {
      const raw: SageLedgerAccount = {
        id: "acc-101",
        name: "General Expense",
        ledger_account_type: { id: "expenses" },
      };
      const normalized = normalizeLedgerAccount(raw);

      expect(normalized.id).toBe("sage:acc-101");
      expect(normalized.source).toBe("sage");
      expect(normalized.sourceId).toBe("acc-101");
      expect(normalized.name).toBe("General Expense");
      expect(normalized.type).toBe("expense");
      expect("code" in normalized).toBe(false);
      expect("sourceUpdatedAt" in normalized).toBe(false);
    });

    it("merges bank accounts and preserves specific bank account names", () => {
      const ledgers: SageLedgerAccount[] = [
        { id: "acc-1200", nominal_code: 1200, name: "Bank Ledger", ledger_account_type: { id: "bank" } },
      ];
      const banks: SageBankAccount[] = [
        {
          id: "bank-1",
          account_name: "Operating account",
          ledger_account: { id: "acc-1200" },
          balance: 50000,
        },
      ];

      const result = normalizeAccounts(ledgers, banks);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("sage:acc-1200");
      expect(result[0].name).toBe("Operating account");
      expect(result[0].type).toBe("asset");
      expect(result[0].code).toBe("1200");
    });
  });

  describe("normalizeParties", () => {
    it("distinguishes customer, supplier, and both", () => {
      const contacts: SageContact[] = [
        { id: "con-1", name: "Customer Corp", contact_type_ids: ["CUSTOMER"], email: "c@example.com" },
        { id: "con-2", company_name: "Supplier Ltd", contact_type_ids: ["VENDOR"] },
        { id: "con-3", displayed_as: "Both Partner", contact_type_ids: ["CUSTOMER", "VENDOR"] },
      ];

      const [c1, c2, c3] = normalizeParties(contacts);

      expect(c1.kind).toBe("customer");
      expect(c1.email).toBe("c@example.com");

      expect(c2.kind).toBe("supplier");
      expect("email" in c2).toBe(false); // absent, not null or ""

      expect(c3.kind).toBe("both");
    });
  });

  describe("normalizeInvoices", () => {
    it("leaves dueDate absent when Sage does not supply it", () => {
      const raw: SageInvoice = {
        id: "si-1",
        contact: { id: "con-1" },
        date: "2026-10-20",
        total_amount: 12000,
        outstanding_amount: 12000,
        status: { id: "UNPAID" },
        invoice_lines: [
          { description: "Licence", ledger_account: { id: "acc-4000" }, net_amount: 12000 },
        ],
      };

      const normalized = normalizeInvoice(raw, "sales", "acc-4000");
      expect(normalized.id).toBe("sage:si-1");
      expect(normalized.dueDate).toBeUndefined();
      expect("dueDate" in normalized).toBe(false);
      expect(normalized.status).toBe("unpaid");
      expect(normalized.outstanding).toBe(12000);
    });

    it("handles paid and void statuses properly", () => {
      const rawPaid: SageInvoice = {
        id: "si-2",
        contact: { id: "con-1" },
        date: "2026-09-04",
        due_date: "2026-10-04",
        total_amount: 18000,
        outstanding_amount: 0,
        status: { id: "PAID" },
      };
      const normalizedPaid = normalizeInvoice(rawPaid, "sales", "acc-4000");
      expect(normalizedPaid.status).toBe("paid");
      expect(normalizedPaid.outstanding).toBe(0);

      const rawVoid: SageInvoice = {
        id: "si-3",
        contact: { id: "con-1" },
        date: "2026-10-13",
        total_amount: 4000,
        void: true,
      };
      const normalizedVoid = normalizeInvoice(rawVoid, "sales", "acc-4000");
      expect(normalizedVoid.status).toBe("void");
      expect(normalizedVoid.outstanding).toBe(0);
    });
  });

  describe("normalizeBankMovements", () => {
    const bankCtx = {
      bankAccountToLedgerAccountId: new Map([
        ["bank-op", "acc-1200"],
        ["bank-res", "acc-1210"],
      ]),
      defaultCurrency: "USD",
    };

    it("normalizes transfers into matched positive and negative movements", () => {
      const transfers: SageBankTransfer[] = [
        {
          id: "tr-1",
          date: "2026-09-30",
          amount: 60000,
          source_bank_account: { id: "bank-res" },
          destination_bank_account: { id: "bank-op" },
          description: "Transfer to operating",
        },
      ];

      const movements = normalizeBankMovements({ transfers }, bankCtx);
      expect(movements).toHaveLength(2);

      const outMovement = movements.find((m) => m.amount < 0)!;
      const inMovement = movements.find((m) => m.amount > 0)!;

      expect(outMovement.bankAccountId).toBe("sage:acc-1210");
      expect(outMovement.amount).toBe(-60000);

      expect(inMovement.bankAccountId).toBe("sage:acc-1200");
      expect(inMovement.amount).toBe(60000);
    });

    it("normalizes contact payments and other payments", () => {
      const contactPayments: SageContactPayment[] = [
        {
          id: "cp-1",
          date: "2026-10-06",
          total_amount: 18000,
          transaction_type: { id: "CUSTOMER_RECEIPT" },
          bank_account: { id: "bank-op" },
          contact: { id: "con-1" },
          reference: "Payment SI-3001",
        },
      ];

      const otherPayments: SageOtherPayment[] = [
        {
          id: "op-1",
          date: "2026-09-12",
          total_amount: 4500,
          bank_account: { id: "bank-op" },
          payment_lines: [{ ledger_account: { id: "acc-5000" }, details: "Contractor design" }],
        },
      ];

      const otherReceipts: SageOtherReceipt[] = [
        {
          id: "or-1",
          date: "2026-10-26",
          total_amount: 95,
          bank_account: { id: "bank-res" },
          reference: "Interest",
        },
      ];

      const movements = normalizeBankMovements(
        { contactPayments, otherPayments, otherReceipts },
        bankCtx,
      );

      expect(movements).toHaveLength(3);

      const cp = movements.find((m) => m.sourceId === "cp-1")!;
      expect(cp.amount).toBe(18000);
      expect(cp.partyId).toBe("sage:con-1");
      expect(cp.bankAccountId).toBe("sage:acc-1200");

      const op = movements.find((m) => m.sourceId === "op-1")!;
      expect(op.amount).toBe(-4500);
      expect(op.accountId).toBe("sage:acc-5000");

      const orItem = movements.find((m) => m.sourceId === "or-1")!;
      expect(orItem.amount).toBe(95);
      expect(orItem.bankAccountId).toBe("sage:acc-1210");
    });
  });

  describe("End-to-end Canonical Validator Compliance", () => {
    it("passes validateFinanceSet with zero errors and zero warnings", () => {
      const rawLedgers: SageLedgerAccount[] = [
        { id: "acc-1200", nominal_code: 1200, name: "Operating account", ledger_account_type: { id: "bank" } },
        { id: "acc-1210", nominal_code: 1210, name: "Reserve account", ledger_account_type: { id: "bank" } },
        { id: "acc-4000", nominal_code: 4000, name: "Sales", ledger_account_type: { id: "sales" } },
        { id: "acc-7500", nominal_code: 7500, name: "Software subscriptions", ledger_account_type: { id: "expenses" } },
      ];

      const rawContacts: SageContact[] = [
        { id: "con-1", name: "Northgate Analytics", contact_type_ids: ["CUSTOMER"], email: "accounts@northgate.example" },
        { id: "con-2", name: "Ovelo Cloud", contact_type_ids: ["VENDOR"] },
      ];

      const rawSales: SageInvoice[] = [
        {
          id: "si-3001",
          invoice_number: "SI-3001",
          contact: { id: "con-1" },
          date: "2026-09-04",
          due_date: "2026-10-04",
          total_amount: 18000,
          outstanding_amount: 0,
          status: { id: "PAID" },
          invoice_lines: [{ description: "Platform licence", ledger_account: { id: "acc-4000" }, net_amount: 18000 }],
        },
      ];

      const rawPurchases: SageInvoice[] = [
        {
          id: "pi-3101",
          invoice_number: "OV-44817",
          contact: { id: "con-2" },
          date: "2026-10-03",
          due_date: "2026-11-02",
          total_amount: 2350,
          outstanding_amount: 2350,
          status: { id: "UNPAID" },
          invoice_lines: [{ description: "Cloud hosting", ledger_account: { id: "acc-7500" }, net_amount: 2350 }],
        },
      ];

      const accounts = normalizeAccounts(rawLedgers);
      const parties = normalizeParties(rawContacts);
      const invoices = normalizeInvoices(rawSales, rawPurchases);
      const bankTransactions = normalizeBankMovements(
        {
          contactPayments: [
            {
              id: "cp-1",
              date: "2026-09-05",
              total_amount: 18000,
              transaction_type: { id: "CUSTOMER_RECEIPT" },
              bank_account: { id: "acc-1200" },
              contact: { id: "con-1" },
              reference: "SI-3001 payment",
            },
          ],
        },
        {
          bankAccountToLedgerAccountId: new Map([["acc-1200", "acc-1200"]]),
          defaultCurrency: "USD",
        },
      );

      const check = validateFinanceSet({ accounts, parties, invoices, bankTransactions });

      expect(check.errors).toEqual([]);
      expect(check.warnings).toEqual([]);
      expect(check.set).not.toBeNull();
    });
  });
});
