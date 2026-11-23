/**
 * Sage -> canonical Finance normalization.
 *
 * Pure: raw records in, canonical records out, no I/O.
 * Adheres strictly to the "absent-not-default" rule: any field Sage does not supply
 * is left absent, never defaulted to null, empty string, or undefined.
 */

import type {
  BankTransaction,
  Invoice,
  InvoiceLine,
  LedgerAccount,
  Party,
} from "../types";
import type {
  SageBankAccount,
  SageBankTransfer,
  SageContact,
  SageContactPayment,
  SageInvoice,
  SageInvoiceLine,
  SageLedgerAccount,
  SageOtherPayment,
  SageOtherReceipt,
  SageRawBankTransaction,
} from "./raw/types";

export const canonicalId = (sourceId: string): string => `sage:${sourceId}`;

/**
 * Normalizes a ledger account type into one of Buki's canonical types:
 * "asset" | "liability" | "equity" | "income" | "expense"
 */
export function normalizeAccountType(
  rawType?: string,
  rawGroup?: string,
  nominalCode?: number | string,
): LedgerAccount["type"] {
  const t = (rawType ?? "").toLowerCase();
  const g = (rawGroup ?? "").toLowerCase();

  if (
    t.includes("sales") ||
    t.includes("income") ||
    t.includes("revenue") ||
    g.includes("income") ||
    g.includes("revenue")
  ) {
    return "income";
  }

  if (
    t.includes("expense") ||
    t.includes("overheads") ||
    t.includes("direct_expense") ||
    t.includes("cost_of_sales") ||
    g.includes("expense")
  ) {
    return "expense";
  }

  if (
    t.includes("bank") ||
    t.includes("asset") ||
    t.includes("current_asset") ||
    t.includes("fixed_asset") ||
    g.includes("asset")
  ) {
    return "asset";
  }

  if (
    t.includes("liabilit") ||
    t.includes("creditor") ||
    g.includes("liabilit")
  ) {
    return "liability";
  }

  if (t.includes("equity") || g.includes("equity")) {
    return "equity";
  }

  // Fallback to UK standard Chart of Accounts numbering convention if available
  const codeNum = typeof nominalCode === "number" ? nominalCode : Number(nominalCode);
  if (!Number.isNaN(codeNum) && codeNum > 0) {
    if (codeNum < 2000) return "asset"; // 1000-1999: Assets & Bank
    if (codeNum < 3000) return "liability"; // 2000-2999: Liabilities
    if (codeNum < 4000) return "equity"; // 3000-3999: Capital & Reserves
    if (codeNum < 5000) return "income"; // 4000-4999: Sales / Income
    return "expense"; // 5000+: Purchases & Expenses
  }

  return "expense";
}

/**
 * Normalizes a Sage ledger account.
 */
export function normalizeLedgerAccount(raw: SageLedgerAccount): LedgerAccount {
  const name = (raw.name ?? raw.displayed_as ?? "").trim();
  const typeId = raw.ledger_account_type?.id ?? raw.ledger_account_type?.displayed_as;
  const groupId = raw.ledger_account_group?.id ?? raw.ledger_account_group?.displayed_as;
  const code = raw.nominal_code !== undefined && raw.nominal_code !== null ? String(raw.nominal_code).trim() : raw.code?.trim();

  const account: LedgerAccount = {
    id: canonicalId(raw.id),
    source: "sage",
    sourceId: raw.id,
    name: name || `Account ${raw.id}`,
    type: normalizeAccountType(typeId, groupId, raw.nominal_code),
  };

  if (code && code.length > 0) {
    account.code = code;
  }
  if (raw.updated_at && raw.updated_at.trim().length > 0) {
    account.sourceUpdatedAt = raw.updated_at.trim();
  }

  return account;
}

/**
 * Normalizes a Sage bank account into a canonical LedgerAccount (asset).
 */
