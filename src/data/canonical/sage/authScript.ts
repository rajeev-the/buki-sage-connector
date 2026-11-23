/**
 * Interactive OAuth 2.0 authorization CLI command for Sage Accounting.
 *
 * Usage: npm run sage:auth
 *
 * Implements:
 * 1. Cryptographically secure OAuth state generation.
 * 2. Sage authorization URL construction.
 * 3. Browser launching (with graceful manual fallback).
 * 4. Temporary local HTTP callback listener.
 * 5. State verification & code exchange.
 * 6. Multi-business discovery & interactive selection (never assumes index 0).
 * 7. Secure local persistence of tokens and business ID in .data/sage-tokens.json.
 * 8. Live connectivity validation (displaying safe diagnostic metrics only).
 */

import { exec } from "node:child_process";
import { createServer } from "node:http";
import * as readline from "node:readline";
import {
  buildAuthorizationUrl,
  createOAuthState,
  DEFAULT_TOKEN_FILE,
  exchangeCodeForTokens,
  loadTokenRecord,
  saveTokens,
  type SageOAuthConfig,
  type SageTokenRecord,
} from "./auth";
import { configFromEnv } from "./client";

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd = "";
  if (platform === "darwin") cmd = `open "${url}"`;
  else if (platform === "win32") cmd = `start "" "${url}"`;
  else cmd = `xdg-open "${url}"`;

  exec(cmd, () => {
    // If opening browser fails or is headless, the URL is printed to the terminal
  });
}

async function fetchBusinesses(
  accessToken: string,
  baseUrl: string,
): Promise<Array<{ id: string; name: string }>> {
  try {
    const res = await fetch(`${baseUrl}/businesses`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      $items?: Array<{ id: string; name?: string; displayed_as?: string }>;
    };
    return (data.$items ?? []).map((b) => ({
      id: b.id,
      name: b.name ?? b.displayed_as ?? b.id,
    }));
  } catch {
    return [];
  }
}

async function checkConnectivity(
  accessToken: string,
  baseUrl: string,
  businessId: string,
): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetch(`${baseUrl}/ledger_accounts?items_per_page=1`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Business": businessId,
        Accept: "application/json",
      },
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

