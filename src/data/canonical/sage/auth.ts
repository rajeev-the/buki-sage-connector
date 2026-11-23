/**
 * Sage OAuth 2.0 token management and concurrency guard.
 *
 * Implements:
 * - Authorization code exchange & refresh token rotation
 * - Proactive expiry checking (with configurable skew buffer)
 * - Concurrency guard (in-flight promise lock preventing duplicate refreshes)
 * - Atomic persistence with secure POSIX permissions (0o600 on file, 0o700 on dir)
 * - Safe sanitization (never logs credentials)
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";

export interface SageTokenRecord {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO-8601 timestamp
  refreshTokenExpiresAt?: string;
  businessId?: string;
  businessName?: string;
  scope?: string;
  tokenType?: string;
}

// Backward-compatible alias for existing tests
export interface SageTokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix epoch ms
  token_type?: string;
  scope?: string;
  business_id?: string;
}

export interface SageOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  oauthUrl?: string;
  authorizeUrl?: string;
  tokenPath?: string;
  scope?: string;
  country?: string;
}

export const DEFAULT_SAGE_OAUTH_URL = "https://oauth.accounting.sage.com/token";
export const DEFAULT_SAGE_AUTH_CENTRAL_URL = "https://www.sageone.com/oauth2/auth/central";
export const DEFAULT_TOKEN_FILE = resolve(process.cwd(), ".data/sage-tokens.json");

/**
 * Creates a cryptographically secure random state string.
 */
export function createOAuthState(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Builds the Sage OAuth 2.0 authorization URL.
 */
export function buildAuthorizationUrl(config: SageOAuthConfig, state?: string): string {
  const authBase = config.authorizeUrl ?? DEFAULT_SAGE_AUTH_CENTRAL_URL;
  const u = new URL(authBase);
  u.searchParams.set("filter", "apiv3.1");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", config.clientId);
  u.searchParams.set("redirect_uri", config.callbackUrl);
  u.searchParams.set("scope", config.scope ?? "full_access");
  const country = config.country ?? process.env.SAGE_COUNTRY;
  if (country) {
    u.searchParams.set("country", country);
  }
  if (state) {
    u.searchParams.set("state", state);
  }
  return u.toString();
}

/**
 * Writes JSON file atomically with secure POSIX permissions (0o600 / 0o700).
 */
export async function writeSecureJson(filePath: string, payload: unknown): Promise<void> {
  const dir = dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), { mode: 0o600, encoding: "utf8" });
  try {
    await fs.chmod(tmpPath, 0o600);
  } catch {
    // ignore on platforms that do not support POSIX file mode changes
  }
  await fs.rename(tmpPath, filePath);
}

/**
 * Loads token record from disk, supporting both snake_case and camelCase formats.
 */
export async function loadTokenRecord(tokenPath = DEFAULT_TOKEN_FILE): Promise<SageTokenRecord | null> {
  try {
    const raw = await fs.readFile(tokenPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed) return null;

    const accessToken = parsed.accessToken ?? parsed.access_token;
    const refreshToken = parsed.refreshToken ?? parsed.refresh_token;

    if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
      return null;
    }

    let expiresAt: string;
    if (typeof parsed.expiresAt === "string") {
      expiresAt = parsed.expiresAt;
    } else if (typeof parsed.expires_at === "number") {
      expiresAt = new Date(parsed.expires_at).toISOString();
    } else {
      expiresAt = new Date(Date.now() + 300_000).toISOString();
    }

    return {
      accessToken,
      refreshToken,
      expiresAt,
      refreshTokenExpiresAt: parsed.refreshTokenExpiresAt ?? parsed.refresh_token_expires_at,
      businessId: parsed.businessId ?? parsed.business_id,
      businessName: parsed.businessName ?? parsed.business_name,
      scope: parsed.scope,
      tokenType: parsed.tokenType ?? parsed.token_type,
    };
  } catch {
    return null;
  }
}

/**
 * Backward-compatible token loader returning SageTokenData.
 */
export async function loadTokens(tokenPath = DEFAULT_TOKEN_FILE): Promise<SageTokenData | null> {
  const record = await loadTokenRecord(tokenPath);
  if (!record) return null;
  return {
    access_token: record.accessToken,
    refresh_token: record.refreshToken,
    expires_at: Date.parse(record.expiresAt),
    token_type: record.tokenType,
    scope: record.scope,
    business_id: record.businessId,
  };
}

/**
 * Saves token record or legacy SageTokenData to disk atomically with restrictive permissions.
 */
export async function saveTokens(
  tokens: SageTokenRecord | SageTokenData,
  tokenPath = DEFAULT_TOKEN_FILE,
): Promise<void> {
  let record: SageTokenRecord;
  if ("accessToken" in tokens) {
    record = tokens;
  } else {
    record = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(tokens.expires_at).toISOString(),
      tokenType: tokens.token_type,
      scope: tokens.scope,
      businessId: tokens.business_id,
    };
  }
  await writeSecureJson(tokenPath, record);
}

/**
 * Exchanges authorization code for access and refresh tokens.
 */
