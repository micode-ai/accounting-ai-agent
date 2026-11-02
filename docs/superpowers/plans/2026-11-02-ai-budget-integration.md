# AI Budget Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect a user's AI Budget accounts over OAuth. The single *company* account is mirrored and joins the dashboard and reconciliation against wFirma cost documents. *Private* and *other business* accounts are read live, shown apart, and never stored. The chat can read and write all of them, with company and private kept apart.

**Architecture:** A new `services/ai-budget/` module in `packages/api` holds everything except the chat tools:
- config, a pure domain layer (spending rules, labels, matching);
- a transport-injected HTTP client with token refresh under a Redis lock;
- a repository over the new Prisma models;
- account/label, mirror-sync, live-read (encrypted Redis cache), expenses (read/write), reconciliation and dashboard services;
- OAuth routes and a 15-minute job.

Chat tools live in `services/ai-chat/tools/ai-budget.tools.ts`, bound per run by `LangGraphAgentRunner` only when a connection exists. A conversation's `isShared` narrows them to the company account. The web gets `/settings/integrations`, a company block on `/dashboard`, `/dashboard/personal`, and a share warning.

**Tech Stack:** Express 4, Prisma 5 / PostgreSQL 16, ioredis (Redis 7), axios, LangChain/LangGraph (`@langchain/core` 0.3.80), Zod, Jest 29 (ts-jest); Next.js 15, React 19, React Query 5, Recharts, Tailwind, Jest + Testing Library, Playwright.

**Spec:** [`docs/superpowers/specs/2026-11-02-ai-budget-integration-design.md`](../specs/2026-11-02-ai-budget-integration-design.md). External contract:
- `D:\Work\micode\ai-budget-assistant\apps\api\src\modules\public-api\docs\guide.en.md`;
- `…\public-api\dto\public-expense.dto.ts`, the wire shapes;
- `D:\Work\micode\ai-budget-assistant\docs\superpowers\specs\2026-11-02-public-api-multi-account-design.md`.

---

## Global Constraints

- **Company money and private money never mix.** No private or other-business expense may reach a company figure, a company chat answer, the reconciliation, or any wFirma write.
- **Labels:** exactly three, `company` | `other_business` | `private`. **At most one** `company` per connection, enforced in the DB by a partial unique index. Choosing a new company demotes the previous one to `other_business`.
- **Automatic labelling:**
  - a single `business` account becomes `company`;
  - with several `business` accounts and none chosen, all of them are `other_business` and `needsCompanyChoice = true`;
  - every other type (`personal`, `shared`, `trip`, `investment`) is `private`;
  - a manual label always wins over the automatic one.
- **Storage:** only the company account's expenses are written to this app's DB.
  - Private and other-business data live only in Redis, encrypted with `cryptoService.encryptToString`, for **at most 300 s**.
  - They are never passed to `logger`, Sentry or `AIMemory*`.
- **OAuth:**
  - authorization code + PKCE `S256`;
  - scopes exactly `expenses:read expenses:write categories:read receipts:read`;
  - redirect URI `${BACKEND_URL}/api/integrations/ai-budget/callback`, which must equal `https://api.eksiegowyai.pl/api/integrations/ai-budget/callback` in prod;
  - `state` is single-use, bound to the user id, and expires after 600 s.
- **Env:** `AI_BUDGET_CLIENT_ID`, `AI_BUDGET_CLIENT_SECRET`, `AI_BUDGET_API_URL` (default `https://api.ai-budget.pl`), `AI_BUDGET_AUTHORIZE_URL` (default `https://app.ai-budget.pl/authorize`). If the client id, the secret, `BACKEND_URL`, `FRONTEND_URL` or `CREDENTIALS_ENCRYPTION_KEY` is missing, the feature is **hidden**: `available: false`, no tools, no cards.
- **Tokens are AES-256-GCM-encrypted at rest** via `crypto.service`. They never appear in logs, Sentry, API responses or the browser. Errors carry only `status` and `code`.
- **Refresh:**
  - on demand, when fewer than 60 s of validity remain, or once after a `401 invalid_token`;
  - only under the per-user Redis lock `aib:refresh:{userId}`;
  - the new token pair is saved before anything else.
  - **Never call `/oauth/revoke` except on a user-initiated disconnect**: it revokes the whole connection.
- **`account_ids` in every token response is authoritative** (a re-consent in AI Budget can replace the set of connected accounts): when it differs from the stored account list after a code exchange or refresh, re-sync the account list (`GET /public/v1/accounts`) before any further call, and never infer an account from a header-less request.
- **Every account-scoped AI Budget call sends `X-Account-Id`.** `POST /expenses` sends an `Idempotency-Key` (UUID v4). Amounts go out as decimal strings with at most 2 places, never JSON numbers.
- **Spending:** an expense with `is_debt` or `is_split_receivable` is not spending. It is excluded from every total, chart, chat summary and the reconciliation, and is listed in chat only on request, labelled as such.
- **Category attribution:** when `category_splits` is non-empty, the splits decide and the expense's own `category_id` is ignored. Otherwise `category_id` takes the whole amount. There is no remainder bucket.
- **Currency:** totals are per currency. Amounts in different currencies are never summed. Internally amounts are integer cents.
- **Months:** months are calendar months in `Europe/Warsaw`. AI Budget dates are `YYYY-MM-DD` strings and are compared as strings.
- **Reconciliation:**
  - scope: company spending expenses dated from the first day of the previous month through today, not dismissed;
  - match: same currency (case-insensitive), `|gross − amount| ≤ 0.01`, document date within **±7 days**;
  - one-to-one;
  - wording: "no matching document found", never "has no invoice";
  - the wFirma reads do **not** call `checkWFirmaLimit` / `incrementWFirmaUsage`.
- **Unknown must look unknown:**
  - not connected, needs reconnect, syncing, sync failed with no prior success, and wFirma missing are explicit states, never zeros or "all matched";
  - a `needs_reconnect` connection never shows mirror figures as current.
- **Shared org chat:** the AI Budget tools see only the company account. Other accounts are invisible, their tools refuse, and the prompt says so. Telegram and non-shared chats see every account.
- **i18n:** every user-visible string goes in en, pl and ru, in both `packages/api/src/i18n/locales/*.json` and `packages/web/src/i18n/locales/*.json`.
- **Plans:** the integration is available on every subscription plan.
- **Tests:** Jest tests never make live HTTP calls. AI Budget goes through `FakeTransport`, Redis through `FakeRedis`, and the DB through `InMemoryAiBudgetRepository` (all from Task 3/4 fakes).
- **Commits:** conventional style used by this repo, e.g. `feat(ai-budget): …`. Never push without the user's OK.

## Review Focus

1. **A replayed, expired or foreign OAuth `state`, or `error=access_denied` on the callback.** Expected: a redirect to `/settings/integrations?ai_budget=error&reason=<code>`, no token stored, and the state consumed atomically (`GETDEL`) so a second use fails. Tests in Task 6.
2. **The user relabels the company account while a sync is mid-flight.** Expected: the sync must not write mirror rows for an account that is no longer `company`. The page transaction re-reads the label and stops. Test in Task 5.
3. **A company account with a foreign-currency expense** (PLN account, one EUR receipt). Expected: one total line per currency on the dashboard. Reconciliation matches the EUR expense only against an EUR wFirma document. Tests in Tasks 2, 8 and 9.
4. **The month boundary at midnight Warsaw time** (`now = 2026-11-30T23:30:00Z`, which is already 1 December in Warsaw). Expected: "this month" is December and "last month" is November. Tests in Task 2.
5. **Reconnect with a different set of accounts** (the former company account not ticked any more). Expected:
   - that account's mirror, cursor and dismissals are deleted;
   - manual labels of the still-granted accounts survive;
   - the old tokens are **not** revoked at AI Budget.

   Tests in Tasks 4 and 6.

---

## File Structure

### API — `packages/api`

Create:
```
prisma/migrations/20261102000000_add_ai_budget_integration/migration.sql
src/services/ai-budget/ai-budget.config.ts            env → AiBudgetConfig | null
src/services/ai-budget/ai-budget.types.ts             wire types (snake_case) + domain types
src/services/ai-budget/ai-budget.domain.ts            pure: cents, spending, attribution, currency sums, Warsaw months
src/services/ai-budget/ai-budget-labels.ts            pure: auto labels, label change
src/services/ai-budget/reconcile.ts                   pure: matching + name similarity
src/services/ai-budget/ai-budget-transport.ts         AiBudgetTransport + axios implementation
src/services/ai-budget/ai-budget-errors.ts            error classes
src/services/ai-budget/ai-budget-oauth.client.ts      /oauth/token, /oauth/revoke
src/services/ai-budget/ai-budget-token.manager.ts     token read/refresh under lock
src/services/ai-budget/ai-budget-api.client.ts        /public/v1 calls
src/services/ai-budget/ai-budget.repository.ts        AiBudgetRepository interface + Prisma implementation
src/services/ai-budget/ai-budget-accounts.service.ts  account list reconcile, labels, drops
src/services/ai-budget/ai-budget-sync.service.ts      company mirror via changes feed
src/services/ai-budget/ai-budget-live.service.ts      live reads + encrypted Redis cache
src/services/ai-budget/ai-budget-expenses.service.ts  unified read/write for chat
src/services/ai-budget/ai-budget-reconciliation.service.ts
src/services/ai-budget/ai-budget-dashboard.service.ts
src/services/ai-budget/ai-budget-oauth.service.ts     connect / callback / disconnect / status
src/services/ai-budget/ai-budget-sync.job.ts          15-min job + 30-day cleanup
src/services/ai-budget/ai-budget-chat.factory.ts      per-run tool binding + prompt fragment
src/services/ai-budget/ai-budget.instance.ts          singletons + listener wiring
src/services/ai-budget/index.ts
src/services/ai-budget/__tests__/fakes.ts             FakeTransport, FakeRedis, InMemoryAiBudgetRepository, fixtures
src/services/ai-budget/__tests__/*.test.ts
src/services/ai-chat/tools/ai-budget.tools.ts
src/services/ai-chat/formatters/ai-budget.formatter.ts
src/services/ai-chat/trace-redaction.ts
src/controllers/ai-budget.controller.ts
src/routes/ai-budget.routes.ts
src/types/ai-budget-api.types.ts                     status + dashboard response types (mirrored in web)
```

Modify:
- `prisma/schema.prisma`
- `src/lib/redis.ts`
- `src/index.ts`
- `src/routes/dashboard.routes.ts`
- `src/i18n/index.ts` and `src/i18n/locales/{en,pl,ru}.json`
- `src/services/ai-chat/{langgraph-agent-runner.ts, ai-chat.service.ts, constants.ts, prompt-fragments.ts, conversation-repository.ts, tools/index.ts, formatters/index.ts}`
- `src/services/ai-chat.instance.ts`
- `src/services/ai-memory/memory-extraction.service.ts`
- `src/types/ai-chat.types.ts`
- `.env.example`

### Web — `packages/web`

Create:
```
src/types/ai-budget.types.ts
src/lib/api/ai-budget.ts
src/hooks/useAiBudget.ts
src/app/settings/integrations/page.tsx
src/app/dashboard/personal/page.tsx
src/components/ai-budget/{AiBudgetIntegrationCard,AccountLabelSelect,CompanyChoicePrompt,AiBudgetInviteCard,
  AiBudgetCompanySection,AiBudgetCategoryChart,ReconciliationCard,PersonalSummary,CurrencyLines,index}.tsx
src/components/ai-budget/__tests__/*.test.tsx
src/i18n/__tests__/ai-budget-keys.test.ts
src/app/guide/ai-budget/{layout,page}.tsx, src/app/guide/ai-budget/connect/{layout,page}.tsx
tests/e2e/integrations/ai-budget-settings.spec.ts
```

Modify:
- `src/lib/api/endpoints.ts`
- `src/app/dashboard/page.tsx`
- `src/components/chat/{ChatContainer,ChatHeader}.tsx`
- `src/components/layout/HeaderUserMenu.tsx`
- `src/components/profile/ProfileEditModal.tsx`
- `src/hooks/useChat.ts`
- `src/app/guide/page.tsx`
- `src/lib/seo.ts`
- `src/i18n/locales/{en,pl,ru}.json`
- `package.json` (the `test:e2e` dirs)

### Repo root

- Create `docs/AI_BUDGET_INTEGRATION.md`.
- Modify `CLAUDE.md` and `docker-compose.prod.yml`.

---

### Task 1: Prisma models and migration

**Files:**
- Modify: `packages/api/prisma/schema.prisma` (new models; `User` relation; `AIConversation` field)
- Create: `packages/api/prisma/migrations/20261102000000_add_ai_budget_integration/migration.sql`

**Interfaces:**
- Produces the Prisma models below. Later tasks access them only through `AiBudgetRepository` (Task 4), except `AIConversation.containsPrivateAiBudgetData`, which `ConversationRepository` uses (Task 13).