export function normalizeBankAccountToLedgerAccount(raw: SageBankAccount): LedgerAccount {
  const ledgerId = raw.ledger_account?.id ?? raw.id;
  const name = (raw.account_name ?? raw.displayed_as ?? raw.bank_name ?? "").trim();

  const account: LedgerAccount = {
    id: canonicalId(ledgerId),
    source: "sage",
    sourceId: ledgerId,
    name: name || `Bank Account ${raw.id}`,
    type: "asset",
  };

  if (raw.updated_at && raw.updated_at.trim().length > 0) {
    account.sourceUpdatedAt = raw.updated_at.trim();
  }

  return account;
}

/**
 * Combines and deduplicates ledger accounts and bank accounts.
 */
export function normalizeAccounts(
  rawLedgerAccounts: SageLedgerAccount[],
  rawBankAccounts: SageBankAccount[] = [],
): LedgerAccount[] {
  const accountsById = new Map<string, LedgerAccount>();

  for (const raw of rawLedgerAccounts) {
    const acc = normalizeLedgerAccount(raw);
    accountsById.set(acc.id, acc);
  }

  for (const rawBank of rawBankAccounts) {
    const bankAcc = normalizeBankAccountToLedgerAccount(rawBank);
    const existing = accountsById.get(bankAcc.id);
    if (!existing) {
      accountsById.set(bankAcc.id, bankAcc);
    } else {
      // If existing exists but bank account has a nicer specific name (e.g. Operating account)
      if (rawBank.account_name && rawBank.account_name.trim().length > 0) {
        existing.name = rawBank.account_name.trim();
      }
    }
  }

  return Array.from(accountsById.values());
}

/**
 * Normalizes a Sage contact into a canonical Party.
 */
export function normalizeParty(raw: SageContact): Party {
  const name = (raw.name ?? raw.company_name ?? raw.displayed_as ?? "").trim();
  const typeIds = new Set<string>();

  if (Array.isArray(raw.contact_type_ids)) {
    for (const t of raw.contact_type_ids) {
      typeIds.add(t.toUpperCase());
    }
  }
  if (Array.isArray(raw.contact_types)) {
    for (const ct of raw.contact_types) {
      if (ct?.id) typeIds.add(ct.id.toUpperCase());
    }
  }

  const isCustomer = typeIds.has("CUSTOMER");
  const isSupplier = typeIds.has("VENDOR") || typeIds.has("SUPPLIER");

  let kind: Party["kind"] = "customer";
  if (isCustomer && isSupplier) kind = "both";
  else if (isSupplier) kind = "supplier";
  else if (isCustomer) kind = "customer";

  const party: Party = {
    id: canonicalId(raw.id),
    source: "sage",
    sourceId: raw.id,
    name: name || `Contact ${raw.id}`,
    kind,
  };

  const email = (raw.email ?? raw.main_contact_person?.email ?? "").trim();
  if (email.length > 0) {
    party.email = email;
  }
  if (raw.updated_at && raw.updated_at.trim().length > 0) {
    party.sourceUpdatedAt = raw.updated_at.trim();
  }

  return party;
}

export function normalizeParties(rawContacts: SageContact[]): Party[] {
  return rawContacts.map(normalizeParty);
}

/**
 * Normalizes status string and amounts to determine canonical invoice status.
 */
export function normalizeInvoiceStatus(
  raw: SageInvoice,
  total: number,
  outstanding: number,
): Invoice["status"] {
  if (raw.void === true) return "void";

  const statusId = (raw.status?.id ?? raw.status?.displayed_as ?? "").toUpperCase();
  if (statusId === "VOID" || statusId === "VOIDED") return "void";
  if (statusId === "DRAFT" || statusId === "PRO_FORMA") return "draft";

  if (outstanding <= 0 || statusId === "PAID") return "paid";
  if (outstanding > 0 && outstanding < total) return "part_paid";
  if (statusId === "PART_PAID") return "part_paid";

  return "unpaid";
}