export async function exchangeCodeForTokens(
  code: string,
  config: SageOAuthConfig,
  tokenPath = DEFAULT_TOKEN_FILE,
): Promise<SageTokenData> {
  const tokenUrl = config.oauthUrl ?? DEFAULT_SAGE_OAUTH_URL;
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.callbackUrl,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Sage token exchange failed (HTTP ${res.status}): ${errorText}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    refresh_token_expires_in?: number;
    token_type?: string;
    scope?: string;
  };

  const now = Date.now();
  const record: SageTokenRecord = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(now + (data.expires_in ?? 300) * 1000).toISOString(),
    refreshTokenExpiresAt: data.refresh_token_expires_in
      ? new Date(now + data.refresh_token_expires_in * 1000).toISOString()
      : undefined,
    tokenType: data.token_type,
    scope: data.scope,
  };

  await saveTokens(record, tokenPath);

  return {
    access_token: record.accessToken,
    refresh_token: record.refreshToken,
    expires_at: Date.parse(record.expiresAt),
    token_type: record.tokenType,
    scope: record.scope,
  };
}

/**
 * Concurrency guard singleton and token manager.
 * Serializes in-flight refresh requests to avoid concurrent refresh collisions.
 */
export class SageTokenManager {
  private static refreshPromise: Promise<SageTokenRecord> | null = null;

  static async getValidAccessToken(
    config: SageOAuthConfig,
    tokenPath = DEFAULT_TOKEN_FILE,
    skewMs = 45_000,
  ): Promise<string> {
    const current = await loadTokenRecord(tokenPath);
    if (!current?.accessToken) {
      throw new Error(`No Sage access token available at ${tokenPath}. Run 'npm run sage:auth' first.`);
    }

    const expiresAtMs = Date.parse(current.expiresAt);
    if (!Number.isNaN(expiresAtMs) && Date.now() + skewMs < expiresAtMs) {
      return current.accessToken;
    }

    // Proactive serialized refresh
    const refreshed = await this.refreshOnce(config, tokenPath);
    return refreshed.accessToken;
  }

  static async refreshOnce(
    config: SageOAuthConfig,
    tokenPath = DEFAULT_TOKEN_FILE,
  ): Promise<SageTokenRecord> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.performRefresh(config, tokenPath).finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private static async performRefresh(
    config: SageOAuthConfig,
    tokenPath: string,
  ): Promise<SageTokenRecord> {
    const latest = await loadTokenRecord(tokenPath);
    if (!latest?.refreshToken) {
      throw new Error(`Missing Sage refresh token at ${tokenPath}. Please re-authenticate with 'npm run sage:auth'.`);
    }

    // Re-check after acquiring the lock: another caller might have completed the refresh already
    const expiresAtMs = Date.parse(latest.expiresAt);
    if (!Number.isNaN(expiresAtMs) && Date.now() + 30_000 < expiresAtMs) {
      return latest;
    }

    const tokenUrl = config.oauthUrl ?? DEFAULT_SAGE_OAUTH_URL;
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: latest.refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });

    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    });

    if (!res.ok) {
      const errorText = await res.text();
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        throw new Error(
          `Sage refresh token expired or revoked (HTTP ${res.status}): ${errorText}. Please run 'npm run sage:auth' to re-authorize.`,
        );
      }
      throw new Error(`Sage token refresh failed (HTTP ${res.status}): ${errorText}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      refresh_token_expires_in?: number;
      token_type?: string;
      scope?: string;
    };

    const now = Date.now();
    const rotatedRecord: SageTokenRecord = {
      ...latest,
      accessToken: data.access_token,
      // Sage rotates the refresh token on use; persist new refresh_token atomically
      refreshToken: data.refresh_token ?? latest.refreshToken,
      expiresAt: new Date(now + (data.expires_in ?? 300) * 1000).toISOString(),
      refreshTokenExpiresAt: data.refresh_token_expires_in
        ? new Date(now + data.refresh_token_expires_in * 1000).toISOString()
        : latest.refreshTokenExpiresAt,
      tokenType: data.token_type ?? latest.tokenType,
      scope: data.scope ?? latest.scope,
    };

    await saveTokens(rotatedRecord, tokenPath);
    return rotatedRecord;
  }
}

/**
 * Backward-compatible helper for refreshing tokens.
 */
export async function refreshTokens(
  refreshToken: string,
  config: SageOAuthConfig,
  tokenPath = DEFAULT_TOKEN_FILE,
): Promise<SageTokenData> {
  const record = await SageTokenManager.refreshOnce(config, tokenPath);
  return {
    access_token: record.accessToken,
    refresh_token: record.refreshToken,
    expires_at: Date.parse(record.expiresAt),
    token_type: record.tokenType,
    scope: record.scope,
    business_id: record.businessId,
  };
}

/**
 * Backward-compatible helper for obtaining a valid access token.
 */
export async function getValidAccessToken(
  config: SageOAuthConfig,
  tokenPath = DEFAULT_TOKEN_FILE,
): Promise<string> {
  return SageTokenManager.getValidAccessToken(config, tokenPath);
}
