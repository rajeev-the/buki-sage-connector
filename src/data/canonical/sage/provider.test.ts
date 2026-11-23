import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveTokens } from "./auth";
import { sageProvider } from "./provider";

describe("Sage Provider", () => {
  const testDir = resolve(process.cwd(), ".data/test-provider");
  const testTokenPath = resolve(testDir, "sage-tokens.json");

  const originalEnv = { ...process.env };

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
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
    process.env.SAGE_BUSINESS_ID = "biz-123";
    process.env.SAGE_TOKEN_PATH = testTokenPath;
    process.env.SAGE_RETRY_BASE_DELAY_MS = "0";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("reports healthy status when Sage responds", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/businesses")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ $items: [{ id: "biz-123", name: "Halden Labs UK" }] }),
        });
      }
      if (url.includes("/ledger_accounts")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            $items: [
              { id: "acc-1", name: "Operating account", ledger_account_type: { id: "bank" } },
              { id: "acc-2", name: "Sales", ledger_account_type: { id: "sales" } },
            ],
            $next: null,
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ $items: [], $next: null }) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const health = await sageProvider.health();
    expect(health.ok).toBe(true);
    expect(health.detail).toContain('Connected to "Halden Labs UK"');
  });

  it("reports failure detail when Sage cannot be reached", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Connection refused"));
    vi.stubGlobal("fetch", fetchMock);

    const health = await sageProvider.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("network");
  });

  it("pulls accounts, parties, and invoices end-to-end", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/ledger_accounts")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            $items: [{ id: "acc-100", name: "Operating", ledger_account_type: { id: "bank" } }],
            $next: null,
          }),
        });
      }
      if (url.includes("/contacts")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            $items: [{ id: "con-100", name: "Acme", contact_type_ids: ["CUSTOMER"] }],
            $next: null,
          }),
        });
      }
      if (url.includes("/sales_invoices")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            $items: [
              {
                id: "si-1",
                contact: { id: "con-100" },
                date: "2026-10-01",
                total_amount: 5000,
                outstanding_amount: 0,
                status: { id: "PAID" },
                invoice_lines: [{ description: "Plan", ledger_account: { id: "acc-100" }, net_amount: 5000 }],
              },
            ],
            $next: null,
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ $items: [], $next: null }) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const accounts = await sageProvider.accounts();
    const parties = await sageProvider.parties();
    const invoices = await sageProvider.invoices();

    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe("sage:acc-100");

    expect(parties).toHaveLength(1);
    expect(parties[0].id).toBe("sage:con-100");
    expect(parties[0].kind).toBe("customer");

    expect(invoices).toHaveLength(1);
    expect(invoices[0].id).toBe("sage:si-1");
    expect(invoices[0].status).toBe("paid");
  });
});
