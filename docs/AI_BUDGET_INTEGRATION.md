# AI Budget Integration

Connects a user's AI Budget Assistant (a personal and business budgeting app) to eKsięgowy AI, read-mostly, through the AI Budget public API (`/public/v1`). Spec: `docs/superpowers/specs/2026-11-02-ai-budget-integration-design.md` (binding). Code: `packages/api/src/services/ai-budget/` (`AiBudget*` services), routes in `packages/api/src/routes/ai-budget.routes.ts`, web UI under `packages/web/src/app/settings/integrations/`.

## Overview and the never-mix rule

One AI Budget user can own several accounts (company, a second business, private, shared, trips). The integration exposes them in the dashboard, in the AI chat and in a reconciliation of expenses against wFirma documents.

**Company money and private money never mix.** No private or other-business expense may reach a company figure, a company chat answer, the reconciliation, or any wFirma write. Every code path that produces a company figure resolves the account through `getCompanyAccount` and nothing else.

## Labels and the one-company rule

Every connected account has exactly one of three labels: `company`, `other_business`, `private`.

- At most one `company` per connection, enforced by a partial unique index in the DB. Choosing a new company demotes the previous one to `other_business`.
- Automatic labelling: a single `business` account becomes `company`; with several `business` accounts and none chosen, all are `other_business` and the connection has `needsCompanyChoice = true` (the UI asks the user to choose); every other type (`personal`, `shared`, `trip`, `investment`) is `private`.
- A manual label always wins over the automatic one (a manual `company` on a non-business account is allowed).
- An **unavailable** account (AI Budget returns null `name`/`type` because the grantor lost membership) is never company and loses the label.
- An **inactive but visible** account (grant inactive, viewer role, archived) keeps a prior company label, blocks auto-promotion of another account, keeps its mirror, and is excluded from figures (`getCompanyAccount` returns nothing for it). The company must not silently switch.

## OAuth flow and environment

Authorization code + PKCE `S256`, confidential client, scopes exactly `expenses:read expenses:write categories:read receipts:read`.

1. `POST /api/integrations/ai-budget/connect` (authenticated) stores a single-use `state` (bound to the user id, 600 s) and the PKCE verifier in Redis and returns the AI Budget authorize URL.
2. The user consents in AI Budget. AI Budget redirects the browser to `GET /api/integrations/ai-budget/callback`. The API does **not** exchange the code there: it validates the state shape and 302-redirects to `${FRONTEND_URL}/settings/integrations/ai-budget/complete?code&state` (or to the error redirect).
3. The web page `/settings/integrations/ai-budget/complete` immediately drops `code`/`state` from the URL (`history.replaceState`), sets a no-referrer policy (a Next metadata meta tag, not an HTTP header) and POSTs `{code, state}` to the authenticated `POST /api/integrations/ai-budget/complete`. That endpoint `GETDEL`s the state, requires `bound.userId === req.user.userId`, exchanges the code and stores the tokens. This binds the grant to the logged-in browser user, so a pasted callback link cannot connect someone else's AI Budget to your account.
4. The page routes to `/settings/integrations?ai_budget=connected` or `?ai_budget=error&reason=<code>`.

### Environment

| Variable | Notes |
|---|---|
| `AI_BUDGET_CLIENT_ID` | OAuth client id from AI Budget |
| `AI_BUDGET_CLIENT_SECRET` | OAuth client secret |
| `AI_BUDGET_API_URL` | default `https://api.ai-budget.pl` |
| `AI_BUDGET_AUTHORIZE_URL` | default `https://app.ai-budget.pl/authorize` |
| `BACKEND_URL` | **must equal `https://api.eksiegowyai.pl` in prod**: the redirect URI is `${BACKEND_URL}/api/integrations/ai-budget/callback` |
| `FRONTEND_URL` | where the browser is sent to finish the connection |
| `CREDENTIALS_ENCRYPTION_KEY` | required (tokens and cached data are encrypted with it) |

If the client id, the secret, `BACKEND_URL`, `FRONTEND_URL` or `CREDENTIALS_ENCRYPTION_KEY` is missing the feature is **hidden**: `available: false` from `/status`, no chat tools, no dashboard cards.