```prisma
enum AiBudgetConnectionStatus { active needs_reconnect revoked }
enum AiBudgetLabel { company other_business private }
enum AiBudgetLabelSource { auto manual }

model AiBudgetConnection {        // @@map("ai_budget_connections")
  id String @id @default(uuid()) @db.Uuid
  userId String @unique @db.Uuid            // FK User, onDelete Cascade
  accessTokenEnc String? @db.Text           // null after disconnect
  refreshTokenEnc String? @db.Text
  accessTokenExpiresAt DateTime?
  scope String?
  status AiBudgetConnectionStatus @default(active)
  statusChangedAt DateTime @default(now())
  needsCompanyChoice Boolean @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  accounts AiBudgetAccount[]
}
model AiBudgetAccount {           // @@map("ai_budget_accounts")
  id String @id @default(uuid()) @db.Uuid
  connectionId String @db.Uuid              // FK, onDelete Cascade
  userId String @db.Uuid
  externalId String                         // AI Budget account id
  name String
  type String                               // personal|business|shared|trip|investment
  currency String @db.VarChar(3)
  access String                             // read|read_write
  active Boolean @default(true)
  inactiveReason String?                    // role|encrypted|archived
  label AiBudgetLabel
  labelSource AiBudgetLabelSource @default(auto)
  syncCursor String? @db.Text
  syncGeneration Int @default(0)
  lastSyncedAt DateTime?
  lastSyncError String?
  fullResyncAt DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  expenses AiBudgetExpense[]
  dismissals AiBudgetReconciliationDismissal[]
  @@unique([connectionId, externalId])
  @@index([userId])
}
model AiBudgetExpense {           // @@map("ai_budget_expenses") — company mirror only
  id String @id @default(uuid()) @db.Uuid
  accountId String @db.Uuid                 // FK AiBudgetAccount, onDelete Cascade
  externalId String
  amount Decimal @db.Decimal(14, 2)
  currency String @db.VarChar(3)
  date DateTime @db.Date
  categoryId String?
  categorySplits Json @db.JsonB @default("[]")   // [{categoryId, amount:"30.00"}]
  merchant String?
  description String?
  isDebt Boolean @default(false)
  isSplitReceivable Boolean @default(false)
  remoteUpdatedAt DateTime
  syncGeneration Int @default(0)
  @@unique([accountId, externalId])
  @@index([accountId, date])
}
model AiBudgetReconciliationDismissal {   // @@map("ai_budget_reconciliation_dismissals")
  id String @id @default(uuid()) @db.Uuid
  accountId String @db.Uuid                 // FK, onDelete Cascade
  externalExpenseId String
  reason String?
  createdAt DateTime @default(now())
  @@unique([accountId, externalExpenseId])
}
// AIConversation: + containsPrivateAiBudgetData Boolean @default(false)
```

- [ ] **Step 1: Edit `schema.prisma`** with the models above, following the repo's `@map` snake_case column convention as in `UserApiCredentials`. Add `aiBudgetConnection AiBudgetConnection?` to `User`.
- [ ] **Step 2: Generate the migration**

  Run: `cd packages/api && npx prisma migrate dev --create-only --name add_ai_budget_integration`. Rename the folder to `20261102000000_add_ai_budget_integration`.
- [ ] **Step 3: Append the partial unique index by hand** to `migration.sql`. Prisma cannot model it.

```sql
CREATE UNIQUE INDEX "ai_budget_accounts_one_company_per_connection"
  ON "ai_budget_accounts" ("connection_id") WHERE "label" = 'company';
```

- [ ] **Step 4: Verify**

  Run: `npx prisma migrate dev && npx prisma validate && npx prisma generate`.
  Expected: "Your database is now in sync". `\d ai_budget_accounts` in psql lists the partial index.
- [ ] **Step 5: Commit** `feat(ai-budget): add integration schema and migration`

---

### Task 2: Config and pure domain rules

**Files:**
- Create: `src/services/ai-budget/ai-budget.config.ts`, `ai-budget.types.ts`, `ai-budget.domain.ts`, `ai-budget-labels.ts`
- Test: `src/services/ai-budget/__tests__/ai-budget.domain.test.ts`, `ai-budget-labels.test.ts`, `ai-budget.config.test.ts`

**Interfaces:**
- Produces:
```ts
// ai-budget.config.ts
export const AI_BUDGET_SCOPES = 'expenses:read expenses:write categories:read receipts:read';
export interface AiBudgetConfig { clientId: string; clientSecret: string; apiUrl: string; authorizeUrl: string;
  tokenUrl: string; revokeUrl: string; redirectUri: string; frontendUrl: string }
export function getAiBudgetConfig(env?: NodeJS.ProcessEnv, encryptionConfigured?: boolean): AiBudgetConfig | null
// ai-budget.types.ts — wire (snake_case, from public-expense.dto.ts) + domain
export type AiBudgetLabel = 'company' | 'other_business' | 'private';
export type AiBudgetLabelSource = 'auto' | 'manual';
export interface PublicExpenseWire { id: string; amount: string; currency: string; date: string; category_id: string | null;
  description: string | null; merchant: string | null; category_splits: { category_id: string; amount: string }[];
  is_debt: boolean; is_split_receivable: boolean; updated_at: string; encrypted_fields: string[] /* other fields ignored */ }
export interface RemoteAccount { id: string; name: string; type: string; base_currency: string;
  access: 'read' | 'read_write'; active: boolean; reason: 'role' | 'encrypted' | 'archived' | null }
export interface RemoteCategory { id: string; name: string | null; type: string }
export interface TokenResponse { access_token: string; refresh_token: string; expires_in: number; scope: string; account_ids: string[] }
export interface CurrencyTotal { currency: string; total: number }   // total in major units, 2 dp
// ai-budget.domain.ts
export function toCents(decimal: string): number
export function centsToNumber(cents: number): number
export function isSpending(e: { isDebt: boolean; isSplitReceivable: boolean }): boolean
export function attributeToCategories(e: { amountCents: number; categoryId: string | null;
  categorySplits: { categoryId: string | null; amountCents: number }[] }): { categoryId: string | null; amountCents: number }[]
export function sumByCurrency(items: { currency: string; amountCents: number }[]): CurrencyTotal[]   // sorted by currency, upper-cased
export function warsawToday(now: Date): string                                      // 'YYYY-MM-DD'
export function warsawMonthWindow(now: Date, offsetMonths: 0 | -1 | -2 | -3 | -4 | -5): { from: string; to: string; month: string }
export function addDays(date: string, days: number): string
// ai-budget-labels.ts
export interface LabelState { externalId: string; type: string; label: AiBudgetLabel; labelSource: AiBudgetLabelSource }
export function computeAutoLabels(granted: { externalId: string; type: string }[], existing: LabelState[]):
  { labels: LabelState[]; needsCompanyChoice: boolean }
export function applyLabelChange(current: LabelState[], externalId: string, label: AiBudgetLabel): LabelState[]
```

- [ ] **Step 1: Write the failing tests**

```ts
// ai-budget.domain.test.ts
test('toCents parses AI Budget decimal strings', () => { expect(toCents('42.50')).toBe(4250); expect(toCents('0.01')).toBe(1); expect(toCents('7')).toBe(700); });
test('debts and split receivables are not spending', () => {
  expect(isSpending({ isDebt: true, isSplitReceivable: false })).toBe(false);
  expect(isSpending({ isDebt: false, isSplitReceivable: true })).toBe(false);
  expect(isSpending({ isDebt: false, isSplitReceivable: false })).toBe(true);
});
test('splits decide and the own category is ignored', () => {
  expect(attributeToCategories({ amountCents: 10000, categoryId: 'food', categorySplits: [
    { categoryId: 'alcohol', amountCents: 3000 }, { categoryId: 'household', amountCents: 5000 }] }))
    .toEqual([{ categoryId: 'alcohol', amountCents: 3000 }, { categoryId: 'household', amountCents: 5000 }]);
});
test('without splits the own category takes the whole amount', () => {
  expect(attributeToCategories({ amountCents: 4250, categoryId: 'food', categorySplits: [] })).toEqual([{ categoryId: 'food', amountCents: 4250 }]);
});
test('mixed currencies are never summed', () => {
  expect(sumByCurrency([{ currency: 'PLN', amountCents: 1000 }, { currency: 'eur', amountCents: 250 }, { currency: 'PLN', amountCents: 5 }]))
    .toEqual([{ currency: 'EUR', total: 2.5 }, { currency: 'PLN', total: 10.05 }]);
});
test('month boundary uses Europe/Warsaw', () => {
  const now = new Date('2026-11-30T23:30:00Z');            // 2026-12-01 00:30 in Warsaw
  expect(warsawToday(now)).toBe('2026-12-01');
  expect(warsawMonthWindow(now, 0)).toEqual({ from: '2026-12-01', to: '2026-12-31', month: '2026-12' });
  expect(warsawMonthWindow(now, -1)).toEqual({ from: '2026-11-01', to: '2026-11-30', month: '2026-11' });
});
// ai-budget-labels.test.ts
test('single business account becomes company, others private', () => {
  const r = computeAutoLabels([{ externalId: 'b', type: 'business' }, { externalId: 'p', type: 'personal' }, { externalId: 's', type: 'shared' }], []);
  expect(r.labels.map(l => [l.externalId, l.label, l.labelSource])).toEqual([['b','company','auto'],['p','private','auto'],['s','private','auto']]);
  expect(r.needsCompanyChoice).toBe(false);
});
test('several business accounts ask for a choice and none is company', () => {
  const r = computeAutoLabels([{ externalId: 'b1', type: 'business' }, { externalId: 'b2', type: 'business' }], []);
  expect(r.labels.every(l => l.label === 'other_business')).toBe(true);
  expect(r.needsCompanyChoice).toBe(true);
});
test('manual labels survive recomputation and an existing company stays the only one', () => {
  const existing = [{ externalId: 'b1', type: 'business', label: 'company', labelSource: 'manual' } as const,
                    { externalId: 'p', type: 'personal', label: 'other_business', labelSource: 'manual' } as const];
  const r = computeAutoLabels([{ externalId: 'b1', type: 'business' }, { externalId: 'p', type: 'personal' }, { externalId: 'b2', type: 'business' }], existing);
  expect(r.labels.find(l => l.externalId === 'b2')!.label).toBe('other_business');
  expect(r.labels.find(l => l.externalId === 'p')!.label).toBe('other_business');
  expect(r.labels.filter(l => l.label === 'company')).toHaveLength(1);
  expect(r.needsCompanyChoice).toBe(false);
});
test('choosing a new company demotes the previous one to other_business', () => {
  const next = applyLabelChange([{ externalId: 'b1', type: 'business', label: 'company', labelSource: 'auto' },
    { externalId: 'b2', type: 'business', label: 'other_business', labelSource: 'auto' }], 'b2', 'company');
  expect(next).toEqual([{ externalId: 'b1', type: 'business', label: 'other_business', labelSource: 'manual' },
    { externalId: 'b2', type: 'business', label: 'company', labelSource: 'manual' }]);
});
// ai-budget.config.test.ts
test('missing secret hides the feature', () => { expect(getAiBudgetConfig({ AI_BUDGET_CLIENT_ID: 'x', BACKEND_URL: 'https://api.eksiegowyai.pl', FRONTEND_URL: 'https://eksiegowyai.pl' }, true)).toBeNull(); });
test('missing encryption key hides the feature', () => { expect(getAiBudgetConfig(fullEnv, false)).toBeNull(); });
test('derives URLs', () => {
  expect(getAiBudgetConfig(fullEnv, true)).toMatchObject({ apiUrl: 'https://api.ai-budget.pl', authorizeUrl: 'https://app.ai-budget.pl/authorize',
    tokenUrl: 'https://api.ai-budget.pl/oauth/token', revokeUrl: 'https://api.ai-budget.pl/oauth/revoke',
    redirectUri: 'https://api.eksiegowyai.pl/api/integrations/ai-budget/callback' });
});
```

