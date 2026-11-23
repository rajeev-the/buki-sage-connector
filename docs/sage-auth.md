# Sage Accounting OAuth Authentication & Setup Guide

This guide walks through connecting your Sage Accounting trial business to the Buki Connector Kit using the OAuth 2.0 flow.

---

## 1. Sage Developer Application Setup

1. **Log in to Sage Developer Portal:**
   - Go to [https://developerselfservice.sageone.com/](https://developerselfservice.sageone.com/) and log in with your Sage account.

2. **Create / Register an Application:**
   - Click **Create App** (or select your existing app).
   - Enter an Application Name (e.g. `Buki Sage Connector`).
   - In the **Callback URLs / Redirect URIs** field, enter:
     ```text
     http://localhost:3000/api/sage/callback
     ```
   - Save the application.

3. **Retrieve Credentials:**
   - Locate your **Client ID** and **Client Secret**.

---

## 2. Environment Configuration

1. In the root directory of `buki-connector-kit`, ensure your `.env` file contains:

```env
# Enable Sage as the Finance provider
FINANCE_SOURCE=sage

# Sage Developer Credentials
SAGE_CLIENT_ID=your_client_id_here
SAGE_CLIENT_SECRET=your_client_secret_here

# Redirect URI (must match the URI registered in Sage Developer portal)
SAGE_CALLBACK_URL=http://localhost:3000/api/sage/callback
# Or alternatively:
# SAGE_REDIRECT_URI=http://localhost:3000/api/sage/callback

# Optional: SAGE_BUSINESS_ID will be automatically detected and saved by `npm run sage:auth`
# SAGE_BUSINESS_ID=
```

> **Note:** Never commit `.env` or files under `.data/` to version control.

---

## 3. Execute the OAuth CLI Authentication

Run the interactive authentication script:

```bash
npm run sage:auth
```

### What Happens:
1. A cryptographically secure `state` parameter is generated.
2. A temporary local HTTP callback listener starts on port `3000` waiting for `http://localhost:3000/api/sage/callback`.
3. The authorization URL opens automatically in your default browser:
   - If the browser does not open automatically, copy the URL displayed in the terminal and paste it into your browser.
4. **Log in to Sage** in the browser window and authorize your trial business.
5. Sage redirects back to `http://localhost:3000/api/sage/callback?code=...&state=...`.
6. The CLI intercepts the authorization code, verifies the state, and exchanges it for:
   - `access_token`
   - `refresh_token`
   - Token expiry timestamps
7. The CLI queries the Sage API for accessible businesses:
   - If multiple businesses exist, an interactive prompt lets you choose your trial business.
8. Tokens and the chosen business ID are saved with secure POSIX permissions (`0o600`) to `.data/sage-tokens.json`.
9. An automated connectivity check runs against Sage Accounting API to verify the connection.

---

## 4. Verification and Sync

Once authenticated, verify and test the connector:

1. **Verify Health:**
   ```bash
   npm run health
   ```
   Output will confirm `finance: ok` with business context.

2. **Trigger Initial Synchronization:**
   ```bash
   npm run sync
   ```
   This synchronizes accounts, contacts (parties), sales/purchase invoices, and bank transactions from Sage into `.data/store.json`.

3. **Ask Finance Questions:**
   ```bash
   npm run ask -- "who owes us money"
   npm run ask -- "what did we spend on software last month"
   ```

---

## 5. Troubleshooting

- **Error: `redirect_uri_mismatch`:**
  - Verify that `http://localhost:3000/api/sage/callback` is listed in your Sage Developer application settings under Redirect URIs.
- **Port 3000 in use:**
  - If another process is listening on port 3000, you can copy the full callback URL from your browser's address bar and paste it directly into the terminal prompt.
- **Token Refresh & Expiration:**
  - Sage access tokens expire after 5 minutes (300 seconds). The connector includes an automatic token manager that transparently refreshes expired tokens using the refresh token, with rotation support and concurrency locking.
- **Mock Mode Testing:**
  - For offline development and testing, run the mock Sage server:
    ```bash
    npm run mock:sage
    ```
