/**
 * Sage OAuth 2.0 token management.
 *
 * Implements authorization code exchange, token refresh, and persistent storage
 * in `.data/sage-tokens.json` (which is gitignored).
 */

import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";

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
}

export const DEFAULT_SAGE_OAUTH_URL = "https://oauth.accounting.sage.com/token";
export const DEFAULT_SAGE_AUTH_CENTRAL_URL = "https://www.sageone.com/oauth2/auth/central";
export const DEFAULT_TOKEN_FILE = resolve(process.cwd(), ".data/sage-tokens.json");

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
  u.searchParams.set("scope", "full_access");
  u.searchParams.set("country", "gb");
  if (state) {
    u.searchParams.set("state", state);
  }
  return u.toString();
}

/**
 * Loads tokens from disk if present.
 */
export async function loadTokens(tokenPath = DEFAULT_TOKEN_FILE): Promise<SageTokenData | null> {
  try {
    const raw = await fs.readFile(tokenPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.access_token === "string" && typeof parsed.refresh_token === "string") {
      return parsed as SageTokenData;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Saves tokens to disk, ensuring the parent directory exists.
 */
export async function saveTokens(tokens: SageTokenData, tokenPath = DEFAULT_TOKEN_FILE): Promise<void> {
  const dir = dirname(tokenPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tokenPath, JSON.stringify(tokens, null, 2), "utf8");
}

/**
 * Exchanges an authorization code for access and refresh tokens.
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
    token_type?: string;
    scope?: string;
  };

  const tokens: SageTokenData = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 300) * 1000,
    token_type: data.token_type,
    scope: data.scope,
  };

  await saveTokens(tokens, tokenPath);
  return tokens;
}

/**
 * Refreshes an expired or expiring access token using the refresh token.
 */
export async function refreshTokens(
  refreshToken: string,
  config: SageOAuthConfig,
  tokenPath = DEFAULT_TOKEN_FILE,
): Promise<SageTokenData> {
  const tokenUrl = config.oauthUrl ?? DEFAULT_SAGE_OAUTH_URL;
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
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
    throw new Error(`Sage token refresh failed (HTTP ${res.status}): ${errorText}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type?: string;
    scope?: string;
  };

  const tokens: SageTokenData = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 300) * 1000,
    token_type: data.token_type,
    scope: data.scope,
  };

  await saveTokens(tokens, tokenPath);
  return tokens;
}

/**
 * Returns a valid access token, proactively refreshing it if expired or expiring within 30 seconds.
 */
export async function getValidAccessToken(
  config: SageOAuthConfig,
  tokenPath = DEFAULT_TOKEN_FILE,
): Promise<string> {
  const existing = await loadTokens(tokenPath);
  if (!existing) {
    throw new Error(`No Sage tokens found at ${tokenPath}. Run 'npm run sage:auth' to authorize.`);
  }

  // Proactively refresh if within 30s of expiry
  const now = Date.now();
  if (now >= existing.expires_at - 30_000) {
    const refreshed = await refreshTokens(existing.refresh_token, config, tokenPath);
    return refreshed.access_token;
  }

  return existing.access_token;
}
