/**
 * Sage Accounting HTTP client.
 *
 * Implements:
 * - OAuth 2.0 token management and automatic refresh
 * - Envelope pagination (following $next)
 * - Request timeouts (10s) and typed SageError
 * - Incremental sync parameters (updated_or_created_since)
 * - Returns raw wire shapes only; canonical transformation lives in normalize.ts.
 */

import { getValidAccessToken, type SageOAuthConfig, DEFAULT_TOKEN_FILE } from "./auth";
import type {
  SageBankAccount,
  SageBankTransfer,
  SageBusiness,
  SageContact,
  SageContactPayment,
  SageInvoice,
  SageLedgerAccount,
  SageListEnvelope,
  SageOtherPayment,
  SageOtherReceipt,
  SageRawBankTransaction,
} from "./raw/types";

export type SageErrorKind = "config" | "auth" | "http" | "network" | "timeout" | "shape";

export class SageError extends Error {
  constructor(
    public readonly kind: SageErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SageError";
  }
}

export interface SageConfig {
  baseUrl: string;
  oauthUrl: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  businessId?: string;
  tokenPath?: string;
}

const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_PAGE_SIZE = 100;

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SageConfig {
  const clientId = env.SAGE_CLIENT_ID;
  const clientSecret = env.SAGE_CLIENT_SECRET;
  const baseUrl = (env.SAGE_BASE_URL ?? "https://api.accounting.sage.com/v3.1").replace(/\/+$/, "");
  const oauthUrl = env.SAGE_OAUTH_URL ?? "https://oauth.accounting.sage.com/token";
  const callbackUrl = env.SAGE_CALLBACK_URL ?? "http://localhost:3000/api/sage/callback";
  const businessId = env.SAGE_BUSINESS_ID?.trim() || undefined;
  const tokenPath = env.SAGE_TOKEN_PATH || DEFAULT_TOKEN_FILE;

  if (!clientId || !clientSecret) {
    throw new SageError("config", "SAGE_CLIENT_ID and SAGE_CLIENT_SECRET must be set in .env");
  }

  return {
    baseUrl,
    oauthUrl,
    clientId,
    clientSecret,
    callbackUrl,
    businessId,
    tokenPath,
  };
}

export class SageClient {
  constructor(private readonly config: SageConfig) {}

  private async getAccessToken(): Promise<string> {
    const oauthConfig: SageOAuthConfig = {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      callbackUrl: this.config.callbackUrl,
      oauthUrl: this.config.oauthUrl,
    };
    try {
      return await getValidAccessToken(oauthConfig, this.config.tokenPath);
    } catch (err) {
      throw new SageError("auth", `Sage authorization error: ${describe(err)}`);
    }
  }