function promptLine(promptText: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function run(): Promise<void> {
  let sageConfig;
  try {
    sageConfig = configFromEnv();
  } catch (err) {
    console.error("Configuration error:", err instanceof Error ? err.message : String(err));
    console.error("Please configure SAGE_CLIENT_ID, SAGE_CLIENT_SECRET, and SAGE_REDIRECT_URI in .env");
    process.exit(1);
  }

  const oauthConfig: SageOAuthConfig = {
    clientId: sageConfig.clientId,
    clientSecret: sageConfig.clientSecret,
    callbackUrl: sageConfig.callbackUrl,
    oauthUrl: sageConfig.oauthUrl,
    scope: process.env.SAGE_SCOPE || "full_access",
  };

  const callbackUrl = new URL(sageConfig.callbackUrl);
  const port = Number(callbackUrl.port || 3000);
  const pathname = callbackUrl.pathname || "/";
  const state = createOAuthState();

  const authUrl = buildAuthorizationUrl(oauthConfig, state);

  console.log("=================================================");
  console.log("Sage Accounting OAuth 2.0 Authorization");
  console.log("=================================================");
  console.log("\n1. Opening authorization in your browser...\n");
  console.log(`   ${authUrl}\n`);
  console.log(`2. Waiting for redirect callback on http://localhost:${port}${pathname} ...`);
  console.log("   (Or paste the authorization code or full callback URL below if running headless/remotely)\n");

  openBrowser(authUrl);

  let completed = false;

  const finishAuth = async (code: string): Promise<void> => {
    if (completed) return;
    completed = true;

    try {
      console.log("\nExchanging authorization code for tokens...");
      await exchangeCodeForTokens(code, oauthConfig, sageConfig.tokenPath ?? DEFAULT_TOKEN_FILE);

      const tokenRecord = await loadTokenRecord(sageConfig.tokenPath ?? DEFAULT_TOKEN_FILE);
      if (!tokenRecord) {
        throw new Error("Failed to load saved tokens after exchange.");
      }

      console.log("Discovering accessible Sage businesses...");
      const businesses = await fetchBusinesses(tokenRecord.accessToken, sageConfig.baseUrl);

      let selectedBusiness: { id: string; name: string } | null = null;

      if (businesses.length === 0) {
        console.log("Notice: No businesses returned by GET /businesses or endpoint requires configured business ID.");
        const manualId = sageConfig.businessId || (await promptLine("Enter your Sage Business ID (GUID): "));
        selectedBusiness = { id: manualId, name: "Sage Trial Business" };
      } else if (businesses.length === 1) {
        selectedBusiness = businesses[0];
        console.log(`Found 1 business: "${selectedBusiness.name}" (ID: ${selectedBusiness.id})`);
      } else {
        console.log(`\nFound ${businesses.length} businesses on this Sage account:`);
        businesses.forEach((b, idx) => {
          console.log(`  [${idx + 1}] ${b.name} (ID: ${b.id})`);
        });

        let choice = 0;
        while (choice < 1 || choice > businesses.length) {
          const input = await promptLine(`Select business to connect [1-${businesses.length}]: `);
          choice = Number(input);
          if (Number.isNaN(choice) || choice < 1 || choice > businesses.length) {
            console.log("Invalid selection. Please enter a valid number.");
          }
        }
        selectedBusiness = businesses[choice - 1];
      }

      // Persist chosen business ID and metadata
      const updatedRecord: SageTokenRecord = {
        ...tokenRecord,
        businessId: selectedBusiness.id,
        businessName: selectedBusiness.name,
      };
      await saveTokens(updatedRecord, sageConfig.tokenPath ?? DEFAULT_TOKEN_FILE);

      // Perform connectivity check
      console.log("\nRunning connectivity check with business context...");
      const check = await checkConnectivity(tokenRecord.accessToken, sageConfig.baseUrl, selectedBusiness.id);

      console.log("\n=================================================");
      console.log("Authentication status: Authentication successful");
      console.log(`Selected business:     ${selectedBusiness.name}`);
      console.log(`Business ID:           ${selectedBusiness.id}`);
      console.log(
        `API connectivity:      ${check.ok ? `Connected (HTTP ${check.status})` : `Failed (HTTP ${check.status})`}`,
      );
      console.log(`Access token expires:  ${tokenRecord.expiresAt}`);
      console.log("=================================================");
      console.log("\nSetup complete! You can now run:");
      console.log("  npm run health");
      console.log("  npm run sync");
      console.log('  npm run ask -- "who owes us money"\n');
    } catch (err) {
      console.error("\nAuthentication failed:", err instanceof Error ? err.message : String(err));
    }
  };

  const server = createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (reqUrl.pathname === pathname) {
        const error = reqUrl.searchParams.get("error");
        const code = reqUrl.searchParams.get("code");
        const returnedState = reqUrl.searchParams.get("state");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<h1>Sage authorization failed</h1><p>Error: ${error}</p>`);
          server.close();
          console.error(`Sage OAuth error: ${error}`);
          process.exit(1);
        }

        if (!state || returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h1>Invalid OAuth state</h1><p>State parameter mismatch. Please retry.</p>");
          server.close();
          console.error("OAuth state mismatch during callback verification.");
          process.exit(1);
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h1>Missing authorization code</h1><p>No code returned.</p>");
          server.close();
          console.error("Missing code in callback.");
          process.exit(1);
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<h1>Sage authorization successful!</h1><p>You can close this window and return to your terminal.</p>",
        );

        server.close();
        await finishAuth(code);
        process.exit(0);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Internal error: ${String(err)}`);
    }
  });

  server.listen(port, () => {
    // Also listen on stdin for manual input
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Paste callback URL or authorization code here (or press Enter to wait): ", async (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (!trimmed) return;

      let code = trimmed;
      if (trimmed.includes("code=")) {
        try {
          const u = new URL(trimmed.startsWith("http") ? trimmed : `http://localhost?${trimmed}`);
          code = u.searchParams.get("code") ?? trimmed;
        } catch {
          // ignore
        }
      }

      server.close();
      await finishAuth(code);
      process.exit(0);
    });
  });
}

if (process.argv[1] && process.argv[1].endsWith("authScript.ts")) {
  run().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