- [ ] **Step 2: Run** `cd packages/api && npx jest src/services/ai-budget/__tests__/ai-budget.domain.test.ts src/services/ai-budget/__tests__/ai-budget-labels.test.ts src/services/ai-budget/__tests__/ai-budget.config.test.ts`. Expected: FAIL (modules not found).
- [ ] **Step 3: Implement the four files.**
  - `warsawToday` uses `Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' })`.
  - `getAiBudgetConfig`:
    - defaults `encryptionConfigured` to `cryptoService.isConfigured()` (import from `../crypto.instance`);
    - strips trailing slashes from the URLs;
    - returns `null` if `AI_BUDGET_CLIENT_ID`, `AI_BUDGET_CLIENT_SECRET`, `BACKEND_URL` or `FRONTEND_URL` is empty.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai-budget): config, spending rules and label rules`

---

### Task 3: HTTP transport, OAuth client and token refresh under a Redis lock

**Files:**
- Modify: `src/lib/redis.ts`, adding three wrapper methods
- Create: `ai-budget-transport.ts`, `ai-budget-errors.ts`, `ai-budget-oauth.client.ts`, `ai-budget-token.manager.ts`, `ai-budget-api.client.ts`, `__tests__/fakes.ts` (`FakeTransport`, `FakeRedis`; the repository fake is added in Task 4)
- Test: `__tests__/ai-budget-token.manager.test.ts`, `__tests__/ai-budget-api.client.test.ts`

**Interfaces:**
- Consumes: `getAiBudgetConfig`, `TokenResponse`, `RemoteAccount`, `PublicExpenseWire`, `RemoteCategory` (Task 2); `CryptoService.encryptToString/decryptFromString`.
- Produces:
```ts
// lib/redis.ts (added to the `redis` wrapper)
setNxPx(key: string, value: string, ttlMs: number): Promise<boolean>   // SET key value NX PX ttl
getDel(key: string): Promise<string | null>                            // GETDEL
delIfEquals(key: string, value: string): Promise<boolean>              // Lua compare-and-delete
export type RedisLike = Pick<typeof redis, 'get'|'setEx'|'del'|'incr'|'setNxPx'|'getDel'|'delIfEquals'>;
// ai-budget-transport.ts
export interface TransportRequest { method: 'GET'|'POST'|'PATCH'|'DELETE'; url: string; headers?: Record<string,string>;
  query?: Record<string, string | number | undefined>; json?: unknown; form?: Record<string,string> }
export interface TransportResponse { status: number; headers: Record<string,string>; data: unknown }
export interface AiBudgetTransport { request(req: TransportRequest): Promise<TransportResponse> }
export function createAxiosTransport(timeoutMs?: number /* 15000 */): AiBudgetTransport   // validateStatus: () => true
// ai-budget-errors.ts
export class AiBudgetNotConnectedError extends Error {}
export class AiBudgetReconnectRequiredError extends Error {}
export class AiBudgetApiError extends Error { constructor(readonly status: number, readonly code: string, readonly retryAfterSec?: number) }
export const ACCOUNT_ACCESS_CODES = ['account_not_granted', 'grant_inactive', 'account_encrypted'] as const;
// ai-budget-oauth.client.ts
export class AiBudgetOAuthClient {
  constructor(config: AiBudgetConfig, transport: AiBudgetTransport)
  exchangeCode(code: string, codeVerifier: string): Promise<TokenResponse>
  refresh(refreshToken: string): Promise<TokenResponse>          // OAuth error → AiBudgetApiError(status, error)
  revoke(token: string): Promise<void>
}
// ai-budget-token.manager.ts — the token store is declared HERE; Task 4's AiBudgetRepository extends it
export interface ConnectionRow { id: string; userId: string; accessTokenEnc: string | null; refreshTokenEnc: string | null;
  accessTokenExpiresAt: Date | null; scope: string | null; status: 'active'|'needs_reconnect'|'revoked'; statusChangedAt: Date; needsCompanyChoice: boolean }
export interface StoredTokens { accessTokenEnc: string; refreshTokenEnc: string; accessTokenExpiresAt: Date; scope: string }
export interface TokenStore {
  getConnection(userId: string): Promise<ConnectionRow | null>;
  upsertConnectionTokens(userId: string, t: StoredTokens): Promise<ConnectionRow>;   // status → active, statusChangedAt now
  updateTokens(connectionId: string, t: StoredTokens): Promise<void>;
  setConnectionStatus(userId: string, status: ConnectionRow['status'], at: Date): Promise<void>;
}
export class AiBudgetTokenManager {
  constructor(store: TokenStore, crypto: CryptoService, redis: RedisLike, oauth: AiBudgetOAuthClient,
    opts?: { lockTtlMs?: number /*30000*/; waitMs?: number /*10000*/; pollMs?: number /*200*/; skewMs?: number /*60000*/; now?: () => Date })
  getAccessToken(userId: string): Promise<string>
  forceRefresh(userId: string, staleAccessToken: string): Promise<string>
  saveInitialTokens(userId: string, tokens: TokenResponse): Promise<void>
}
// ai-budget-api.client.ts
export interface ExpensePage { data: PublicExpenseWire[]; next_cursor: string | null; has_more: boolean }
export interface ChangesPage { changes: Array<{ type: 'upsert'; expense: PublicExpenseWire } | { type: 'delete'; id: string }>; next_cursor: string; has_more: boolean }
export interface ExpenseCreateBody { amount: string; currency?: string; date: string; category_id?: string; merchant?: string; description?: string }
export type ExpenseUpdateBody = Partial<{ amount: string; currency: string; date: string; category_id: string | null; merchant: string | null; description: string | null }>;
export class AiBudgetApiClient {
  constructor(config: AiBudgetConfig, transport: AiBudgetTransport, tokens: AiBudgetTokenManager)
  setAccountAccessListener(fn: (userId: string, accountExternalId: string, code: string) => Promise<void>): void
  listAccounts(userId: string): Promise<RemoteAccount[]>                       // GET /public/v1/accounts → { data: [...] }
  listExpenses(userId: string, accountId: string, q: { date_from?: string; date_to?: string; category_id?: string; search?: string; limit?: number; cursor?: string }): Promise<ExpensePage>
  getChanges(userId: string, accountId: string, cursor: string | null, limit?: number /*200*/): Promise<ChangesPage>
  listCategories(userId: string, accountId: string): Promise<RemoteCategory[]>  // GET /public/v1/categories → { data: [...] }
  createExpense(userId: string, accountId: string, body: ExpenseCreateBody, idempotencyKey: string): Promise<PublicExpenseWire>
  updateExpense(userId: string, accountId: string, expenseId: string, body: ExpenseUpdateBody): Promise<PublicExpenseWire>
  deleteExpense(userId: string, accountId: string, expenseId: string): Promise<void>
}
```

- [ ] **Step 1: Write `fakes.ts`.**
  - `FakeTransport` holds a queue of responses per `"METHOD path"` and records every request.
  - `FakeRedis` is an in-memory implementation of `RedisLike` with TTLs, plus `advance(ms)`.
- [ ] **Step 2: Write the failing tests**

```ts
// ai-budget-token.manager.test.ts
test('returns the stored access token while more than 60 s remain', async () => { /* expiresAt = now+120s */ expect(await m.getAccessToken('u1')).toBe('aba_at_1'); expect(transport.requests).toHaveLength(0); });
test('refreshes under the lock and saves the rotated pair before returning', async () => {
  // expiresAt = now+30s; token endpoint returns aba_at_2 / aba_rt_2 / expires_in 3600
  expect(await m.getAccessToken('u1')).toBe('aba_at_2');
  expect(crypto.decryptFromString(store.conn.refreshTokenEnc!)).toBe('aba_rt_2');
  expect(transport.requests[0].form).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'aba_rt_1' });
  expect(await redis.get('aib:refresh:u1')).toBeNull();
});
test('two concurrent callers produce exactly one refresh', async () => {
  const [a, b] = await Promise.all([m.getAccessToken('u1'), m.getAccessToken('u1')]);
  expect(a).toBe('aba_at_2'); expect(b).toBe('aba_at_2');
  expect(transport.requests.filter(r => r.url.endsWith('/oauth/token'))).toHaveLength(1);
});
test('a caller that finds the lock held waits, re-reads the store and does not refresh', async () => {
  await redis.setNxPx('aib:refresh:u1', 'other-process', 30000);
  setTimeout(() => { store.conn = rotated; redis.del('aib:refresh:u1'); }, 50);
  expect(await m.getAccessToken('u1')).toBe('aba_at_9');
  expect(transport.requests).toHaveLength(0);
});
test('invalid_grant marks needs_reconnect and throws AiBudgetReconnectRequiredError', async () => {
  transport.queue('POST /oauth/token', 400, { error: 'invalid_grant', error_description: 'x' });
  await expect(m.getAccessToken('u1')).rejects.toBeInstanceOf(AiBudgetReconnectRequiredError);
  expect(store.conn.status).toBe('needs_reconnect');
});
test('a 503 on refresh keeps the connection active', async () => {
  transport.queue('POST /oauth/token', 503, { error: 'temporarily_unavailable' });
  await expect(m.getAccessToken('u1')).rejects.toMatchObject({ status: 503 });
  expect(store.conn.status).toBe('active');
});
test('no connection or revoked connection throws AiBudgetNotConnectedError', async () => { /* … */ });
// ai-budget-api.client.test.ts
test('every account-scoped call sends X-Account-Id and the bearer token', async () => {
  await api.listExpenses('u1', 'acc-1', { date_from: '2026-11-01' });
  expect(transport.requests[0].headers).toMatchObject({ 'X-Account-Id': 'acc-1', Authorization: 'Bearer aba_at_1' });
});
test('a 401 invalid_token refreshes once and retries once', async () => {
  transport.queue('GET /public/v1/expenses', 401, { error: { code: 'invalid_token', message: 'x' } });
  transport.queue('GET /public/v1/expenses', 200, { data: [], next_cursor: null, has_more: false });
  await api.listExpenses('u1', 'acc-1', {});
  expect(tokens.forceRefresh).toHaveBeenCalledTimes(1);
});
test('createExpense sends Idempotency-Key and string amounts', async () => {
  await api.createExpense('u1', 'acc-1', { amount: '45.00', date: '2026-11-02', merchant: 'Bistro' }, 'b7e3c1a9-4f2d-4e8b-9a6c-0d5f7e1b3a24');
  expect(transport.requests[0].headers!['Idempotency-Key']).toBe('b7e3c1a9-4f2d-4e8b-9a6c-0d5f7e1b3a24');
  expect(typeof (transport.requests[0].json as any).amount).toBe('string');
});
test('account_not_granted notifies the listener and throws AiBudgetApiError(403, code)', async () => { /* listener called with ('u1','acc-1','account_not_granted') */ });
test('errors carry no token, header or body', async () => {
  transport.queue('GET /public/v1/accounts', 500, { error: { code: 'internal_error', message: 'x' } });
  const err = await api.listAccounts('u1').catch(e => e);
  expect(JSON.stringify(err)).not.toContain('aba_at_1'); expect(Object.keys(err)).toEqual(expect.not.arrayContaining(['config', 'request', 'response']));
});
test('429 surfaces retryAfterSec from Retry-After', async () => { /* headers { 'retry-after': '12' } → err.retryAfterSec === 12 */ });
```

- [ ] **Step 3: Run** `npx jest src/services/ai-budget/__tests__/ai-budget-token.manager.test.ts src/services/ai-budget/__tests__/ai-budget-api.client.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - The lock value is a random UUID. Release with `delIfEquals`.
  - Inside the lock, re-read the connection. If `accessTokenExpiresAt` is already more than `skewMs` ahead, another worker refreshed: return its token.
  - Waiters poll `get(lockKey)` every `pollMs` up to `waitMs`, then re-read the store. If the token is still stale, take the lock themselves.
  - `forceRefresh` refreshes only if the stored access token still equals `staleAccessToken`.
  - Client authentication is `client_secret_basic` (an `Authorization: Basic` header).
  - `logger` calls in these files log `userId`, the account id, the HTTP status and the error code only.
- [ ] **Step 5: Run the same command.** Expected: PASS.
- [ ] **Step 6: Commit** `feat(ai-budget): HTTP client with locked token refresh`

---

### Task 4: Repository, account list and labels

**Files:**
- Create: `ai-budget.repository.ts`, `ai-budget-accounts.service.ts`
- Modify: `__tests__/fakes.ts` (add `InMemoryAiBudgetRepository`)
- Test: `__tests__/ai-budget-accounts.service.test.ts`

