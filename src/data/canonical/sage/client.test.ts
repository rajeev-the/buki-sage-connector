import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveTokens } from "./auth";
import { configFromEnv, SageClient, SageError } from "./client";

describe("Sage Client", () => {
  const testDir = resolve(process.cwd(), ".data/test-client");
  const testTokenPath = resolve(testDir, "sage-tokens.json");

  const baseConfig = {
    baseUrl: "https://api.accounting.sage.com/v3.1",
    oauthUrl: "https://oauth.accounting.sage.com/token",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    callbackUrl: "http://localhost:3000/api/sage/callback",
    businessId: "biz-123",
    tokenPath: testTokenPath,
    retryBaseDelayMs: 0,
  };

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
    await saveTokens(
      {
        access_token: "mock-valid-token",
        refresh_token: "mock-refresh-token",
        expires_at: Date.now() + 100_000,
      },
      testTokenPath,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("fails configFromEnv if required secrets are missing", () => {
    expect(() => configFromEnv({})).toThrow(SageError);
    try {
      configFromEnv({});
    } catch (err) {
      expect((err as SageError).kind).toBe("config");
    }
  });

  it("sends Authorization and X-Business headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ $items: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new SageClient(baseConfig);
    await client.get("/ledger_accounts");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.accounting.sage.com/v3.1/ledger_accounts",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer mock-valid-token",
          "X-Business": "biz-123",
          Accept: "application/json",
        }),
      }),
    );
  });

  it("handles pagination following $next until null", async () => {
    const page1 = {
      $total: 3,
      $page: 1,
      $itemsPerPage: 2,
      $next: "https://api.accounting.sage.com/v3.1/ledger_accounts?page=2",
      $items: [{ id: "acc-1", name: "Account 1" }, { id: "acc-2", name: "Account 2" }],
    };
    const page2 = {
      $total: 3,
      $page: 2,
      $itemsPerPage: 2,
      $next: null,
      $items: [{ id: "acc-3", name: "Account 3" }],
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => page1 })
      .mockResolvedValueOnce({ ok: true, json: async () => page2 });
    vi.stubGlobal("fetch", fetchMock);

    const client = new SageClient(baseConfig);
    const items = await client.listAll<{ id: string; name: string }>("/ledger_accounts");

    expect(items).toHaveLength(3);
    expect(items.map((i) => i.id)).toEqual(["acc-1", "acc-2", "acc-3"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps 401 response to SageError with auth kind", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new SageClient(baseConfig);
    await expect(client.get("/ledger_accounts")).rejects.toMatchObject({
      kind: "auth",
      status: 401,
    });
  });

  it("maps 429 response to SageError with http kind", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ "retry-after": "60" }),
      text: async () => "Rate limit exceeded",
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new SageClient(baseConfig);
    await expect(client.get("/ledger_accounts")).rejects.toMatchObject({
      kind: "http",
      status: 429,
    });
  });

  it("maps network abort / timeout to timeout kind", async () => {
    const timeoutErr = new Error("The operation was aborted");
    timeoutErr.name = "TimeoutError";
    const fetchMock = vi.fn().mockRejectedValue(timeoutErr);
    vi.stubGlobal("fetch", fetchMock);

    const client = new SageClient(baseConfig);
    await expect(client.get("/ledger_accounts")).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("retries on transient HTTP 500 and succeeds on subsequent attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal server error",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ $items: [{ id: "acc-1" }] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = new SageClient(baseConfig);
    const data = await client.get<{ $items: Array<{ id: string }> }>("/ledger_accounts");

    expect(data.$items).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