/**
 * Normalizes an invoice line.
 */
export function normalizeInvoiceLine(
  line: SageInvoiceLine,
  fallbackAccountId: string,
): InvoiceLine {
  const accountId = line.ledger_account?.id ?? line.ledger_account_id ?? fallbackAccountId;
  const description = (line.description ?? "Line item").trim();
  const net = typeof line.net_amount === "number" ? line.net_amount : (line.total_amount ?? 0);

  return {
    description: description || "Line item",
    accountId: canonicalId(accountId),
    net,
  };
}

/**
 * Normalizes a Sage sales or purchase invoice.
 */
export function normalizeInvoice(
  raw: SageInvoice,
  kind: "sales" | "purchase",
  fallbackAccountId: string,
  defaultCurrency = "USD",
): Invoice {
  const partySourceId = raw.contact?.id ?? raw.contact_id ?? "unknown";
  const date = (raw.date ?? "").slice(0, 10);
  const total = raw.total_amount ?? raw.total ?? 0;
  let rawOutstanding = raw.outstanding_amount;
  if (rawOutstanding === undefined || rawOutstanding === null) {
    const s = (raw.status?.id ?? "").toUpperCase();
    rawOutstanding = s === "PAID" ? 0 : total;
  }
  // Outstanding cannot exceed total in canonical model
  const outstanding = Math.min(Math.max(0, rawOutstanding), total);

  const status = normalizeInvoiceStatus(raw, total, outstanding);
  const actualOutstanding = status === "paid" || status === "void" ? 0 : outstanding;

  const currencyCode = (raw.currency?.id ?? raw.currency_id ?? defaultCurrency).trim().toUpperCase();

  const lines: InvoiceLine[] = Array.isArray(raw.invoice_lines) && raw.invoice_lines.length > 0
    ? raw.invoice_lines.map((l) => normalizeInvoiceLine(l, fallbackAccountId))
    : [
        {
          description: raw.displayed_as ?? (kind === "sales" ? "Sales Invoice" : "Purchase Invoice"),
          accountId: canonicalId(fallbackAccountId),
          net: raw.net_amount ?? total,
        },
      ];

  const invoice: Invoice = {
    id: canonicalId(raw.id),
    source: "sage",
    sourceId: raw.id,
    kind,
    partyId: canonicalId(partySourceId),
    date,
    status,
    currency: currencyCode,
    total,
    outstanding: actualOutstanding,
    lines,
  };

  const number = (raw.invoice_number ?? raw.displayed_as ?? "").trim();
  if (number.length > 0) {
    invoice.number = number;
  }

  const dueDate = raw.due_date ? raw.due_date.slice(0, 10) : "";
  if (dueDate.length > 0) {
    invoice.dueDate = dueDate;
  }

  if (raw.updated_at && raw.updated_at.trim().length > 0) {
    invoice.sourceUpdatedAt = raw.updated_at.trim();
  }

  return invoice;
}

export function normalizeInvoices(
  rawSales: SageInvoice[],
  rawPurchases: SageInvoice[],
  fallbackSalesAccountId = "acc-4000",
  fallbackPurchaseAccountId = "acc-7500",
  defaultCurrency = "USD",
): Invoice[] {
  const sales = rawSales.map((inv) => normalizeInvoice(inv, "sales", fallbackSalesAccountId, defaultCurrency));
  const purchases = rawPurchases.map((inv) =>
    normalizeInvoice(inv, "purchase", fallbackPurchaseAccountId, defaultCurrency),
  );
  return [...sales, ...purchases];
}

export interface BankNormalizationContext {
  /** Map from Sage bank account id to its canonical ledger account id */
  bankAccountToLedgerAccountId: Map<string, string>;
  defaultCurrency?: string;
}

/**
 * Normalizes banking records from multiple Sage banking endpoints into BankTransaction[].
 */