  private resolveUrl(pathOrUrl: string, query?: Record<string, string>): string {
    const isFullUrl = pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://");
    const u = isFullUrl ? new URL(pathOrUrl) : new URL(`${this.config.baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      u.searchParams.set(k, v);
    }
    return u.toString();
  }

  async get<T>(pathOrUrl: string, query?: Record<string, string>): Promise<T> {
    const token = await this.getAccessToken();
    const url = this.resolveUrl(pathOrUrl, query);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };

    if (this.config.businessId && !url.includes("/businesses")) {
      headers["X-Business"] = this.config.businessId;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new SageError("timeout", `Sage did not answer ${pathOrUrl} within ${REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw new SageError("network", `Could not reach Sage API: ${describe(err)}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new SageError("auth", `Sage rejected the token or access was denied (HTTP ${res.status})`, res.status);
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after") ?? "rate limit reached";
      throw new SageError("http", `Sage rate limit reached (HTTP 429, retry-after: ${retryAfter})`, 429);
    }

    if (!res.ok) {
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch {
        // ignore
      }
      throw new SageError(
        "http",
        `Sage answered ${pathOrUrl} with HTTP ${res.status}${bodyText ? `: ${bodyText}` : ""}`,
        res.status,
      );
    }

    try {
      return (await res.json()) as T;
    } catch {
      throw new SageError("shape", `Sage answered ${pathOrUrl} with non-JSON response`);
    }
  }

  /**
   * Follows envelope pagination until exhausted, returning all items.
   */
  async listAll<T>(endpoint: string, baseQuery: Record<string, string> = {}): Promise<T[]> {
    const items: T[] = [];
    let currentUrl: string | null = endpoint;
    let query: Record<string, string> | undefined = {
      items_per_page: String(DEFAULT_PAGE_SIZE),
      ...baseQuery,
    };

    while (currentUrl) {
      const envelope: SageListEnvelope<T> = await this.get<SageListEnvelope<T>>(currentUrl, query);
      if (!envelope || !Array.isArray(envelope.$items)) {
        // If single item or alternate shape, fall back or error
        if (Array.isArray(envelope)) {
          return envelope as unknown as T[];
        }
        throw new SageError("shape", `Envelope from ${endpoint} missing $items array`);
      }

      items.push(...envelope.$items);

      // Subsequent pagination requests follow $next without reapplying initial query
      currentUrl = envelope.$next;
      query = undefined;
    }

    return items;
  }

  async businesses(): Promise<SageBusiness[]> {
    try {
      const res = await this.get<{ $items?: SageBusiness[] }>("/businesses");
      return res.$items ?? [];
    } catch {
      return [];
    }
  }

  async ledgerAccounts(since?: string): Promise<SageLedgerAccount[]> {
    const query: Record<string, string> = {};
    if (since) query.updated_or_created_since = since;
    return this.listAll<SageLedgerAccount>("/ledger_accounts", query);
  }

  async bankAccounts(since?: string): Promise<SageBankAccount[]> {
    const query: Record<string, string> = {};
    if (since) query.updated_or_created_since = since;
    return this.listAll<SageBankAccount>("/bank_accounts", query);
  }

  async contacts(since?: string): Promise<SageContact[]> {
    const query: Record<string, string> = {};
    if (since) query.updated_or_created_since = since;
    return this.listAll<SageContact>("/contacts", query);
  }

  async salesInvoices(since?: string): Promise<SageInvoice[]> {
    const query: Record<string, string> = {};
    if (since) query.updated_or_created_since = since;
    return this.listAll<SageInvoice>("/sales_invoices", query);
  }

  async purchaseInvoices(since?: string): Promise<SageInvoice[]> {
    const query: Record<string, string> = {};
    if (since) query.updated_or_created_since = since;
    return this.listAll<SageInvoice>("/purchase_invoices", query);
  }

  async bankTransfers(since?: string): Promise<SageBankTransfer[]> {
    const query: Record<string, string> = {};
    if (since) query.updated_or_created_since = since;
    try {
      return await this.listAll<SageBankTransfer>("/bank_transfers", query);
    } catch (err) {
      if (err instanceof SageError && err.status === 404) return [];
      throw err;
    }
  }

  async contactPayments(since?: string): Promise<SageContactPayment[]> {
    const query: Record<string, string> = {};
    if (since) query.updated_or_created_since = since;
    try {
      return await this.listAll<SageContactPayment>("/contact_payments", query);
    } catch (err) {
      if (err instanceof SageError && err.status === 404) return [];
      throw err;
    }
  }

  async otherPayments(since?: string): Promise<SageOtherPayment[]> {
    const query: Record<string, string> = {};
    if (since) query.updated_or_created_since = since;
    try {
      return await this.listAll<SageOtherPayment>("/other_payments", query);
    } catch (err) {
      if (err instanceof SageError && err.status === 404) return [];
      throw err;
    }
  }

  async otherReceipts(since?: string): Promise<SageOtherReceipt[]> {
    const query: Record<string, string> = {};
    if (since) query.updated_or_created_since = since;
    try {
      return await this.listAll<SageOtherReceipt>("/other_receipts", query);
    } catch (err) {
      if (err instanceof SageError && err.status === 404) return [];
      throw err;
    }
  }

  async genericBankTransactions(since?: string): Promise<SageRawBankTransaction[]> {
    const query: Record<string, string> = {};
    if (since) query.updated_or_created_since = since;
    try {
      return await this.listAll<SageRawBankTransaction>("/bank_transactions", query);
    } catch (err) {
      if (err instanceof SageError && err.status === 404) return [];
      throw err;
    }
  }
}

export function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message;
  }
  return String(err);
}
