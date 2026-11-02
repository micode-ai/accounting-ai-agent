# AI Budget integration

Status: draft for approval · 2026-11-02

## Intent

AI Budget (ai-budget.pl, same owner) is where people log their day-to-day spending: by voice, from
receipt photos, from bank notifications. A sole trader or a small-company owner using eksiegowyai.pl
often logs **company** costs there too. Until now the two products did not talk to each other. The
company's spending in AI Budget never reached its accounting, and nothing showed which costs still
lack an invoice in wFirma.

AI Budget now has a public API with OAuth (`api.ai-budget.pl/public/v1`, Swagger at
`/public/docs/en`). This integration connects the two.

**The rule that runs through everything: company money and private money never mix.** A user's
AI Budget accounts are labelled either *company* (firma) or *private* (prywatne). Company data joins
the accounting picture. Private data is shown separately and clearly labelled, so it can never be
mistaken for a company cost.

## Goals

1. **Connect.** A "Connect AI Budget" button opens AI Budget's consent screen. There the user ticks
   one or more of their accounts (multi-select: see the prerequisite below) and grants access.
   - Each connected account is labelled automatically from its AI Budget type (see decision 13 for
     the exact rule).
   - The user can change a label by hand. The manual label wins over the automatic one.
   - The user can disconnect, or reconnect to change which accounts are connected.
2. **Chat.** The AI agent can read the expenses of the connected accounts and write to them:
   create, edit and delete.
   - Every answer keeps company and private apart.
   - Every write states which account and label it targets before it happens.
3. **Main dashboard.** When AI Budget is connected, the main dashboard (`/dashboard`) gains company
   figures that come from the *company* accounts only:
   - company spending from AI Budget this month against last month;
   - the same spending broken down by category;
   - **"Expenses without a document"**: company expenses in AI Budget with no matching cost document
     (wydatek) in wFirma.
4. **Private page.** A separate page, "Private" (`/dashboard/personal`, my call on the route), shows
   the *private* accounts' figures:
   - this month's total;
   - a six-month trend;
   - a category breakdown.

   It is reachable from where the other dashboard pages are linked, and it is clearly titled as
   private, outside the company's books.

## Non-goals

- Incomes, budgets and goals from AI Budget. The API does not expose them yet.
- Creating wFirma documents automatically from AI Budget expenses. Reconciliation only points at
  gaps. A later feature may offer to book an expense into wFirma from that list.
- Several wFirma companies per user. The app has one company per user today, and that stays.
- Two-way sync of categories. AI Budget categories are shown as they are.

## Anti-goals (failure even if it works)

- A private expense appearing in a company figure, in a company answer in chat, or in any wFirma
  write.
- The agent writing to an account the user did not mean. "Lunch 45 zł" must never be filed under the
  company because that happened to be the first account.
- The dashboard reporting "everything has a document" or "no expenses" when the data simply has not
  loaded or the connection is broken. Unknown must look unknown.
- Reconciliation stating that an expense *has no invoice* as a fact. The matching is heuristic. The
  wording is "no matching document found", and the user can dismiss an item.
- Leaking AI Budget tokens: logs, Sentry, the browser, or plaintext in the database.

## Prerequisite in AI Budget (separate work, same owner)

Multi-account connections:
`D:\Work\micode\ai-budget-assistant\docs\superpowers\specs\2026-11-02-public-api-multi-account-design.md`.

After it ships:
- one token pair covers all ticked accounts;
- `GET /public/v1/accounts` lists them with `type`, name, currency, `access` (read or read_write) and
  `active`;
- every account-scoped call carries `X-Account-Id`.

This integration is built against that contract. It ships after it.

## Facts about this codebase the design leans on

- The dashboard is one page of widgets, with no tabs: `packages/web/src/app/dashboard/page.tsx`.
  - Its data comes from `GET /api/dashboard/summary` (`services/dashboard/dashboard.service.ts`).
  - Each section is nullable when its source is not configured.
  - Charts are drawn with Recharts.
- Credentials are stored per user, AES-256-GCM-encrypted with `services/crypto.service.ts`
  (`UserApiCredentials`).
  - There is no integrations settings page. wFirma keys live in a profile modal.
- wFirma cost documents: `services/wfirma/expense.service.ts` `findExpenses`, which returns date,
  gross/net, currency, contractor name and NIP. It always queries live and is not cached.
- Chat tools are LangGraph tools in `services/ai-chat/tools/*.tools.ts`, registered in
  `tools/index.ts` `createAllTools`.
  - Results are localized markdown through formatters.
  - Rules live in `prompt-fragments.ts`.
  - Write confirmation is a prompt rule, not a mechanism.
- Background jobs are `setInterval` services with `start()`/`stop()`, started in `api/src/index.ts`.
- Locales: en, pl, ru (web and api).
- Prod deploys from `development` via `scripts/deploy.sh`. Env vars must be listed in
  `docker-compose.prod.yml`.