**Interfaces:**
- Consumes: `computeAutoLabels`, `applyLabelChange` (Task 2); `AiBudgetApiClient.listAccounts` (Task 3).
- Produces:
```ts
// ConnectionRow, StoredTokens, TokenStore come from ai-budget-token.manager.ts (Task 3)
export interface AccountRow { id: string; connectionId: string; userId: string; externalId: string; name: string; type: string; currency: string;
  access: 'read'|'read_write'; active: boolean; inactiveReason: string | null; label: AiBudgetLabel; labelSource: AiBudgetLabelSource;
  syncCursor: string | null; syncGeneration: number; lastSyncedAt: Date | null; lastSyncError: string | null; fullResyncAt: Date | null }
export interface MirrorExpenseInput { externalId: string; amount: string; currency: string; date: string; categoryId: string | null;
  categorySplits: { categoryId: string; amount: string }[]; merchant: string | null; description: string | null;
  isDebt: boolean; isSplitReceivable: boolean; remoteUpdatedAt: Date }
export interface MirrorExpenseRow extends MirrorExpenseInput { accountId: string }
export interface AiBudgetRepository extends TokenStore {
  setNeedsCompanyChoice(userId: string, value: boolean): Promise<void>;
  clearTokens(userId: string): Promise<void>;                     // tokens → null, status revoked
  listActiveConnections(): Promise<ConnectionRow[]>;
  listReconnectOlderThan(cutoff: Date): Promise<ConnectionRow[]>;
  listAccounts(userId: string): Promise<AccountRow[]>;
  replaceLabels(userId: string, labels: { externalId: string; label: AiBudgetLabel; labelSource: AiBudgetLabelSource }[]): Promise<void>; // one $transaction, demote before promote
  upsertAccount(connectionId: string, userId: string, a: Pick<AccountRow,'externalId'|'name'|'type'|'currency'|'access'|'active'|'inactiveReason'|'label'|'labelSource'>): Promise<AccountRow>;
  updateAccountSync(accountId: string, patch: Partial<Pick<AccountRow,'syncCursor'|'syncGeneration'|'lastSyncedAt'|'lastSyncError'|'fullResyncAt'>>): Promise<void>;
  deleteAccount(accountId: string): Promise<void>;                 // cascades mirror + dismissals
  clearMirror(accountId: string): Promise<void>;                   // delete expenses + dismissals; cursor/lastSyncedAt/fullResyncAt null, generation 0
  applyChangesPage(accountId: string, page: { upserts: MirrorExpenseInput[]; deletes: string[]; nextCursor: string; generation: number }): Promise<'applied' | 'not_company'>;
  sweepGeneration(accountId: string, generation: number): Promise<number>;
  listMirrorExpenses(accountId: string, from: string, to: string): Promise<MirrorExpenseRow[]>;
  upsertMirrorExpense(accountId: string, e: MirrorExpenseInput): Promise<void>;
  deleteMirrorExpense(accountId: string, externalId: string): Promise<void>;
  listDismissedIds(accountId: string): Promise<Set<string>>;
  addDismissal(accountId: string, externalExpenseId: string, reason: string | null): Promise<void>;   // idempotent
}
export class PrismaAiBudgetRepository implements AiBudgetRepository { constructor(prisma: PrismaClient) }

export interface AccountsSyncResult { accounts: AccountRow[]; dropped: string[]; needsCompanyChoice: boolean; companyChanged: boolean }
export class AiBudgetAccountsService {
  constructor(repo: AiBudgetRepository, api: AiBudgetApiClient)
  setCompanyChangedListener(fn: (userId: string) => void): void
  syncAccountList(userId: string): Promise<AccountsSyncResult>
  setLabel(userId: string, accountRowId: string, label: AiBudgetLabel): Promise<AccountRow[]>
  getCompanyAccount(userId: string): Promise<AccountRow | null>     // label company AND active
  handleAccessError(userId: string, accountExternalId: string, code: string): Promise<void>
}
```

- [ ] **Step 1: Write the failing tests** (`InMemoryAiBudgetRepository` + `FakeTransport`):

```ts
test('first sync creates rows with automatic labels', async () => { /* accounts: business + personal → company/auto, private/auto */ });
test('an account missing from /accounts is dropped with its mirror and dismissals', async () => {
  // repo has account b1 (company) with 2 mirror rows and 1 dismissal; /accounts now returns only p
  const r = await svc.syncAccountList('u1');
  expect(r.dropped).toEqual(['b1']); expect(repo.expenses('b1-row')).toHaveLength(0); expect(repo.dismissals('b1-row')).toHaveLength(0);
});
test('an inactive account keeps its mirror rows and stores the reason', async () => {
  // /accounts returns b1 with active:false, reason:'role'
  expect((await repo.listAccounts('u1'))[0]).toMatchObject({ active: false, inactiveReason: 'role' }); expect(repo.expenses('b1-row')).toHaveLength(2);
});
test('reconnect keeps manual labels of still-granted accounts', async () => { /* p manual other_business stays other_business */ });
test('relabelling the company account away deletes its mirror, cursor and dismissals at once', async () => {
  await svc.setLabel('u1', 'b1-row', 'private');
  const row = (await repo.listAccounts('u1')).find(a => a.id === 'b1-row')!;
  expect(row).toMatchObject({ label: 'private', labelSource: 'manual', syncCursor: null, lastSyncedAt: null });
  expect(repo.expenses('b1-row')).toHaveLength(0); expect(repo.dismissals('b1-row')).toHaveLength(0);
});
test('choosing a new company demotes the old one, clears its mirror and fires the listener', async () => {
  await svc.setLabel('u1', 'b2-row', 'company');
  expect(labelsOf(repo)).toEqual({ b1: 'other_business', b2: 'company' }); expect(listener).toHaveBeenCalledWith('u1');
  expect(repo.expenses('b1-row')).toHaveLength(0);
});
test('choosing a company clears needsCompanyChoice', async () => { /* … */ });
test('handleAccessError(account_not_granted) re-syncs the account list', async () => { /* listAccounts called once */ });
```

- [ ] **Step 2: Run** `npx jest src/services/ai-budget/__tests__/ai-budget-accounts.service.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the repository with Prisma (amounts as `Prisma.Decimal`, `date` as a `@db.Date` from `YYYY-MM-DD`), the in-memory fake (honours the one-company rule by throwing), and the service.
  - `applyChangesPage` runs in a `$transaction`. It first re-reads the account and returns `'not_company'` without writing if the row is gone or `label !== 'company'`.
  - `setLabel` changes labels through `replaceLabels`. Any account whose label leaves `company` gets `clearMirror`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai-budget): account list, labels and drops`

---

### Task 5: Company mirror sync through the changes feed

**Files:**
- Create: `ai-budget-sync.service.ts`
- Test: `__tests__/ai-budget-sync.service.test.ts`

**Interfaces:**
- Consumes: `AiBudgetRepository`, `AiBudgetAccountsService.getCompanyAccount`, `AiBudgetApiClient.getChanges`, `RedisLike`.
- Produces:
```ts
export type SyncOutcome = 'synced' | 'skipped_locked' | 'no_company' | 'needs_reconnect' | 'failed' | 'aborted_relabelled';
export const FULL_RESYNC_INTERVAL_MS = 7 * 24 * 3600_000;
export const SYNC_LOCK_TTL_MS = 120_000;
export function toMirrorInput(e: PublicExpenseWire): MirrorExpenseInput
export class AiBudgetMirrorSyncService {
  constructor(repo: AiBudgetRepository, accounts: AiBudgetAccountsService, api: AiBudgetApiClient, redis: RedisLike, now?: () => Date)
  syncCompany(userId: string, opts?: { fullResync?: boolean }): Promise<SyncOutcome>
  syncIfStale(userId: string, maxAgeMs?: number /* 300_000 */): Promise<SyncOutcome | 'fresh'>
}
```

- [ ] **Step 1: Write the failing tests**

```ts
test('first sync starts without a cursor and stores next_cursor after each page', async () => {
  // page1: 2 upserts, has_more true, next_cursor c1; page2: 1 upsert, has_more false, next_cursor c2
  expect(await sync.syncCompany('u1')).toBe('synced');
  expect(transport.requests.map(r => r.query?.cursor)).toEqual([undefined, 'c1']);
  expect(account().syncCursor).toBe('c2'); expect(repo.expenses('b1-row')).toHaveLength(3); expect(account().lastSyncedAt).not.toBeNull();
});
test('tombstones delete local rows and unknown ids are a no-op', async () => { /* delete e1 (known) + zz (unknown) */ });
test('an upsert of an existing id replaces it', async () => { /* amount 10.00 → 12.00 */ });
test('incremental sync continues from the stored cursor', async () => { /* fullResyncAt = now-1d → first request cursor 'c2' */ });
test('weekly full resync sweeps rows not seen (expense moved to another account)', async () => {
  // fullResyncAt = now-8d; feed returns only e1 → e2 swept
  expect(repo.expenses('b1-row').map(e => e.externalId)).toEqual(['e1']);
});
test('invalid_cursor resets to a full resync', async () => { /* 400 invalid_cursor then success from null */ });
test('relabelled mid-sync: the next page is not written', async () => {
  // after page1 the test relabels b1 to private (clearMirror); page2 must not resurrect rows
  expect(await sync.syncCompany('u1')).toBe('aborted_relabelled'); expect(repo.expenses('b1-row')).toHaveLength(0);
});
test('a concurrent sync of the same account is skipped', async () => { await redis.setNxPx('aib:sync:b1-row', 'x', 1000); expect(await sync.syncCompany('u1')).toBe('skipped_locked'); });
test('no company account → no_company, no HTTP', async () => { /* … */ });
test('reconnect required → needs_reconnect, lastSyncError unchanged', async () => { /* tokens throw AiBudgetReconnectRequiredError */ });
test('a failure stores lastSyncError code and keeps the old lastSyncedAt', async () => { /* 503 → lastSyncError 'unavailable' */ });
test('changes invalidate the reconciliation cache', async () => { await redis.setEx('aib:recon:u1', 300, '{}'); await sync.syncCompany('u1'); expect(await redis.get('aib:recon:u1')).toBeNull(); });
test('syncIfStale returns fresh when lastSyncedAt is under 5 minutes old', async () => { /* … */ });
```

- [ ] **Step 2: Run** `npx jest src/services/ai-budget/__tests__/ai-budget-sync.service.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The run is full when `opts.fullResync`, `fullResyncAt` is null or older than `FULL_RESYNC_INTERVAL_MS`, or the API answers `invalid_cursor`.
  - A full run uses `generation = row.syncGeneration + 1` and starts from cursor `null`. After the last page it calls `sweepGeneration` and sets `fullResyncAt` and `syncGeneration`.
  - The lock key is `aib:sync:{accountRowId}`, held for `SYNC_LOCK_TTL_MS`.
  - Logs carry counts only.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai-budget): company mirror sync with cursor and tombstones`

---

### Task 6: OAuth connect, callback, disconnect, status, and the integration routes

**Files:**
- Create: `ai-budget-oauth.service.ts`, `ai-budget.instance.ts`, `index.ts` (barrel), `src/controllers/ai-budget.controller.ts`, `src/routes/ai-budget.routes.ts`, `src/types/ai-budget-api.types.ts`
- Modify: `src/index.ts` (mount at `/api/integrations/ai-budget`)
- Test: `__tests__/ai-budget-oauth.service.test.ts`, `src/controllers/__tests__/ai-budget.controller.test.ts` (supertest, services mocked)

**Interfaces:**
- Consumes: Tasks 2 to 5.
- Produces:
```ts
// types/ai-budget-api.types.ts
export interface AiBudgetAccountDto { id: string; externalId: string; name: string; type: string; currency: string; access: 'read'|'read_write';
  active: boolean; inactiveReason: string | null; label: AiBudgetLabel; labelSource: AiBudgetLabelSource }
export interface AiBudgetStatusDto { available: boolean; connection: null | { status: 'active' | 'needs_reconnect';
  lastSyncedAt: string | null; lastSyncError: string | null; needsCompanyChoice: boolean; accounts: AiBudgetAccountDto[] } }
// ai-budget-oauth.service.ts
export const OAUTH_STATE_TTL_SECONDS = 600;
export function pkcePair(): { verifier: string; challenge: string }    // 32 random bytes base64url; challenge = base64url(sha256(verifier)) (43 chars)
export class AiBudgetOAuthService {
  constructor(config: AiBudgetConfig | null, deps: { redis: RedisLike; oauth: AiBudgetOAuthClient; tokens: AiBudgetTokenManager;
    accounts: AiBudgetAccountsService; sync: AiBudgetMirrorSyncService; repo: AiBudgetRepository })
  getStatus(userId: string): Promise<AiBudgetStatusDto>
  startConnect(userId: string): Promise<{ authorizeUrl: string }>
  handleCallback(query: { code?: string; state?: string; error?: string }): Promise<string>   // returns the redirect URL
  disconnect(userId: string): Promise<{ revokedRemotely: boolean }>
}
```

Routes (all under `/api/integrations/ai-budget`; all but `callback` use `authenticate`; responses use the `{ success, data }` envelope):

| Method / path | Handler | Notes |
|---|---|---|
| `GET /status` | `getStatus` | Also calls `accounts.syncAccountList` when the status is `active`. Errors are swallowed and the stored rows returned. |
| `POST /connect` | `startConnect` | `rateLimiter({ windowMs: 15*60*1000, max: 10 })`. `503` when unavailable. |
| `GET /callback` | `handleCallback` → `res.redirect(302, url)` | No auth; `state` is the binding. |
| `POST /disconnect` | `disconnect` | |
| `PATCH /accounts/:accountId/label` | `accounts.setLabel` | Body: Zod `{ label: z.enum(['company','other_business','private']) }`. `404` for another user's row. |
| `POST /sync` | `sync.syncCompany` fire-and-forget | `rateLimiter({ windowMs: 60*1000, max: 6 })`. Returns `{ started: true }`. |

- [ ] **Step 1: Write the failing tests**