**Redis must be 6.2 or newer** (`GETDEL` is used for the single-use state). The prod compose file already uses `redis:7-alpine`, so this is met; check it only if Redis is changed.

### Registering the app in AI Budget

In AI Budget: Settings → Developers → create an application. Type: **confidential** client. Redirect URI: exactly `https://api.eksiegowyai.pl/api/integrations/ai-budget/callback` (no trailing slash, byte for byte). Scopes: `expenses:read expenses:write categories:read receipts:read`. Put the issued id and secret in `.env.production` and force-recreate the `api` service (`docker restart` does not reload env).

## Tokens, refresh and the lock

- Access and refresh tokens are AES-256-GCM-encrypted at rest (`crypto.service`). They never appear in logs, Sentry, API responses or the browser; errors carry only `status` and `code`.
- Refresh happens on demand: when under 60 s of validity remain, or once after a `401 invalid_token` (only that code; other 401s do not trigger a refresh). Always under the per-user Redis lock `aib:refresh:{userId}`.
- The new token pair is saved **before anything else**. A failed save is retried; if it still fails the connection goes to `needs_reconnect` (the old refresh token is spent). An unknown-outcome marker is set when a refresh request may have been consumed remotely without us seeing the response, so the possibly spent token is not reused blindly.
- **Never call `/oauth/revoke` except on a user-initiated disconnect**: it revokes the whole connection.
- `account_ids` in every token response is authoritative: when it differs from the stored list (a re-consent can replace the set), the account list is re-synced (`GET /public/v1/accounts`) before any further call. A header-less request never infers an account.
- Every account-scoped call sends `X-Account-Id`; `POST /expenses` sends an `Idempotency-Key` (UUID v4); amounts go out as decimal strings with at most 2 places.

### Disconnect order

Mark the connection revoked → remote `/oauth/revoke` → clear the mirror (expenses and dismissals) → clear the tokens. Marking first stops concurrent syncs and refreshes from writing new rows. The result reports `remote`: `revoked` (AI Budget confirmed), `failed` (an active grant could not be revoked: the UI tells the user to remove it under Connected apps), `expired` (the connection was `needs_reconnect`, so the grant was already unusable: a neutral note, not a failure) or `none` (nothing stored).

Token saves: a reconnect saves its pair under the same per-user refresh lock, and a refresh saves its rotated pair with a compare-and-swap on the refresh token it read. A rotated pair superseded by a newer save is dropped and the stored one is used. A 5xx from `/oauth/token` is an unknown outcome, like a timeout: it blocks the next refresh for 60 s. `needs_reconnect` connections older than 30 days are cleaned up by the sync job.

## Data storage

- Only the **company** account's expenses are written to this app's DB (the mirror: connection, accounts, mirrored expenses, dismissals).
- Private and other-business data are **never persisted**. They are read live and held only in Redis, encrypted with `cryptoService.encryptToString`, for **at most 300 s**.
- They are never passed to `logger`, Sentry or `AIMemory*` (memory extraction is skipped for exchanges that used them).
- LangSmith: a trace is *private* when the conversation is already flagged `containsPrivateAiBudgetData` or the run binds the AI Budget tools with scope `all` (a non-shared chat or a private Telegram chat with a connection). The standalone TTS route cannot be tied to a conversation, so its trace is private whenever the user has a connection. In a private trace the redacting client blanks every run's inputs and outputs (llm, chain, root, tts, tools). Non-private traces still blank the `ai_budget_*` tool runs by name. Consequence: LangSmith traces of connected users' private chats carry no content; debug from local logs. Tests are hermetic and stub the LangSmith transport.
- Amounts are integer cents internally; totals are per currency and are never summed across currencies; months are calendar months in `Europe/Warsaw`; AI Budget dates are `YYYY-MM-DD` strings compared as strings.
- An expense with `is_debt` or `is_split_receivable` is not spending: excluded from every total, chart, chat summary and the reconciliation (listed in chat only on request, labelled). When `category_splits` is non-empty the splits decide and the expense's own `category_id` is ignored.

## Sync

