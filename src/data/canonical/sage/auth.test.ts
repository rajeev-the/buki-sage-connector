import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  getValidAccessToken,
  loadTokens,
  refreshTokens,
  saveTokens,
  type SageOAuthConfig,
  type SageTokenData,
} from "./auth";

describe("Sage OAuth Auth", () => {
  const testDir = resolve(process.cwd(), ".data/test-auth");
  const testTokenPath = resolve(testDir, "sage-tokens.test.json");

  const sampleConfig: SageOAuthConfig = {
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    callbackUrl: "http://localhost:3000/api/sage/callback",
    oauthUrl: "https://oauth.accounting.sage.com/token",
  };

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("buildAuthorizationUrl includes required Sage OAuth query params", () => {
    const url = buildAuthorizationUrl(sampleConfig, "xyz-state");
    const u = new URL(url);

    expect(u.origin).toBe("https://www.sageone.com");
    expect(u.pathname).toBe("/oauth2/auth/central");
    expect(u.searchParams.get("filter")).toBe("apiv3.1");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("test-client-id");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/sage/callback");
    expect(u.searchParams.get("state")).toBe("xyz-state");
    expect(u.searchParams.get("scope")).toBe("full_access");
  });

  it("saves and loads tokens to disk", async () => {
    const tokens: SageTokenData = {
      access_token: "acc-123",
      refresh_token: "ref-456",
      expires_at: Date.now() + 300_000,
    };

    await saveTokens(tokens, testTokenPath);
    const loaded = await loadTokens(testTokenPath);

    expect(loaded).toEqual(tokens);
  });

  it("returns null when loading non-existent token file", async () => {
    const loaded = await loadTokens(resolve(testDir, "missing.json"));
    expect(loaded).toBeNull();
  });

  it("exchanges authorization code via POST to oauth endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 300,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await exchangeCodeForTokens("test-auth-code", sampleConfig, testTokenPath);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth.accounting.sage.com/token",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(tokens.access_token).toBe("new-access-token");
    expect(tokens.refresh_token).toBe("new-refresh-token");

    const onDisk = await loadTokens(testTokenPath);
    expect(onDisk?.access_token).toBe("new-access-token");
  });

  it("proactively refreshes expired tokens in getValidAccessToken", async () => {
    const expiredTokens: SageTokenData = {
      access_token: "old-access",
      refresh_token: "valid-refresh",
      expires_at: Date.now() - 10_000, // already expired
    };
    await saveTokens(expiredTokens, testTokenPath);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "fresh-access-token",
        refresh_token: "next-refresh-token",
        expires_in: 300,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const validToken = await getValidAccessToken(sampleConfig, testTokenPath);

    expect(validToken).toBe("fresh-access-token");
    expect(fetchMock).toHaveBeenCalled();
  });
});