```ts
test('startConnect builds the authorize URL with PKCE S256, exact scopes and a stored state', async () => {
  const { authorizeUrl } = await svc.startConnect('u1');
  const u = new URL(authorizeUrl); const p = u.searchParams;
  expect(u.origin + u.pathname).toBe('https://app.ai-budget.pl/authorize');
  expect(p.get('scope')).toBe('expenses:read expenses:write categories:read receipts:read');
  expect(p.get('code_challenge_method')).toBe('S256'); expect(p.get('code_challenge')).toHaveLength(43);
  expect(p.get('redirect_uri')).toBe('https://api.eksiegowyai.pl/api/integrations/ai-budget/callback');
  expect(JSON.parse((await redis.get(`aib:oauth:state:${p.get('state')}`))!)).toMatchObject({ userId: 'u1' });
});
test('callback exchanges the code, stores encrypted tokens, syncs accounts and starts the first sync', async () => {
  const url = await svc.handleCallback({ code: 'c', state });
  expect(url).toBe('https://eksiegowyai.pl/settings/integrations?ai_budget=connected');
  expect(transport.requests[0].form).toMatchObject({ grant_type: 'authorization_code', code: 'c', code_verifier: verifier });
  expect(repo.conn('u1').accessTokenEnc).not.toContain('aba_at_'); expect(accounts.syncAccountList).toHaveBeenCalledWith('u1');
  expect(sync.syncCompany).toHaveBeenCalledWith('u1', { fullResync: true });
});
test('a state is single-use', async () => { await svc.handleCallback({ code: 'c', state }); expect(await svc.handleCallback({ code: 'c', state })).toBe('https://eksiegowyai.pl/settings/integrations?ai_budget=error&reason=invalid_state'); });
test('an expired or unknown state stores nothing', async () => { /* redis.advance(601_000) → reason=invalid_state, no token request */ });
test('access_denied redirects with reason=access_denied and consumes the state', async () => { /* … */ });
test('a failed code exchange redirects with reason=exchange_failed', async () => { /* 400 invalid_grant */ });
test('reconnect does not revoke the previous tokens', async () => { /* existing connection → no POST /oauth/revoke */ });
test('disconnect revokes at AI Budget, then clears tokens, mirror and dismissals', async () => {
  expect(await svc.disconnect('u1')).toEqual({ revokedRemotely: true });
  expect(transport.requests.at(-1)!.url).toBe('https://api.ai-budget.pl/oauth/revoke');
  expect(repo.conn('u1')).toMatchObject({ accessTokenEnc: null, refreshTokenEnc: null, status: 'revoked' });
  expect(repo.allExpenses()).toHaveLength(0); expect(repo.allDismissals()).toHaveLength(0);
});
test('disconnect still clears locally when revoke fails and reports revokedRemotely:false', async () => { /* 503 on revoke */ });
test('status is unavailable when config is null and maps revoked → connection:null', async () => { /* … */ });
// controller test
test('GET /callback needs no JWT and answers 302', async () => { /* supertest, oauthService.handleCallback mocked */ });
test('PATCH label validates the enum', async () => { /* label:'firma' → 400 */ });
test('POST /connect answers 503 when the feature is unavailable', async () => { /* … */ });
```

- [ ] **Step 2: Run** `npx jest src/services/ai-budget/__tests__/ai-budget-oauth.service.test.ts src/controllers/__tests__/ai-budget.controller.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The state is 16 random bytes in base64url, stored at `aib:oauth:state:{state}` = `{ userId, verifier }` with `OAUTH_STATE_TTL_SECONDS` and read once with `getDel`.
  - Redirects are `${frontendUrl}/settings/integrations?ai_budget=connected` or `?ai_budget=error&reason=<invalid_state|access_denied|exchange_failed|unavailable>`.
  - The disconnect order is: revoke the refresh token, then `clearMirror` for every account, then delete all dismissals, then `clearTokens`. Account rows are kept so manual labels survive a later reconnect.
  - `ai-budget.instance.ts` wires the singletons:
    - `api.setAccountAccessListener(accounts.handleAccessError)`;
    - `accounts.setCompanyChangedListener(userId => void sync.syncCompany(userId, { fullResync: true }))`.

    When the config is null it exports `aiBudget = null`.
- [ ] **Step 4: Run.** Expected: PASS. Then run `npm run build --filter=@accounting-ai-agent/api`. Expected: tsc exits 0.
- [ ] **Step 5: Commit** `feat(ai-budget): OAuth connect, callback, disconnect and integration routes`

---

### Task 7: Live reads with an encrypted Redis cache

**Files:**
- Create: `ai-budget-live.service.ts`
- Test: `__tests__/ai-budget-live.service.test.ts`

**Interfaces:**
- Consumes: `AiBudgetApiClient.listExpenses/listCategories`, `CryptoService`, `RedisLike`.
- Produces:
```ts
export const LIVE_CACHE_TTL_SECONDS = 300;
export const LIVE_MAX_PAGES = 10;            // × limit 200
export interface LiveExpenseFilter { dateFrom: string; dateTo: string; categoryId?: string; search?: string }
export class AiBudgetLiveReadService {
  constructor(api: AiBudgetApiClient, redis: RedisLike, crypto: CryptoService)
  listExpenses(userId: string, account: { id: string; externalId: string }, f: LiveExpenseFilter): Promise<{ expenses: PublicExpenseWire[]; truncated: boolean }>
  listCategories(userId: string, account: { id: string; externalId: string }): Promise<RemoteCategory[]>
  invalidate(userId: string, accountRowId: string): Promise<void>      // INCR aib:live:ver:{userId}:{accountRowId}
}
```

- [ ] **Step 1: Write the failing tests**

```ts
test('second identical read within 5 minutes hits the cache', async () => { await live.listExpenses('u1', acc, f); await live.listExpenses('u1', acc, f); expect(transport.requests).toHaveLength(1); });
test('cached values are ciphertext, never plaintext, with a 300 s TTL', async () => {
  await live.listExpenses('u1', acc, f);
  const [key, ttl, value] = redis.lastSetEx(); expect(key).toMatch(/^aib:live:u1:acc-row:\d+:[0-9a-f]{64}$/);
  expect(ttl).toBe(300); expect(value).not.toContain('Biedronka'); expect(crypto.decryptFromString(value)).toContain('Biedronka');
});
test('invalidate makes the next read go to AI Budget', async () => { /* … 2 requests */ });
test('a cache entry that fails to decrypt is treated as a miss', async () => { /* … */ });
test('pages are followed up to 10 and then truncated:true', async () => { /* 11 pages has_more → 10 requests, truncated */ });
test('nothing from the expense payload reaches the logger', async () => {
  const spy = jest.spyOn(logger, 'info'); jest.spyOn(logger, 'debug'); jest.spyOn(logger, 'warn'); jest.spyOn(logger, 'error');
  await live.listExpenses('u1', acc, f);
  for (const s of [logger.info, logger.debug, logger.warn, logger.error] as jest.Mock[]) expect(JSON.stringify(s.mock.calls)).not.toMatch(/Biedronka|42\.50/);
});
```

- [ ] **Step 2: Run** `npx jest src/services/ai-budget/__tests__/ai-budget-live.service.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The cache key is `aib:live:{userId}:{accountRowId}:{version}:{sha256(JSON.stringify(sorted filter))}`. Categories use the filter `{ kind: 'categories' }`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai-budget): live reads with encrypted short-lived cache`

---

### Task 8: Reconciliation against wFirma cost documents

**Files:**
- Create: `reconcile.ts`, `ai-budget-reconciliation.service.ts`
- Modify: `src/routes/ai-budget.routes.ts`, `src/controllers/ai-budget.controller.ts` (`POST /reconciliation/dismissals`)
- Test: `__tests__/reconcile.test.ts`, `__tests__/ai-budget-reconciliation.service.test.ts`

**Interfaces:**
- Consumes: `AiBudgetRepository.listMirrorExpenses/listDismissedIds/addDismissal`, `AiBudgetAccountsService.getCompanyAccount`, `WFirmaServiceFactory.hasUserCredentials/getServiceForUser`, `WFirmaIntegrationService.findExpenses` (`WFirmaExpense.total`, `.currency`, `.date`, `.contractorName`), `warsawToday`, `warsawMonthWindow`, `addDays`, `isSpending`.
- Produces:
```ts
// reconcile.ts
export const DATE_TOLERANCE_DAYS = 7; export const AMOUNT_TOLERANCE_CENTS = 1;
export interface ReconExpense { id: string; date: string; amountCents: number; currency: string; text: string | null }   // text = merchant ?? description
export interface ReconDocument { id: string; date: string; grossCents: number; currency: string; contractorName: string | null }
export function normalizeName(s: string): string[]           // lowercase, strip diacritics + punctuation, drop sp|z|o|oo|sa|spk|sj|spółka|ltd|gmbh tokens
export function nameSimilarity(a: string | null, b: string | null): number   // token Jaccard 0..1; null → 0
export function matchExpensesToDocuments(expenses: ReconExpense[], docs: ReconDocument[]): { matched: { expenseId: string; documentId: string }[]; unmatched: ReconExpense[] }
// ai-budget-api.types.ts (added)
export interface UnmatchedItemDto { expenseId: string; date: string; amount: number; currency: string; merchant: string | null }
export type ReconciliationDto =
  | { state: 'wfirma_not_connected' } | { state: 'wfirma_error' }
  | { state: 'ok'; window: { from: string; to: string }; unmatchedCount: number; unmatchedTotals: CurrencyTotal[]; items: UnmatchedItemDto[]; dismissedCount: number };
// service
export const RECON_CACHE_TTL_SECONDS = 300; export const RECON_TOP_ITEMS = 5;
export class AiBudgetReconciliationService {
  constructor(repo: AiBudgetRepository, accounts: AiBudgetAccountsService, wfirma: WFirmaServiceFactory, redis: RedisLike, now?: () => Date)
  getSummary(userId: string): Promise<ReconciliationDto>          // caller has already established a ready company account
  listUnmatched(userId: string): Promise<UnmatchedItemDto[]>        // full list, for the chat tool
  dismiss(userId: string, externalExpenseId: string, reason: string | null): Promise<void>   // deletes aib:recon:{userId}
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// reconcile.test.ts
test('match needs same currency, amount within 0.01 and date within ±7 days', () => {
  const e = { id: 'e1', date: '2026-11-10', amountCents: 12300, currency: 'PLN', text: 'Orlen' };
  expect(matchExpensesToDocuments([e], [{ id: 'd1', date: '2026-11-17', grossCents: 12301, currency: 'pln', contractorName: 'ORLEN S.A.' }]).matched).toHaveLength(1);
  expect(matchExpensesToDocuments([e], [{ id: 'd1', date: '2026-11-18', grossCents: 12300, currency: 'PLN', contractorName: null }]).unmatched).toEqual([e]);
  expect(matchExpensesToDocuments([e], [{ id: 'd1', date: '2026-11-10', grossCents: 12302, currency: 'PLN', contractorName: null }]).unmatched).toEqual([e]);
  expect(matchExpensesToDocuments([e], [{ id: 'd1', date: '2026-11-10', grossCents: 12300, currency: 'EUR', contractorName: null }]).unmatched).toEqual([e]);
});
test('a document matches at most one expense', () => {
  const r = matchExpensesToDocuments([exp('e1', '2026-11-10'), exp('e2', '2026-11-11')], [doc('d1', '2026-11-10')]);
  expect(r.matched).toHaveLength(1); expect(r.unmatched).toHaveLength(1);
});
test('the contractor name most similar to the merchant wins a tie', () => {
  const r = matchExpensesToDocuments([{ ...exp('e1', '2026-11-10'), text: 'Orlen Stacja 123' }],
    [{ ...doc('d1', '2026-11-10'), contractorName: 'Shell Polska' }, { ...doc('d2', '2026-11-12'), contractorName: 'ORLEN S.A.' }]);
  expect(r.matched).toEqual([{ expenseId: 'e1', documentId: 'd2' }]);
});
test('expenses with fewer candidates are assigned first', () => { /* e1 has candidates d1,d2; e2 only d1 → e2↔d1, e1↔d2 */ });
// service test
test('scope is the previous month through today, debts and split receivables excluded', async () => { /* now 2026-11-02 → mirror read 2026-10-01..2026-11-02; isDebt row not in unmatched */ });
test('wFirma is queried from window start − 7 to today + 7 and no usage is counted', async () => {
  expect(wfirmaService.findExpenses).toHaveBeenCalledWith({ dateFrom: new Date('2026-09-24'), dateTo: new Date('2026-11-09'), limit: 1000 });
  expect(incrementWFirmaUsage).not.toHaveBeenCalled();
});
test('dismissed items are excluded and counted, and dismissal survives a resync', async () => { /* … dismissedCount 1 */ });
test('top 5 by amount desc; totals per currency', async () => { /* 7 unmatched (6 PLN, 1 EUR) → items.length 5, unmatchedTotals two lines */ });
test('no wFirma credentials → wfirma_not_connected; wFirma throws → wfirma_error (never "ok" with zero)', async () => { /* … */ });
test('result is cached 300 s under aib:recon:{userId} and dismiss clears it', async () => { /* … */ });
```

- [ ] **Step 2: Run** `npx jest src/services/ai-budget/__tests__/reconcile.test.ts src/services/ai-budget/__tests__/ai-budget-reconciliation.service.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The matching algorithm (it is not determined by the tests alone):

```text
candidates(e) = docs with same upper-cased currency, |grossCents − amountCents| ≤ 1, |daysBetween| ≤ 7
order expenses by (candidates.length asc, date asc, id asc); skip expenses with 0 candidates (→ unmatched)
for each expense: pick the unused candidate with max (nameSimilarity(e.text, d.contractorName), −|daysBetween|, d.id asc)
                  none left → unmatched
```

