/**
 * Interactive OAuth authorization script for Sage Accounting.
 *
 * Usage: npm run sage:auth
 *
 * Spins up a temporary HTTP listener on the port given by SAGE_CALLBACK_URL
 * (defaulting to http://localhost:3000/api/sage/callback), generates the Sage OAuth
 * authorization URL, catches the callback, exchanges the code for tokens, fetches
 * the business ID, and stores tokens in `.data/sage-tokens.json`.
 */

import { createServer } from "node:http";
import * as readline from "node:readline";
import { configFromEnv } from "./client";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  DEFAULT_TOKEN_FILE,
  type SageOAuthConfig,
} from "./auth";

async function fetchBusinesses(accessToken: string, baseUrl: string): Promise<Array<{ id: string; name: string }>> {
  try {
    const res = await fetch(`${baseUrl}/businesses`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { $items?: Array<{ id: string; name?: string; displayed_as?: string }> };
    return (data.$items ?? []).map((b) => ({ id: b.id, name: b.name ?? b.displayed_as ?? b.id }));
  } catch {
    return [];
  }
}

async function run(): Promise<void> {
  let sageConfig;
  try {
    sageConfig = configFromEnv();
  } catch (err) {
    console.error("Configuration error:", err instanceof Error ? err.message : String(err));
    console.error("Please configure SAGE_CLIENT_ID, SAGE_CLIENT_SECRET, and SAGE_CALLBACK_URL in .env");
    process.exit(1);
  }

  const oauthConfig: SageOAuthConfig = {
    clientId: sageConfig.clientId,
    clientSecret: sageConfig.clientSecret,
    callbackUrl: sageConfig.callbackUrl,
    oauthUrl: sageConfig.oauthUrl,
  };

  const callbackUrl = new URL(sageConfig.callbackUrl);
  const port = Number(callbackUrl.port || 3000);
  const pathname = callbackUrl.pathname || "/";
  const state = Math.random().toString(36).substring(2, 15);

  const authUrl = buildAuthorizationUrl(oauthConfig, state);

  console.log("=================================================");
  console.log("Sage Accounting OAuth 2.0 Authorization");
  console.log("=================================================");
  console.log("\n1. Open this URL in your browser:\n");
  console.log(`   ${authUrl}\n`);
  console.log(`2. Waiting for redirect on http://localhost:${port}${pathname} ...`);
  console.log("   (Or paste the returned 'code' parameter or full redirect URL below if running remotely)\n");

  let completed = false;

  const finishAuth = async (code: string): Promise<void> => {
    if (completed) return;
    completed = true;
    try {
      console.log("\nExchanging authorization code for tokens...");
      const tokens = await exchangeCodeForTokens(code, oauthConfig, sageConfig.tokenPath ?? DEFAULT_TOKEN_FILE);
      console.log(`✓ Tokens stored successfully at ${sageConfig.tokenPath ?? DEFAULT_TOKEN_FILE}`);

      const businesses = await fetchBusinesses(tokens.access_token, sageConfig.baseUrl);
      if (businesses.length > 0) {
        console.log("\nDiscovered Sage Businesses:");
        for (const b of businesses) {
          console.log(` - ${b.name}: ID = ${b.id}`);
        }
        console.log(`\nRecommended: Add SAGE_BUSINESS_ID=${businesses[0].id} to your .env`);
      } else {
        console.log("\nNotice: No businesses found or /businesses was not accessible. Please specify SAGE_BUSINESS_ID in .env.");
      }

      console.log("Add FINANCE_SOURCE=sage to your .env to enable Sage sync in Buki.");
      console.log("\nAuthorization complete!");
    } catch (err) {
      console.error("Error exchanging code:", err instanceof Error ? err.message : String(err));
    }
  };

  const server = createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (reqUrl.pathname === pathname) {
        const code = reqUrl.searchParams.get("code");
        const returnedState = reqUrl.searchParams.get("state");

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h1>Authorization failed</h1><p>Missing 'code' parameter in callback.</p>");
          return;
        }

        if (returnedState && returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h1>Authorization failed</h1><p>State parameter mismatch.</p>");
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Sage authorization successful!</h1><p>You can close this window and return to your terminal.</p>");

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
    rl.question("Paste callback URL or code here (or press Enter to keep waiting): ", async (answer) => {
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