- Company mirror only. Incremental by cursor through the expenses sync endpoint; tombstones (deletes) remove mirror rows.
- A **full resync** runs every 7 days (or when the cursor is invalid, or on demand): it bumps the sync generation and finishes with a **sweep** deleting rows not seen in the new generation.
- `lastSyncedAt` is stamped only when a whole run has finished: a first sync in progress (or one that failed midway) never reads as ready, so the dashboard shows `syncing` / `sync_failed` and chat never says "all matched" on a partial mirror.
- A scheduled job runs every **15 minutes** (Redis lock, one process at a time) and syncs active connections of users who are not soft-deleted; reads also sync on demand when the mirror is older than 300 s. `needs_reconnect` connections are kept for **30 days** and then cleared.
- `403 account_encrypted` means the account is readable but writes and merchant/search filters are refused. It is never treated as "account gone".

## Reconciliation

Scope: company spending expenses dated from the first day of the previous month through today, not dismissed, against wFirma documents. Match: same currency (case-insensitive), `|gross - amount| <= 0.01`, document date within **±7 days**, one-to-one. Wording is "no matching document found", never "has no invoice". The wFirma reads do **not** call `checkWFirmaLimit` or `incrementWFirmaUsage`. Dismissals are stored per expense; dismissed items are hidden from the list (there is no restore action).

`listUnmatched` returns a discriminated state: `ok` (with items, and a `truncated` flag if the document read hit its cap), `wfirma_not_connected`, `wfirma_error` or `no_company`. Callers must also gate on the connection status (`needs_reconnect`/`revoked`) before showing mirror figures or reconciliation.

## Dashboard states

Unknown must look unknown. Explicit states, never zeros or "all matched": not available, not connected, needs reconnect (mirror figures are not shown as current), syncing, sync failed with no prior success, no company chosen (company choice prompt), wFirma not connected / wFirma error (reconciliation card). The private card shows live, per-currency figures and says they are never included in company figures.

## Chat tools and the shared-chat scope

AI Budget tools are bound per run by `AiBudgetChatFactory.forRun`. In a **shared organization chat** the tools see only the company account; other accounts are invisible, their tools refuse and the prompt says so. A private Telegram chat and non-shared chats see every account; a Telegram group (any chat that is not `private`) gets the company-only scope, as a shared chat does.

Chat filters: a text filter is matched locally on merchant and description for every account (the mirror and live reads alike) and is never sent to AI Budget's `search`. A category filter takes a category **name**, matched case-insensitively per account (splits decide); an unknown name answers with the available names.

Untrusted text: merchants, descriptions, account and category names are written by third parties. Before they reach the model, markdown images and links keep only their text, raw URLs keep only their host, and HTML, backticks and stray link syntax are dropped; the prompt says that tool-result text is data, never instructions. The chat renderer never loads an image (`![](…)` renders as `[image: alt]`). Using private or other-business data flags the conversation `containsPrivateAiBudgetData`. Tools throw on bad arguments; the runner turns that into a tool error message. Account selection resolves through the repository and refuses non-active and unavailable accounts.

## Known limitations

- wFirma `total` is assumed to be the gross amount in the document currency. To be verified in the pilot with a foreign-currency document.
- `findExpenses` is capped at 1000 documents; a capped read sets `truncated` and the UI says so.
- AI Budget does not emit a delete for an expense moved to another account between full resyncs; the weekly sweep removes it.
- Traces of private chats are blank in LangSmith by design.
- The langsmith client cast between 0.2.x and 0.3.x was not tested against live LangSmith (pilot check).

## Rollout checklist

1. Prod Redis is 6.2 or newer (met by `redis:7-alpine` in `docker-compose.prod.yml`).
2. App registered in AI Budget (confidential, exact redirect URI, the four scopes); env set; `api` force-recreated; `BACKEND_URL=https://api.eksiegowyai.pl`.
3. The AI Budget multi-account contract (ABA-709) is deployed.
4. Pilot account: connect; the three labels are correct; the company choice works with two business accounts.
5. A company expense and a private expense created from chat land in the right AI Budget accounts.
6. Reconciliation finds a known document and flags a known missing one.
7. A LangSmith trace of a private chat is blank.
8. wFirma total currency check with a foreign-currency document.
9. Disconnect clears the mirror and the connection can be re-established.