  wFirma documents map as `{ id, date: YYYY-MM-DD of exp.date in Warsaw, grossCents: Math.round(exp.total*100), currency: exp.currency, contractorName }`. The route `POST /reconciliation/dismissals` takes a Zod body `{ expenseId: string().min(1).max(100), reason: string().max(200).optional() }`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai-budget): reconciliation against wFirma cost documents`

---

### Task 9: Dashboard API — company section and private page

**Files:**
- Create: `ai-budget-dashboard.service.ts`
- Modify: `src/routes/dashboard.routes.ts` (`GET /ai-budget`, `GET /personal`), `src/types/ai-budget-api.types.ts`
- Test: `__tests__/ai-budget-dashboard.service.test.ts`

**Interfaces:**
- Consumes: `AiBudgetRepository`, `AiBudgetAccountsService`, `AiBudgetMirrorSyncService.syncIfStale`, `AiBudgetLiveReadService`, `AiBudgetReconciliationService.getSummary`, the domain helpers.
- Produces:
```ts
export interface CategoryTotalDto { categoryId: string | null; categoryName: string | null; total: number }
export type AiBudgetCompanyDto =
  | { state: 'unavailable' } | { state: 'not_connected' } | { state: 'needs_reconnect' }
  | { state: 'no_company_account'; needsCompanyChoice: boolean }
  | { state: 'company_inactive'; accountName: string; reason: string | null }
  | { state: 'syncing' } | { state: 'sync_failed' }                                    // never synced successfully
  | { state: 'ready'; account: { name: string; currency: string }; sync: { state: 'ok' | 'syncing' | 'failed'; lastSyncedAt: string };
      inactiveAccounts: number; currentMonth: string; spending: { currency: string; current: number; previous: number }[];
      categories: { currency: string; items: CategoryTotalDto[] }[];          // current month, desc by total
      reconciliation: ReconciliationDto };
export type AiBudgetPersonalDto =
  | { state: 'unavailable' } | { state: 'not_connected' } | { state: 'needs_reconnect' } | { state: 'no_private_accounts' } | { state: 'error' }
  | { state: 'ready'; accounts: { name: string; currency: string }[]; inactiveAccounts: number; failedAccounts: number; truncated: boolean;
      thisMonth: CurrencyTotal[]; trend: { month: string; totals: CurrencyTotal[] }[] /* 6 months, oldest first, includes current */;
      categories: { currency: string; items: CategoryTotalDto[] }[] /* current month, merged by category name */ };
export class AiBudgetDashboardService {
  constructor(deps: { repo; accounts; sync; live; reconciliation; now?: () => Date })
  getCompany(userId: string): Promise<AiBudgetCompanyDto>
  getPersonal(userId: string): Promise<AiBudgetPersonalDto>
}
```

- [ ] **Step 1: Write the failing tests**

```ts
test('needs_reconnect never returns figures even when mirror rows exist', async () => { expect(await dash.getCompany('u1')).toEqual({ state: 'needs_reconnect' }); });
test('never synced and sync running → syncing, not zeros', async () => { expect(await dash.getCompany('u1')).toEqual({ state: 'syncing' }); });
test('company spending: this month vs last month per currency, debts and split receivables excluded', async () => {
  // mirror: Nov PLN 100 + 50 (isDebt) + 20 (splitReceivable); Oct PLN 80; Nov EUR 10
  expect((await dash.getCompany('u1') as any).spending).toEqual([{ currency: 'EUR', current: 10, previous: 0 }, { currency: 'PLN', current: 100, previous: 80 }]);
});
test('category breakdown follows splits and resolves names via live categories', async () => { /* … */ });
test('private and other-business accounts never enter company figures', async () => { /* private account with mirror-less live data → live.listExpenses not called by getCompany */ });
test('triggers syncIfStale and reports sync.state', async () => { /* … */ });
test('several business accounts, none chosen → no_company_account with needsCompanyChoice', async () => { /* … */ });
test('personal: only private accounts, six-month trend oldest first, per currency', async () => {
  // now 2026-11-02 → months 2026-06..2026-11; other_business account ignored
});
test('personal: one private account failing → failedAccounts 1 and figures from the rest; all failing → error', async () => { /* … */ });
test('personal: inactive private account excluded and counted', async () => { /* … */ });
```

- [ ] **Step 2: Run** `npx jest src/services/ai-budget/__tests__/ai-budget-dashboard.service.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `getCompany` fires `sync.syncIfStale(userId)` without awaiting. It reads the mirror for `warsawMonthWindow(now, -1).from` through `warsawMonthWindow(now, 0).to`.
  - `sync.state` is `'syncing'` while the `aib:sync:{row}` lock exists.
  - `getPersonal` reads every active private account live for `warsawMonthWindow(now, -5).from` to `warsawMonthWindow(now, 0).to`.
  - Both routes return `{ success: true, data }`. With `aiBudget === null` they return `{ state: 'unavailable' }`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai-budget): dashboard company section and private page API`

---

### Task 10: Background sync job and 30-day cleanup

**Files:**
- Create: `ai-budget-sync.job.ts`
- Modify: `src/index.ts` (`aiBudgetSyncJob?.start()` beside `taxDeadlineReminderService.start()`; `stop()` in shutdown)
- Test: `__tests__/ai-budget-sync.job.test.ts`

**Interfaces:**
- Consumes: `AiBudgetRepository.listActiveConnections/listReconnectOlderThan/listAccounts/clearMirror`, `AiBudgetAccountsService.syncAccountList`, `AiBudgetMirrorSyncService.syncCompany`.
- Produces:
```ts
export const SYNC_INTERVAL_MS = 15 * 60 * 1000;
export const RECONNECT_RETENTION_MS = 30 * 24 * 3600_000;
export class AiBudgetSyncJob { constructor(deps, now?: () => Date); start(): void; stop(): void; tick(): Promise<void> }
```

- [ ] **Step 1: Write the failing tests**

```ts
test('tick refreshes the account list then syncs the company account of each active connection, sequentially', async () => { /* call order per user */ });
test('one user failing does not stop the others', async () => { /* … */ });
test('mirrors of connections in needs_reconnect for more than 30 days are cleared; younger ones kept', async () => { /* statusChangedAt now-31d vs now-29d */ });
test('start runs a tick and schedules 15-minute ticks; stop clears the timer', () => { jest.useFakeTimers(); /* … */ });
```

- [ ] **Step 2: Run** `npx jest src/services/ai-budget/__tests__/ai-budget-sync.job.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** following the `setInterval` + `start/stop` shape of `TaxDeadlineReminderService`. `tick` has an in-process re-entrancy guard.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai-budget): 15-minute sync job and reconnect retention cleanup`

---

### Task 11: i18n keys (api and web)

**Files:**
- Modify: `packages/api/src/i18n/locales/{pl,en,ru}.json`, `packages/api/src/i18n/index.ts`, `packages/web/src/i18n/locales/{en,pl,ru}.json`
- Create: `packages/web/src/i18n/__tests__/ai-budget-keys.test.ts`
- Test: the existing `packages/api/src/i18n/__tests__/i18n.locales.test.ts` (parity) and the new web test

**Interfaces:**
- Produces:
  - api: the `aiBudget` namespace, plus `export type AiBudgetTranslations = typeof plTranslations['aiBudget']` and `getAiBudgetTranslations(locale)`;
  - web: the `aiBudget` namespace.

  Tasks 12 and 14 to 17 read these keys and add none of their own.
- API keys (`aiBudget.*`), with the fixed English copy:
  - `label.company` "Company"
  - `label.other_business` "Other business"
  - `label.private` "Private"
  - `reconnect` "Connection to AI Budget lost — reconnect it in Settings → Integrations."
  - `notConnected`
  - `syncing` "Company data from AI Budget is still syncing."
  - `asOf` "Data as of {time}"
  - `readOnly` "This account is read-only in AI Budget; I can't change it."
  - `inactive`
  - `sharedOnlyCompany` "In a shared conversation only the company account is available."
  - `noCompany`
  - `unknownAccount`
  - `unknownCategory` "Category \"{name}\" not found. Available: {list}"
  - `noMatchingDocument` "No matching document found"
  - `nonSpending.debt` "money lent (not spending)"
  - `nonSpending.splitReceivable` "bill share owed back (not spending)"
  - `created`, `updated`, `deleted`
  - `totalsHeader`, `uncategorized`, `encryptedField` "—"
  - `wfirmaNeeded`
- Web keys (`aiBudget.*`):
  - `settings.*`: title, connect, reconnect, disconnect, disconnectConfirm, disconnectRemoteFailed, status.active, status.needs_reconnect, lastSync, never, readOnly, inactive, inactiveReason.role|encrypted|archived, labelAuto, labelManual, chooseCompany, chooseCompanyHelp, unavailable, connectedToast, error.invalid_state|access_denied|exchange_failed|unavailable;
  - `labels.company|other_business|private`;
  - `company.*`: title "AI Budget — company", thisMonth, lastMonth, byCategory, syncing, syncFailed, needsReconnect, noCompanyAccount, companyInactive, oneAccountNotRead, refresh;
  - `reconciliation.*`: title "Expenses without a document", subtitle "No matching document found in wFirma", count, total, dismiss "No document needed", wfirmaNeeded, wfirmaError, allMatched;
  - `invite.*`: title, body, cta;
  - `personal.*`: title "Private — outside the company's books", subtitle, thisMonth, trend, byCategory, noPrivateAccounts, incomplete, truncated, navLink "Private";
  - `share.privateDataWarning` "This conversation contains private AI Budget data. Organization members will see the earlier answers.", `share.confirm`.

- [ ] **Step 1: Write the web parity test**

```ts
test.each([['en', en], ['ru', ru]])('%s has every aiBudget key from pl', (_l, t) => {
  expect(collectKeys(t.aiBudget)).toEqual(collectKeys(pl.aiBudget));
});
```

- [ ] **Step 2: Run** `cd packages/web && npx jest src/i18n/__tests__/ai-budget-keys.test.ts`. Expected: FAIL (`aiBudget` undefined).
- [ ] **Step 3: Add the keys** to all six JSON files: Polish and Russian translations, English as above. Add the type and getter to `packages/api/src/i18n/index.ts`.
- [ ] **Step 4: Run** the web test and `cd packages/api && npx jest src/i18n`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai-budget): en/pl/ru strings`

---

### Task 12: Chat tool group and the expenses read/write service

**Files:**
- Create: `ai-budget-expenses.service.ts`, `ai-budget-chat.factory.ts`, `src/services/ai-chat/tools/ai-budget.tools.ts`, `src/services/ai-chat/formatters/ai-budget.formatter.ts`
- Modify: `src/services/ai-chat/formatters/index.ts`, `src/services/ai-chat/prompt-fragments.ts` (`aiBudgetRules`)
- Test: `__tests__/ai-budget-expenses.service.test.ts`, `src/services/ai-chat/__tests__/ai-budget.tools.test.ts`

**Interfaces:**
- Consumes: Tasks 3 to 8 and 11.
- Produces:
```ts
// ai-budget-expenses.service.ts
export interface ExpenseView { id: string; accountExternalId: string; accountName: string; label: AiBudgetLabel; date: string; amountCents: number;
  currency: string; categoryId: string | null; categorySplits: { categoryId: string | null; amountCents: number }[]; merchant: string | null;
  description: string | null; isDebt: boolean; isSplitReceivable: boolean }
export interface ExpenseQuery { accounts: AccountRow[]; dateFrom: string; dateTo: string; categoryId?: string; text?: string }
export class AiBudgetWriteRefused extends Error { constructor(readonly reason: 'read_only' | 'inactive' | 'unknown_account' | 'unknown_category') }
export class AiBudgetExpensesService {
  constructor(deps: { repo; accounts; sync; live; api })
  query(userId: string, q: ExpenseQuery): Promise<{ expenses: ExpenseView[]; truncated: boolean; companyAsOf: Date | null; companyPending: boolean }>
  create(userId: string, accountRowId: string, input: { amount: string; date: string; currency?: string; categoryName?: string; merchant?: string; description?: string }): Promise<ExpenseView>
  update(userId: string, accountRowId: string, expenseId: string, patch: { amount?: string; date?: string; currency?: string; categoryName?: string | null; merchant?: string | null; description?: string | null }): Promise<ExpenseView>
  remove(userId: string, accountRowId: string, expenseId: string): Promise<void>
}
// ai-budget.tools.ts
export const AI_BUDGET_TOOL_PREFIX = 'ai_budget_';
export function isAiBudgetTool(name: string): boolean
export type AiBudgetToolScope = 'all' | 'company_only';
export interface AiBudgetToolContext { userId: string; locale: Locale; scope: AiBudgetToolScope; connectionStatus: 'active' | 'needs_reconnect';
  expenses: AiBudgetExpensesService; accounts: AiBudgetAccountsService; reconciliation: AiBudgetReconciliationService;
  repo: AiBudgetRepository; onNonCompanyData: () => void }
export function createAiBudgetTools(ctx: AiBudgetToolContext): StructuredToolInterface[]
// names: ai_budget_list_accounts, ai_budget_get_expenses, ai_budget_spending_summary, ai_budget_create_expense,
//        ai_budget_update_expense, ai_budget_delete_expense, ai_budget_expenses_without_document
// ai-budget-chat.factory.ts
export interface AiBudgetChatBinding { tools: StructuredToolInterface[]; promptFragment: string; nonCompanyDataUsed(): boolean }
export class AiBudgetChatFactory {
  constructor(deps)
  forRun(userId: string, locale: Locale, opts: { isShared: boolean }): Promise<AiBudgetChatBinding | null>  // null: unavailable, no connection, or revoked
}
// prompt-fragments.ts
SHARED_FRAGMENTS.aiBudgetRules(scope: AiBudgetToolScope, status: 'active' | 'needs_reconnect'): string
```