export function normalizeBankMovements(
  inputs: {
    transfers?: SageBankTransfer[];
    contactPayments?: SageContactPayment[];
    otherPayments?: SageOtherPayment[];
    otherReceipts?: SageOtherReceipt[];
    genericTransactions?: SageRawBankTransaction[];
  },
  ctx: BankNormalizationContext,
): BankTransaction[] {
  const out: BankTransaction[] = [];
  const defaultCcy = ctx.defaultCurrency ?? "USD";

  const resolveBankAccountId = (rawBankId?: string): string => {
    if (!rawBankId) return "bank";
    const mapped = ctx.bankAccountToLedgerAccountId.get(rawBankId);
    return mapped ?? rawBankId;
  };

  // 1. Generic bank transactions (if source provides /bank_transactions)
  if (inputs.genericTransactions && inputs.genericTransactions.length > 0) {
    for (const tx of inputs.genericTransactions) {
      const rawBankId = tx.bank_account?.id ?? tx.bank_account_id;
      const bankLedgerId = resolveBankAccountId(rawBankId);
      const ccy = (tx.currency?.id ?? tx.currency_id ?? defaultCcy).trim().toUpperCase();

      const item: BankTransaction = {
        id: canonicalId(tx.id),
        source: "sage",
        sourceId: tx.id,
        bankAccountId: canonicalId(bankLedgerId),
        date: tx.date.slice(0, 10),
        amount: tx.amount,
        currency: ccy,
        description: (tx.description ?? tx.displayed_as ?? tx.reference ?? "Bank transaction").trim(),
      };

      const accId = tx.ledger_account?.id ?? tx.ledger_account_id;
      if (accId && accId.trim().length > 0) {
        item.accountId = canonicalId(accId.trim());
      }
      const partyId = tx.contact?.id ?? tx.contact_id;
      if (partyId && partyId.trim().length > 0) {
        item.partyId = canonicalId(partyId.trim());
      }
      if (tx.updated_at && tx.updated_at.trim().length > 0) {
        item.sourceUpdatedAt = tx.updated_at.trim();
      }
      out.push(item);
    }
    return out;
  }

  // 2. Bank Transfers (money moves from source to destination bank account)
  for (const tr of inputs.transfers ?? []) {
    const date = tr.date.slice(0, 10);
    const desc = (tr.description ?? tr.reference ?? tr.displayed_as ?? "Bank transfer").trim();
    const sourceBankId = resolveBankAccountId(tr.source_bank_account?.id ?? tr.source_bank_account_id);
    const destBankId = resolveBankAccountId(tr.destination_bank_account?.id ?? tr.destination_bank_account_id);
    const amount = Math.abs(tr.amount);

    // Outflow from source account (negative)
    const outItem: BankTransaction = {
      id: canonicalId(`${tr.id}-out`),
      source: "sage",
      sourceId: `${tr.id}-out`,
      bankAccountId: canonicalId(sourceBankId),
      date,
      amount: -amount,
      currency: defaultCcy,
      description: desc,
    };
    if (tr.updated_at) outItem.sourceUpdatedAt = tr.updated_at;
    out.push(outItem);

    // Inflow to destination account (positive)
    const inItem: BankTransaction = {
      id: canonicalId(`${tr.id}-in`),
      source: "sage",
      sourceId: `${tr.id}-in`,
      bankAccountId: canonicalId(destBankId),
      date,
      amount: amount,
      currency: defaultCcy,
      description: desc,
    };
    if (tr.updated_at) inItem.sourceUpdatedAt = tr.updated_at;
    out.push(inItem);
  }

  // 3. Contact Payments (Customer receipts: +amount, Vendor payments: -amount)
  for (const cp of inputs.contactPayments ?? []) {
    const rawBankId = cp.bank_account?.id ?? cp.bank_account_id;
    const bankLedgerId = resolveBankAccountId(rawBankId);
    const isVendor =
      (cp.transaction_type?.id ?? "").toUpperCase() === "VENDOR_PAYMENT" ||
      (cp.transaction_type?.displayed_as ?? "").toUpperCase().includes("VENDOR");
    const amount = isVendor ? -Math.abs(cp.total_amount) : Math.abs(cp.total_amount);
    const ccy = (cp.currency?.id ?? defaultCcy).trim().toUpperCase();

    const item: BankTransaction = {
      id: canonicalId(cp.id),
      source: "sage",
      sourceId: cp.id,
      bankAccountId: canonicalId(bankLedgerId),
      date: cp.date.slice(0, 10),
      amount,
      currency: ccy,
      description: (cp.reference ?? cp.displayed_as ?? (isVendor ? "Vendor payment" : "Customer receipt")).trim(),
    };

    const contactId = cp.contact?.id ?? cp.contact_id;
    if (contactId && contactId.trim().length > 0) {
      item.partyId = canonicalId(contactId.trim());
    }
    if (cp.updated_at && cp.updated_at.trim().length > 0) {
      item.sourceUpdatedAt = cp.updated_at.trim();
    }
    out.push(item);
  }

  // 4. Other Payments (money out to an expense account)
  for (const op of inputs.otherPayments ?? []) {
    const rawBankId = op.bank_account?.id ?? op.bank_account_id;
    const bankLedgerId = resolveBankAccountId(rawBankId);
    const ccy = (op.currency?.id ?? defaultCcy).trim().toUpperCase();
    const primaryLine = op.payment_lines?.[0];
    const accId = primaryLine?.ledger_account?.id ?? primaryLine?.ledger_account_id;

    const item: BankTransaction = {
      id: canonicalId(op.id),
      source: "sage",
      sourceId: op.id,
      bankAccountId: canonicalId(bankLedgerId),
      date: op.date.slice(0, 10),
      amount: -Math.abs(op.total_amount),
      currency: ccy,
      description: (primaryLine?.details ?? op.reference ?? op.displayed_as ?? "Payment").trim(),
    };

    if (accId && accId.trim().length > 0) {
      item.accountId = canonicalId(accId.trim());
    }
    const contactId = op.contact?.id ?? op.contact_id;
    if (contactId && contactId.trim().length > 0) {
      item.partyId = canonicalId(contactId.trim());
    }
    if (op.updated_at && op.updated_at.trim().length > 0) {
      item.sourceUpdatedAt = op.updated_at.trim();
    }
    out.push(item);
  }

  // 5. Other Receipts (money in from other income or deposits)
  for (const or of inputs.otherReceipts ?? []) {
    const rawBankId = or.bank_account?.id ?? or.bank_account_id;
    const bankLedgerId = resolveBankAccountId(rawBankId);
    const ccy = (or.currency?.id ?? defaultCcy).trim().toUpperCase();
    const primaryLine = or.receipt_lines?.[0];
    const accId = primaryLine?.ledger_account?.id ?? primaryLine?.ledger_account_id;

    const item: BankTransaction = {
      id: canonicalId(or.id),
      source: "sage",
      sourceId: or.id,
      bankAccountId: canonicalId(bankLedgerId),
      date: or.date.slice(0, 10),
      amount: Math.abs(or.total_amount),
      currency: ccy,
      description: (primaryLine?.details ?? or.reference ?? or.displayed_as ?? "Receipt").trim(),
    };

    if (accId && accId.trim().length > 0) {
      item.accountId = canonicalId(accId.trim());
    }
    const contactId = or.contact?.id ?? or.contact_id;
    if (contactId && contactId.trim().length > 0) {
      item.partyId = canonicalId(contactId.trim());
    }
    if (or.updated_at && or.updated_at.trim().length > 0) {
      item.sourceUpdatedAt = or.updated_at.trim();
    }
    out.push(item);
  }

  return out;
}
