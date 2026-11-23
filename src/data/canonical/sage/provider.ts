/**
 * The Sage Finance provider: wires SageClient + normalize.
 *
 * Implements FinanceProvider interface for Buki.
 */

import type { FinanceProvider, ProviderHealth } from "../providers/types";
import type { BankTransaction, Invoice, LedgerAccount, Party } from "../types";
import { configFromEnv, SageClient, SageError, describe } from "./client";
import {
  normalizeAccounts,
  normalizeBankMovements,
  normalizeInvoices,
  normalizeParties,
} from "./normalize";

export const sageProvider: FinanceProvider = {
  source: "sage",

  async health(): Promise<ProviderHealth> {
    try {
      const config = configFromEnv();
      const client = new SageClient(config);

      const [businesses, accounts] = await Promise.all([
        client.businesses(),
        client.ledgerAccounts(),
      ]);

      const activeBiz = businesses.find((b) => b.id === config.businessId) ?? businesses[0];
      const bizName = activeBiz ? `"${activeBiz.name}"` : "Sage business";

      return {
        ok: true,
        detail: `Connected to ${bizName} (${accounts.length} ledger accounts on file) at ${config.baseUrl}`,
      };
    } catch (err) {
      const kind = err instanceof SageError ? err.kind : "unknown";
      return { ok: false, detail: `${kind}: ${describe(err)}` };
    }
  },

  async accounts(): Promise<LedgerAccount[]> {
    const client = new SageClient(configFromEnv());
    const [rawLedgers, rawBanks] = await Promise.all([
      client.ledgerAccounts(),
      client.bankAccounts().catch(() => []),
    ]);
    return normalizeAccounts(rawLedgers, rawBanks);
  },

  async parties(): Promise<Party[]> {
    const client = new SageClient(configFromEnv());
    const contacts = await client.contacts();
    return normalizeParties(contacts);
  },

  async invoices(since?: string): Promise<Invoice[]> {
    const client = new SageClient(configFromEnv());
    const [sales, purchases] = await Promise.all([
      client.salesInvoices(since),
      client.purchaseInvoices(since),
    ]);
    return normalizeInvoices(sales, purchases);
  },

  async bankTransactions(since?: string): Promise<BankTransaction[]> {
    const client = new SageClient(configFromEnv());
    const rawBanks = await client.bankAccounts().catch(() => []);

    const bankAccountToLedgerAccountId = new Map<string, string>();
    for (const b of rawBanks) {
      const ledgerId = b.ledger_account?.id ?? b.id;
      bankAccountToLedgerAccountId.set(b.id, ledgerId);
    }

    // Try generic bank transactions first
    const generic = await client.genericBankTransactions(since).catch(() => []);
    if (generic.length > 0) {
      return normalizeBankMovements({ genericTransactions: generic }, { bankAccountToLedgerAccountId });
    }

    // Otherwise, pull transfers, contact payments, other payments, and other receipts
    const [transfers, contactPayments, otherPayments, otherReceipts] = await Promise.all([
      client.bankTransfers(since).catch(() => []),
      client.contactPayments(since).catch(() => []),
      client.otherPayments(since).catch(() => []),
      client.otherReceipts(since).catch(() => []),
    ]);

    return normalizeBankMovements(
      {
        transfers,
        contactPayments,
        otherPayments,
        otherReceipts,
      },
      { bankAccountToLedgerAccountId },
    );
  },
};