Zod schemas: the `accountId` field is the **AI Budget account id** (`externalId`), and the tools resolve it to a row. The amount regex is `^\d{1,10}(\.\d{1,2})?$`; dates are `YYYY-MM-DD`.

| Tool | Input |
|---|---|
| `get_expenses` | `{ label?: enum; accountId?; dateFrom?; dateTo? (default: current Warsaw month); categoryId?; text?; includeNonSpending?: boolean; limit?: 1..50 (default 20) }` |
| `spending_summary` | `{ label?; accountId?; dateFrom; dateTo; groupBy: 'category' \| 'month' }` |
| `create_expense` | `{ accountId (required); amount; date; currency?; categoryName?; merchant?; description? }` |
| `update_expense` | `{ accountId; expenseId; …same fields optional, nullable where clearable }` |
| `delete_expense` | `{ accountId; expenseId }` |
| `expenses_without_document` | `{}` |

`aiBudgetRules` copy (fixed by spec decision 5 and 14). Prepend the shared-scope or reconnect line when it applies:
```
## AI Budget rules
- AI Budget accounts carry a label: company, other business or private. Always label every figure with it.
- Never add private or other-business expenses to company totals, and never use them in any wFirma action.
- Before any AI Budget write, state the amount, date and target account with its label, and get the user's confirmation.
- A write needs an explicit accountId. If the user says "for the company" and exactly one company account exists, propose it — still confirm.
- Read-only accounts cannot be changed; explain this instead of writing.
- Shared scope only: "This conversation is shared with the organization: only the company account is available; private and other-business accounts are not visible here."
- needs_reconnect only: "The AI Budget connection is lost; tell the user to reconnect in Settings → Integrations."
```

- [ ] **Step 1: Write the failing tests**

```ts
// ai-budget-expenses.service.test.ts
test('company reads come from the mirror after a bounded on-demand sync; others are read live', async () => { /* sync.syncIfStale awaited ≤ 8000 ms; live.listExpenses only for private row */ });
test('company write goes to AI Budget first, then updates the mirror from the response', async () => { /* repo.upsertMirrorExpense with response amount */ });
test('private write invalidates that account cache and writes nothing to the DB', async () => { /* live.invalidate('u1','p-row'); repo.upsertMirrorExpense not called */ });
test('read-only and inactive accounts are refused before any HTTP call', async () => { /* AiBudgetWriteRefused('read_only') */ });
test('categoryName resolves case-insensitively; unknown → unknown_category', async () => { /* … */ });
test('create sends a fresh UUID Idempotency-Key and retries a timeout once with the same key', async () => { /* … */ });
// ai-budget.tools.test.ts
test('company_only scope: list_accounts shows only the company account', async () => { expect(out).toContain('Firma A'); expect(out).not.toContain('Personal'); });
test('company_only scope: get_expenses for a private account id refuses and reads nothing', async () => { /* expenses.query not called */ });
test('company_only scope: create on a private account refuses', async () => { /* … */ });
test('get_expenses: totals are per label and per currency; no line sums company and private', async () => {
  // company PLN 100, private PLN 40 → output has 'Company … 100.00 PLN' and 'Private … 40.00 PLN' and no '140.00'
});
test('get_expenses excludes debts and split receivables from totals; includeNonSpending lists them labelled', async () => { /* … */ });
test('a write tool requires accountId (schema) and reports the target account and label in its result', async () => { /* … */ });
test('reading non-company data calls onNonCompanyData; company-only reads do not', async () => { /* … */ });
test('needs_reconnect: every tool returns the reconnect message', async () => { /* … */ });
test('expenses_without_document uses "No matching document found" wording', async () => { /* … */ });
test('encrypted (null) merchant renders as "—", never "null"', async () => { /* … */ });
test('factory returns null without a connection and company_only scope for shared conversations', async () => { /* … */ });
```

- [ ] **Step 2: Run** `cd packages/api && npx jest src/services/ai-budget/__tests__/ai-budget-expenses.service.test.ts src/services/ai-chat/__tests__/ai-budget.tools.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, following the `tool(fn, { name, description, schema })` pattern of `expense.tools.ts`.
  - Tool errors return localized markdown. They never throw into the graph.
  - Formatters render one section per label in the order company, other business, private. Each line is prefixed `**[<label>]**`.
  - The factory reads the connection and accounts once per run.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai-budget): chat tool group with label discipline and shared-chat scope`

---

### Task 13: Wiring into the agent run: scope, prompt, memory skip, trace redaction, private-data flag

**Files:**
- Modify:
  - `src/services/ai-chat/langgraph-agent-runner.ts`
  - `src/services/ai-chat/ai-chat.service.ts`
  - `src/services/ai-chat/constants.ts` (`getSystemPrompt(locale, memoryContext?, extraFragments?: string[])`)
  - `src/services/ai-chat/prompt-fragments.ts` (`buildSystemPrompt` option `extraFragments?: string[]`, appended before memory)
  - `src/services/ai-chat/conversation-repository.ts`
  - `src/services/ai-chat.instance.ts`
  - `src/services/ai-memory/memory-extraction.service.ts`
  - `src/types/ai-chat.types.ts` (`containsPrivateAiBudgetData?: boolean` on the conversation DTO)
  - `src/index.ts` (`installTraceRedaction()` at boot)
- Create: `src/services/ai-chat/trace-redaction.ts`
- Test: extend `src/services/ai-chat/__tests__/langgraph-agent-runner.test.ts`; create `src/services/ai-chat/__tests__/trace-redaction.test.ts` and `src/services/__tests__/memory-extraction.ai-budget.test.ts`

**Interfaces:**
- Consumes: `AiBudgetChatFactory.forRun`, `isAiBudgetTool` (Task 12).
- Produces:
```ts
// langgraph-agent-runner.ts
constructor(credentialsService, wfirmaFactory, cacheService, fileStorageService, memoryService?, aiBudgetFactory?: AiBudgetChatFactory | null)
run(existingMessages, userMessage, userId, conversationId, provider, options?: { isShared?: boolean }): Promise<AgentRunResult>
// AgentRunResult gains: aiBudgetNonCompanyDataUsed: boolean
// conversation-repository.ts
markContainsPrivateAiBudgetData(conversationId: string): Promise<void>
// getWithMessages / list items expose containsPrivateAiBudgetData
// trace-redaction.ts
export const REDACTED = '[redacted: AI Budget data]';
export function redactAiBudgetPayload<T>(value: T): T     // deep copy; any object whose name or kwargs.name starts with 'ai_budget_' gets content/kwargs.content = REDACTED
export function installTraceRedaction(): void               // when LANGCHAIN_TRACING_V2 === 'true': setDefaultLangChainClientSingleton(new Client({ hideInputs: redactAiBudgetPayload, hideOutputs: redactAiBudgetPayload }))
```

- [ ] **Step 1: Write the failing tests**

```ts
// langgraph-agent-runner.test.ts (additions)
test('binds AI Budget tools and appends the rules fragment when the factory returns a binding', async () => { /* tool names include ai_budget_get_expenses; system prompt contains '## AI Budget rules' */ });
test('passes isShared through as company_only scope', async () => { expect(factory.forRun).toHaveBeenCalledWith('u1', 'pl', { isShared: true }); });
test('no binding → no AI Budget tools and no fragment', async () => { /* … */ });
test('returns aiBudgetNonCompanyDataUsed from the binding', async () => { /* … */ });
// ai-chat.service: in the same file or the existing service test
test('sendMessage passes conversation.isShared and marks the conversation when non-company data was used', async () => { /* repo.markContainsPrivateAiBudgetData called once */ });
// memory-extraction.ai-budget.test.ts
test('AI Budget tool names are not tracked and preference extraction is skipped for that exchange', async () => {
  await svc.extractFromConversation('u1', 'c1', 'I prefer lunch at Bistro', 'resp', ['ai_budget_get_expenses', 'get_invoices'], 'en');
  expect(prisma.aIToolUsage.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ toolName: 'get_invoices' })] });
  expect(memoryService.upsertMemory).not.toHaveBeenCalled();
});
// trace-redaction.test.ts
test('redacts ToolMessages of ai_budget_* tools, serialized or plain', () => {
  const input = { messages: [[{ lc: 1, type: 'constructor', id: ['langchain_core','messages','ToolMessage'], kwargs: { content: 'Biedronka 42.50', name: 'ai_budget_get_expenses', tool_call_id: 't' } },
                               { role: 'tool', name: 'get_invoices', content: 'FV/1' }]] };
  const out = JSON.stringify(redactAiBudgetPayload(input));
  expect(out).not.toContain('Biedronka'); expect(out).toContain('FV/1');
});
test('does not mutate its input', () => { /* … */ });
```

- [ ] **Step 2: Run** `cd packages/api && npx jest src/services/ai-chat src/services/__tests__/memory-extraction.ai-budget.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `ai-chat.service.ts` passes `{ isShared: conversation.isShared }`. After the run it calls `repo.markContainsPrivateAiBudgetData` when `aiBudgetNonCompanyDataUsed`.
  - `ai-chat.instance.ts` passes the `aiBudgetChatFactory` from `ai-budget.instance.ts`, or `null`.
  - In `extractFromConversation`: if `toolsUsed.some(isAiBudgetTool)`, filter those names out of `trackToolUsage` and skip `extractExplicitPreferences` for that exchange.
  - Import `Client` from `langsmith` and `setDefaultLangChainClientSingleton` from `@langchain/core/singletons` (verified present in `@langchain/core` 0.3.80).
  - Telegram needs no change: `AIChatRouter` uses non-shared conversations, so every account is available.
- [ ] **Step 4: Run** the same command, then `npm run test --filter=@accounting-ai-agent/api`. Expected: PASS, with no regressions in existing suites.
- [ ] **Step 5: Commit** `feat(ai-budget): wire tools into the agent run with shared scope, memory skip and trace redaction`

---

### Task 14: Web — API client, hooks, `/settings/integrations`, menu links

**Files:**
- Create: `src/types/ai-budget.types.ts` (copy of `packages/api/src/types/ai-budget-api.types.ts`), `src/lib/api/ai-budget.ts`, `src/hooks/useAiBudget.ts`, `src/app/settings/integrations/page.tsx`, `src/components/ai-budget/{AiBudgetIntegrationCard,AccountLabelSelect,CompanyChoicePrompt,index}.tsx`
- Modify: `src/lib/api/endpoints.ts`, `src/components/layout/HeaderUserMenu.tsx` (mobile menu item "Integrations" under Profile), `src/components/profile/ProfileEditModal.tsx` (link `/settings/integrations` next to the API credentials button)
- Test: `src/components/ai-budget/__tests__/AiBudgetIntegrationCard.test.tsx`

**Interfaces:**
- Consumes: the routes of Tasks 6, 8 and 9; the web `aiBudget` keys (Task 11).
- Produces:
```ts
// endpoints.ts
AI_BUDGET: { STATUS: '/api/integrations/ai-budget/status', CONNECT: '/api/integrations/ai-budget/connect', DISCONNECT: '/api/integrations/ai-budget/disconnect',
  LABEL: (id: string) => `/api/integrations/ai-budget/accounts/${id}/label`, SYNC: '/api/integrations/ai-budget/sync',
  DISMISS: '/api/integrations/ai-budget/reconciliation/dismissals' },