## Decided shape

The product owner decided these:
- multi-select at connect time;
- labels come from the account type and can be overridden by hand;
- the chat both reads and writes;
- company figures sit on the main dashboard and private figures are kept apart;
- reconciliation is in the first version.

The rest are my calls (the builder may revisit them if the code argues otherwise):

1. **OAuth client.** eksiegowyai.pl is registered in AI Budget as a confidential client:
   - authorization code + PKCE S256, `state` bound to the user's session;
   - scopes `expenses:read expenses:write categories:read receipts:read`;
   - redirect URI on the API host `https://api.eksiegowyai.pl/api/integrations/ai-budget/callback`,
     which then redirects to the web settings page;
   - client id and secret in env (`AI_BUDGET_CLIENT_ID`, `AI_BUDGET_CLIENT_SECRET`,
     `AI_BUDGET_API_URL`, `AI_BUDGET_AUTHORIZE_URL`), listed in `docker-compose.prod.yml`.
   - Missing env means the feature is hidden, not broken.
2. **Storage.** A connection row per user holds:
   - the encrypted access and refresh tokens via `crypto.service`;
   - their expiry and a status (`active`, `needs_reconnect`, `revoked`).

   One row per connected account holds:
   - the AI Budget account id, name, type and currency;
   - `access` (read or read_write);
   - the automatic label and an optional manual label.
3. **Token refresh.** Refresh happens on demand before expiry, under a per-user lock (Redis), with
   rotation saved atomically. AI Budget revokes the whole connection when an old refresh token is
   reused, so two concurrent refreshes must never happen.
   - An `invalid_grant` marks the connection `needs_reconnect` and surfaces it in the UI and in chat.
4. **Data: only the company account is stored here** (decided by the product owner, for privacy).
   - **Company mirror.** Expenses of the single *company* account are mirrored into a local table
     through AI Budget's changes feed.
     - A cursor is kept.
     - Tombstones delete local rows.
     - Sync runs right after connect (full first sync), every 15 minutes, and on demand: dashboard
       open when the last sync is older than a few minutes, a chat tool call, the "Refresh" button.
     - The company dashboard and the reconciliation read the mirror. Company spending is this app's
       subject matter and ends up in the books anyway.
   - **Private and other-business data are never written to this app's database.**
     - They are read live from AI Budget when the private page or a chat tool needs them.
     - Results are cached in Redis for a few minutes at most (my call: 5), keyed per user and account,
       and encrypted with `crypto.service` before they go into Redis.
     - They are never logged, and never copied into conversation memory (`AIMemoryService`
       extraction must skip AI Budget tool output).
     - They are still visible in the text of chat answers the user asked for, as any chat content
       is.
   - **Relabelling** an account away from *company* deletes its mirror, cursor and dismissals at
     once. Choosing a new *company* account starts its full first sync.
   - **Writes** go to AI Budget first, with an `Idempotency-Key`. A write to the company account also
     updates the mirror from the response. A write to any other account invalidates that account's
     Redis cache.
5. **Chat tools**, as an optional group, present only when the user has an active connection:
   - `ai_budget_list_accounts`;
   - `ai_budget_get_expenses`: filter by label, account, period, category, text; totals per label;
   - `ai_budget_spending_summary`: by category and by month, per label;
   - `ai_budget_create_expense`, `ai_budget_update_expense`, `ai_budget_delete_expense`;
   - `ai_budget_expenses_without_document`.

   Rules for writes:
   - A write tool requires an explicit account id. The prompt rule says to confirm amount, date and
     the target account with its label before writing.
   - With exactly one *company* account and the user saying "for the company", that account may be
     proposed, but it is still confirmed.
   - A write to a read-only account is refused with an explanation.
   - Prompt fragment: never add private expenses to company totals or wFirma actions, and always
     label figures *company* or *private*.
6. **Reconciliation.**
   - **Scope.** Company-labelled AI Budget expenses in the current and the previous month are matched
     against wFirma cost documents for the same window plus a margin.
   - **Match rule.** A match needs the same currency, a gross amount equal within 0.01, and a document
     date within ±7 days. When several candidates match, the contractor name similar to the expense's
     merchant or description wins.
   - **One-to-one.** Each wFirma document matches at most one expense.
   - **Unmatched list.** Unmatched expenses form the "without a document" list. The dashboard shows a
     count, the total, and the top items with amount, date and merchant.
   - **Dismissal.** The user can dismiss an item ("no document needed": a cash expense, a fine, a
     private one wrongly labelled). The dismissal is stored locally and survives refreshes.
   - **No mirror.** wFirma documents are fetched live when reconciliation runs, and the result is
     cached briefly per user; the documents are not mirrored.
   - **When wFirma is not connected.** If the user has AI Budget but no wFirma credentials, the
     company figures still show, and the reconciliation card explains that wFirma is needed.
