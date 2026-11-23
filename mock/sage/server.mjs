// Mock Sage Accounting API v3.1.
// Mirrors the OAuth endpoint and the v3.1 resource endpoints with the real API's paths and envelope shapes.
// Re-reads mock/sage/data/sage.json on every request so editing the data file simulates a change made in Sage.

import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadDotEnv } from "../../scripts/env.mjs";

loadDotEnv();

const PORT = Number(process.env.MOCK_SAGE_PORT) || 4020;
const DATA_FILE = join(dirname(fileURLToPath(import.meta.url)), "data", "sage.json");

function readData() {
  return JSON.parse(readFileSync(DATA_FILE, "utf8"));
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function paginate(items, url, path) {
  const itemsPerPage = Number(url.searchParams.get("items_per_page")) || 100;
  const page = Number(url.searchParams.get("page")) || 1;
  const since = url.searchParams.get("updated_or_created_since");

  let filtered = items;
  if (since && !Number.isNaN(Date.parse(since))) {
    const sinceMs = Date.parse(since);
    filtered = items.filter((item) => {
      const updated = item.updated_at || item.created_at;
      return updated && Date.parse(updated) >= sinceMs;
    });
  }

  const start = (page - 1) * itemsPerPage;
  const slice = filtered.slice(start, start + itemsPerPage);
  const hasNext = start + itemsPerPage < filtered.length;

  const nextUrl = hasNext
    ? `http://localhost:${PORT}${path}?page=${page + 1}&items_per_page=${itemsPerPage}`
    : null;

  return {
    $total: filtered.length,
    $page: page,
    $itemsPerPage: itemsPerPage,
    $next: nextUrl,
    $back: page > 1 ? `http://localhost:${PORT}${path}?page=${page - 1}&items_per_page=${itemsPerPage}` : null,
    $items: slice,
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const log = (status) => console.log(`[mock-sage] ${req.method} ${url.pathname}${url.search} -> ${status}`);

  // 1. OAuth token endpoint
  if (req.method === "POST" && (url.pathname === "/token" || url.pathname === "/oauth/token")) {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      log(200);
      send(res, 200, {
        access_token: "mock-sage-access-token",
        refresh_token: "mock-sage-refresh-token",
        token_type: "bearer",
        expires_in: 300,
        scope: "full_access",
      });
    });
    return;
  }

  // 2. Bearer auth check for API routes
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    log(401);
    return send(
      res,
      401,
      { error: "unauthorized", detail: "Bearer token required" },
      { "WWW-Authenticate": 'Bearer realm="Sage"' },
    );
  }

  const data = readData();

  if (url.pathname === "/businesses") {
    log(200);
    return send(res, 200, { $items: data.businesses || [] });
  }

  if (url.pathname === "/ledger_accounts") {
    log(200);
    return send(res, 200, paginate(data.ledger_accounts || [], url, "/ledger_accounts"));
  }

  if (url.pathname === "/bank_accounts") {
    log(200);
    return send(res, 200, paginate(data.bank_accounts || [], url, "/bank_accounts"));
  }

  if (url.pathname === "/contacts") {
    log(200);
    return send(res, 200, paginate(data.contacts || [], url, "/contacts"));
  }

  if (url.pathname === "/sales_invoices") {
    log(200);
    return send(res, 200, paginate(data.sales_invoices || [], url, "/sales_invoices"));
  }

  if (url.pathname === "/purchase_invoices") {
    log(200);
    return send(res, 200, paginate(data.purchase_invoices || [], url, "/purchase_invoices"));
  }

  if (url.pathname === "/bank_transactions") {
    log(200);
    return send(res, 200, paginate(data.bank_transactions || [], url, "/bank_transactions"));
  }

  // Fallbacks for specific banking endpoints if queried
  if (url.pathname === "/bank_transfers" || url.pathname === "/contact_payments" || url.pathname === "/other_payments" || url.pathname === "/other_receipts") {
    log(200);
    return send(res, 200, paginate([], url, url.pathname));
  }

  log(404);
  return send(res, 404, { error: "not_found", path: url.pathname });
});

server.listen(PORT, () => {
  console.log(`Mock Sage Accounting API listening on http://localhost:${PORT}`);
});