DASHBOARD: { …, AI_BUDGET: '/api/dashboard/ai-budget', PERSONAL: '/api/dashboard/personal' }
// lib/api/ai-budget.ts
fetchAiBudgetStatus(): Promise<AiBudgetStatusDto>; startAiBudgetConnect(): Promise<{ authorizeUrl: string }>;
disconnectAiBudget(): Promise<{ revokedRemotely: boolean }>; setAiBudgetLabel(accountId: string, label: AiBudgetLabel): Promise<AiBudgetStatusDto>;
triggerAiBudgetSync(): Promise<{ started: boolean }>; fetchAiBudgetCompany(): Promise<AiBudgetCompanyDto>;
fetchAiBudgetPersonal(): Promise<AiBudgetPersonalDto>; dismissReconciliationItem(expenseId: string, reason?: string): Promise<void>
// hooks/useAiBudget.ts — React Query keys ['ai-budget-status'], ['ai-budget-company'], ['ai-budget-personal']
useAiBudgetStatus(); useAiBudgetCompany(); useAiBudgetPersonal();   // company/personal refetchInterval 10_000 while state is 'syncing' or sync.state 'syncing'
useAiBudgetMutations(): { connect; disconnect; setLabel; sync; dismiss }   // connect → window.location.assign(authorizeUrl); others invalidate the three keys
```

Card behaviour:
- With `available:false` it renders `settings.unavailable` and no button.
- With `connection === null` it shows the Connect button.
- When connected it shows the status pill, last sync, the Reconnect button, and one row per account. Each row has the name, currency, a read-only badge (`access === 'read'`), the inactive reason, `AccountLabelSelect` (three options plus an "automatic"/"manual" hint) and the Disconnect button with a confirm step.
- `needsCompanyChoice` shows `CompanyChoicePrompt` at the top, listing the business accounts.
- The query string `?ai_budget=connected|error&reason=` shows a toast or an inline message once.

- [ ] **Step 1: Write the failing tests** (Testing Library, hooks mocked):

```tsx
test('unavailable hides the connect button', () => { render(<AiBudgetIntegrationCard status={{ available: false, connection: null }} … />); expect(screen.queryByRole('button', { name: /connect/i })).toBeNull(); });
test('connected: rows show label, auto/manual hint and read-only badge', () => { /* … */ });
test('choosing company on another account calls setLabel(id, "company")', async () => { /* … */ });
test('needsCompanyChoice renders the choice prompt', () => { /* … */ });
test('needs_reconnect shows the reconnect banner and button', () => { /* … */ });
test('disconnect asks for confirmation before calling disconnect', async () => { /* … */ });
```

- [ ] **Step 2: Run** `cd packages/web && npx jest src/components/ai-budget/__tests__/AiBudgetIntegrationCard.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** The page uses `ProtectedRoute` + `AppHeader` like `app/settings/telegram/page.tsx`. Layout: a single column, `max-w-3xl`, rows stacked on a phone and in a row from `sm:` up.
- [ ] **Step 4: Run** the test and `npm run build --filter=@accounting-ai-agent/web`. Expected: PASS; next build ok.
- [ ] **Step 5: Commit** `feat(ai-budget): integrations settings page`

---

### Task 15: Web — dashboard company block and the private page

**Files:**
- Create: `src/components/ai-budget/{AiBudgetCompanySection,AiBudgetCategoryChart,ReconciliationCard,AiBudgetInviteCard,PersonalSummary,CurrencyLines}.tsx`, `src/app/dashboard/personal/page.tsx`
- Modify: `src/app/dashboard/page.tsx` (a full-width row after `SummaryCards`; a "Private" link in the header `actions`; the Refresh button also calls `sync` and refetches `ai-budget-company`), `src/components/chat/ChatContainer.tsx` (a "Private" link under the Dashboard link, shown only when `available`)
- Test: `src/components/ai-budget/__tests__/AiBudgetCompanySection.test.tsx`, `PersonalSummary.test.tsx`

**Interfaces:**
- Consumes: `useAiBudgetStatus`, `useAiBudgetCompany`, `useAiBudgetPersonal`, `useAiBudgetMutations` (Task 14); the DTOs from Task 9.
- Produces:
  - `<AiBudgetCompanySection data={AiBudgetCompanyDto} isLoading onDismiss t />`;
  - `<PersonalSummary data={AiBudgetPersonalDto} isLoading t />`;
  - `<AiBudgetInviteCard t />`;
  - `<CurrencyLines totals={CurrencyTotal[]} locale />`.

Rendering rules:

| State | Renders |
|---|---|
| `unavailable` | nothing |
| `not_connected` | `AiBudgetInviteCard` (on both pages) |
| `needs_reconnect` | reconnect message + link to settings, no figures |
| `syncing` / `sync_failed` | explicit message, no figures |
| `no_company_account` | text (+ choose link when `needsCompanyChoice`) |
| `company_inactive` | text |
| `ready` | spending (this month vs last month, one line per currency, via `CurrencyLines`), category bar chart (Recharts horizontal `BarChart`, one chart per currency), `ReconciliationCard`; a "figures as of" note when `sync.state === 'failed'`; "one account not read" when `inactiveAccounts > 0` |

`ReconciliationCard`:
- `wfirma_not_connected` explains that wFirma is needed;
- `wfirma_error` shows an error and never "all matched";
- `ok` with `unmatchedCount === 0` shows `allMatched`;
- otherwise it shows the count, a total per currency and up to 5 items (date, amount, merchant), each with a "No document needed" button.

The private page title is `aiBudget.personal.title`, with the subtitle stating these figures are outside the company's books. On a phone the trend chart sits above the categories; from `lg:` they are two columns.

- [ ] **Step 1: Write the failing tests**

```tsx
test('syncing shows the syncing message and no 0,00 figure', () => { render(<AiBudgetCompanySection data={{ state: 'syncing' }} … />); expect(screen.getByText(t.company.syncing)).toBeInTheDocument(); expect(screen.queryByText(/0[,.]00/)).toBeNull(); });
test('needs_reconnect shows reconnect, never figures', () => { /* … */ });
test('ready with PLN and EUR renders two currency lines', () => { /* … */ });
test('wfirma_error never says all matched', () => { /* … */ });
test('dismiss button calls onDismiss(expenseId)', async () => { /* … */ });
test('personal: no_private_accounts message; failedAccounts > 0 shows incomplete warning', () => { /* … */ });
```

- [ ] **Step 2: Run** `npx jest src/components/ai-budget/__tests__`. Expected: FAIL.
- [ ] **Step 3: Implement**, following the card styling of `UnpaidInvoicesCard` / `RevenueExpenseChart`.
- [ ] **Step 4: Run** the tests and the web build. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai-budget): dashboard company block and private page`

---

### Task 16: Web — share warning for conversations with private AI Budget data

**Files:**
- Modify: `src/hooks/useChat.ts` (carry `containsPrivateAiBudgetData` on the conversation), `src/components/chat/ChatContainer.tsx` (the `onShareToggle` branch), `src/components/chat/ChatHeader.tsx` (nothing beyond props if the dialog lives in the container)
- Create: `src/components/chat/SharePrivateDataDialog.tsx` (uses `components/ui/dialog`)
- Test: `src/components/chat/__tests__/SharePrivateDataDialog.test.tsx`

**Interfaces:**
- Consumes: `containsPrivateAiBudgetData` from the conversation API (Task 13); `aiBudget.share.*` keys.
- Produces: `<SharePrivateDataDialog open onConfirm onCancel t />`. Sharing a conversation with the flag set opens the dialog first and calls `shareConversation` only on confirm. Unsharing never opens it.

- [ ] **Step 1: Write the failing test**

```tsx
test('confirm calls onConfirm; cancel does not share', async () => { /* … */ });
test('dialog text is the private-data warning', () => { expect(screen.getByText(t.share.privateDataWarning)).toBeInTheDocument(); });
```

- [ ] **Step 2: Run** `npx jest src/components/chat/__tests__/SharePrivateDataDialog.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai-budget): warn before sharing a chat that used private AI Budget data`

---

### Task 17: Playwright spec for the settings page (API mocked)

**Files:**
- Create: `packages/web/tests/e2e/integrations/ai-budget-settings.spec.ts`
- Modify: `packages/web/package.json` (add `tests/e2e/integrations` to `test:e2e`)

**Interfaces:**
- Consumes: the `/settings/integrations` page (Task 14); `loginUser`, `dismissCookieBanner` from `tests/e2e/helpers/test-utils.ts`.
- Mocks `**/api/integrations/ai-budget/**` with `page.route`. A fresh status is served per test. The authorize URL is fulfilled with a stub page by `page.route('https://app.ai-budget.pl/**')`, so no live call is made.

- [ ] **Step 1: Write the spec.** It uses the `ensureAuthenticated` + `test.skip` pattern from `system/availability-banner.spec.ts`.

```ts
test('not connected: Connect posts /connect and navigates to the authorize URL', async ({ page }) => {
  await expect(page.getByRole('button', { name: en.aiBudget.settings.connect })).toBeVisible();
  await Promise.all([page.waitForURL(/app\.ai-budget\.pl\/authorize/), page.getByRole('button', { name: en.aiBudget.settings.connect }).click()]);
});
test('connected: lists accounts with label, automatic/manual hint and read-only badge', async ({ page }) => { /* … */ });
test('choosing a different company account sends PATCH {label:"company"}', async ({ page }) => {
  const req = page.waitForRequest(r => r.method() === 'PATCH' && /\/accounts\/acc-b2\/label$/.test(r.url()));
  /* select company on b2 */ expect((await req).postDataJSON()).toEqual({ label: 'company' });
});
test('several business accounts: the company choice prompt is shown', async ({ page }) => { /* … */ });
test('needs_reconnect: reconnect banner and button', async ({ page }) => { /* … */ });
test('disconnect requires confirmation and posts /disconnect', async ({ page }) => { /* … */ });
test('?ai_budget=error&reason=access_denied shows the error message', async ({ page }) => { /* … */ });
test('available:false shows the unavailable note and no Connect button', async ({ page }) => { /* … */ });
```

- [ ] **Step 2: Run** `cd packages/web && npx playwright test tests/e2e/integrations --project=chromium`. Expected: PASS, or every test skipped with "backend unavailable" when no API is running. Investigate any FAIL.
- [ ] **Step 3: Commit** `test(ai-budget): Playwright spec for the integrations settings page`

---

### Task 18: Docs, CLAUDE.md, env, user guide

**Files:**
- Create: `docs/AI_BUDGET_INTEGRATION.md`; `packages/web/src/app/guide/ai-budget/{layout,page}.tsx`; `packages/web/src/app/guide/ai-budget/connect/{layout,page}.tsx`
- Modify:
  - `CLAUDE.md`: a Key Services entry `AiBudget*`, the Environment list, the Key Patterns line "company/private never mix";
  - `docker-compose.prod.yml`: under the api `environment:` add `AI_BUDGET_CLIENT_ID: ${AI_BUDGET_CLIENT_ID:-}`, `AI_BUDGET_CLIENT_SECRET: ${AI_BUDGET_CLIENT_SECRET:-}`, `AI_BUDGET_API_URL: ${AI_BUDGET_API_URL:-https://api.ai-budget.pl}`, `AI_BUDGET_AUTHORIZE_URL: ${AI_BUDGET_AUTHORIZE_URL:-https://app.ai-budget.pl/authorize}`;
  - `packages/api/.env.example`;
  - `packages/web/src/app/guide/page.tsx` (topic `ai-budget`);
  - `packages/web/src/lib/seo.ts` (`/guide/ai-budget`, `/guide/ai-budget/connect`);
  - web locales: `guide.topics.aiBudget.*` in en/pl/ru.
- Test: `packages/web/src/app/sitemap.test.ts` (existing) and the web i18n parity test (Task 11)

**Content of `docs/AI_BUDGET_INTEGRATION.md`** (in the style of `WFIRMA_INTEGRATION.md`):
- overview and the never-mix rule;
- the three labels and the one-company rule;
- the OAuth flow and env; the redirect URI must be registered in AI Budget exactly;
- token refresh and the lock; never revoke except on disconnect;
- data storage: the mirror for company, live + encrypted 300 s Redis for the others, never logged, LangSmith redaction, memory skip;
- the sync (cursor, tombstones, weekly full resync with sweep, the 15-minute job, the 30-day retention);
- reconciliation rules and wording;
- dashboard states;
- chat tools and the shared-chat scope;
- known limitations: wFirma `total` is assumed to be the gross in the document currency, to be verified in the pilot; `findExpenses` is capped at 1000 documents; AI Budget does not emit a delete for an expense moved to another account between full resyncs;
- the rollout checklist from the spec.

The guide article covers connecting, choosing labels, the company choice, what "Private" means, reconciliation and dismissal, and disconnecting.

- [ ] **Step 1: Write the docs, the env lines and the guide pages.**
- [ ] **Step 2: Verify**

  Run: `cd packages/web && npx jest src/app/sitemap.test.ts src/i18n && cd ../.. && docker compose -f docker-compose.prod.yml config --quiet`.
  Expected: PASS; compose config exits 0.
- [ ] **Step 3: Full verification**

  Run: `npm run lint && npm run build && npm run test`.
  Expected: all green.
- [ ] **Step 4: Commit** `docs(ai-budget): feature doc, guide, CLAUDE.md and prod env`