7. **Settings.** A new page `/settings/integrations` holds an AI Budget card:
   - connect or reconnect;
   - status and last sync;
   - the list of connected accounts, each with a company/private toggle (showing whether it is
     automatic or manual) and a read-only badge;
   - disconnect, which revokes the token at AI Budget, deletes the tokens and deletes the mirror.

   The page is linked from the user menu next to the existing credentials entry.
8. **Dashboard states.**
   - Not connected: one small invitation card on `/dashboard` and on the private page, not empty
     charts.
   - Connected but no company accounts: the company block says so.
   - Connected but no private accounts: the private page says so.
   - Sync in progress or failed: an explicit state, never zeros.
9. **Plans.** The integration is available on every plan. AI Budget's API is free. The existing
   wFirma usage counters are untouched: reconciliation's wFirma reads do not count against the
   free-plan quota (my call; easy to change).
10. **Currency.** Totals are reported per currency. Amounts in different currencies are not summed
    without conversion. Most users are PLN-only, and a mixed case shows one line per currency.

11. **What counts as spending.**
    - Expenses flagged `is_debt` (money lent) or `is_split_receivable` (a bill share others owe back)
      are not spending. They are left out of every total, chart, chat summary and the reconciliation
      list. This is AI Budget's own rule, and it would otherwise flood the "without a document" list.
      Chat can still list them on request, labelled as such.
    - The category breakdown follows an expense's category splits when it has them. Otherwise the
      expense's own category takes the whole amount. This is AI Budget's attribution rule.
12. **When access ends from AI Budget's side.**
    - **Connection-wide `invalid_grant`** on refresh, or `401` with a refresh failing (the user
      disconnected in AI Budget, or refresh reuse revoked it): status `needs_reconnect`.
      - Dashboard and chat show "connection to AI Budget lost, reconnect", never the stale figures
        as current.
      - The mirror is kept for 30 days so a reconnect resumes without a full resync, then deleted by
        a cleanup job.
    - **One account dropped** (`account_not_granted`, or the account missing from `/accounts`): that
      account's mirror rows, cursor and dismissals are deleted, and it disappears from the settings
      list.
    - **One account inactive** (`active: false`): its rows are kept and excluded from figures. The
      settings list shows it as inactive with the reason, and the dashboard notes that one account is
      not being read.
    - **Disconnect started here:** revoke at AI Budget, then delete the tokens, mirror, cursors and
      dismissals at once.

13. **Three labels, one company** (decided by the product owner).
    - Labels are *company*, *other business* and *private*.
    - Exactly one connected account can be *company*: the one that matches this app's wFirma
      company. Only *company* feeds the main dashboard and the reconciliation.
    - Automatic labelling:
      - a single `business` account becomes *company*;
      - with several `business` accounts, the user is asked right after connecting which one is their
        company here (settings shows the choice until it is made), and the rest become
        *other business*;
      - every non-business type becomes *private*.
    - *Other business* accounts are readable and writable in chat, labelled as such, and appear in
      neither the dashboard nor reconciliation.
    - The manual override can move any account between the three labels, but never creates a second
      *company*: choosing a new one demotes the previous one to *other business*.
14. **Shared chats and Telegram** (decided by the product owner).
    - In a conversation shared with the organization, and in one being shared, the AI Budget tools
      reach only the *company* account. Private and other-business accounts are invisible there,
      their tools refuse, and the prompt says so.
    - Sharing a conversation that already used private or other-business data is allowed. Its
      earlier answers stay visible, so the share dialog warns that the thread contains private
      AI Budget data.
    - In a non-shared chat and in Telegram, every connected account is available.

## What the builder decides

- Prisma model and table names, the shape of the mirror table, and indexes.
- Widget composition on `/dashboard` (one combined "AI Budget – company" card or several), within the
  existing widget pattern, phone and desktop.
- The exact similarity measure for the tie-break.
- Test layout: unit tests for the OAuth state/PKCE handling, refresh locking, mirror sync (cursor,
  tombstones), reconciliation (match rules, one-to-one, dismissals, currency), and tool label
  discipline. Add a Playwright spec for the settings page with the AI Budget API mocked.

## Rollout

1. AI Budget multi-account connections ship (prerequisite).
2. Register eksiegowyai.pl as an app in AI Budget, mark it verified, set the limits to 600 / 10,000
   (`docs/ops/public-api.md` in the AI Budget repo). Put the client id and secret into this app's
   `.env.production`.
3. Deploy this integration.
4. Pilot with the owner's own accounts, using AI Budget's pilot checklist plus:
   - labels are correct;
   - a company and a private expense created from chat land in the right accounts;
   - reconciliation finds a known document and flags a known missing one.

## Documentation

- `docs/AI_BUDGET_INTEGRATION.md` (feature doc, in the style of `WFIRMA_INTEGRATION.md`);
- the CLAUDE.md key-services list and env list;
- user-facing guide text in en/pl/ru wherever this app keeps its guides.
