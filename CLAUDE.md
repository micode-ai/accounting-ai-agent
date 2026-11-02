# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Accounting AI Agent - full-stack monorepo for AI-powered accounting automation with Polish wFirma system integration. Features AI chat (Claude/GPT-4 via LangGraph), wFirma API integration with caching, OAuth authentication.

## Commands

```bash
# Development (starts both API and Web)
npm run dev

# Build all packages
npm run build

# Test all packages
npm run test

# Lint all packages
npm run lint

# Database
npm run prisma:generate    # Generate Prisma client
npm run prisma:migrate     # Run migrations
npm run prisma:studio      # Open Prisma GUI

# Docker
npm run docker:up          # Start PostgreSQL + Redis
npm run docker:down        # Stop services

# Single package commands
npm run dev --filter=@accounting-ai-agent/api
npm run test --filter=@accounting-ai-agent/web

# E2E tests (from packages/web)
npm run test:e2e
```

## Architecture

### Monorepo Structure (Turbo)
- `packages/api` - Express.js backend (TypeScript, Prisma, Redis)
- `packages/web` - Next.js 15 frontend (React 19, Tailwind, Zustand)

### Backend Layers (packages/api/src/)
```
routes/      → controllers/      → services/      → Prisma/Redis
             HTTP handlers        Business logic   Data access
```

### Key Services
- **WFirmaIntegrationService** - wFirma API calls with retry logic
- **WFirmaCacheService** - PostgreSQL caching layer (TTL-based)
- **AIChatService** - Thin orchestrator for AI chat; delegates to `LangGraphAgentRunner` (LangGraph single agent, 58 domain tools — up to 82 with HR + KSeF), `ConversationRepository` (Prisma CRUD + access control), and `TTSIntegration` (audio + cost tracking)
- **LangGraphAgentRunner** - Builds and runs the LangGraph `StateGraph` (agent → tools loop), model selection, tool binding
- **AIMemoryService** - Persistent cross-session AI context memory (CRUD + prompt injection)
- **AIMemoryExtractionService** - Fire-and-forget memory extraction from conversations (pattern-based, zero LLM cost)
- **AuthService** - JWT + OAuth (Google); HTTP layer split into AuthCore/OAuth/Token/Profile controllers
- **TTSService** - Text-to-speech via OpenAI TTS API
- **OrganizationService** - Company grouping with admin/member roles and membership approval
- **TelegramBotService** - Telegraf chatbot orchestrator; account linking via 6-digit codes. Delegates to sub-modules: `AIChatRouter` (text → AIChatService), `OcrFlowHandler` (photo → receipt OCR → expense), `TelegramRateLimiter` (Redis-backed per-user limits)
- **TaxDeadlineReminderService** - Hourly scheduler (started in `index.ts`) that proactively DMs linked Telegram users about upcoming Polish tax deadlines; deduped per day via Redis
- **ReferralService** - Referral program with Stripe credit rewards and coupon discounts
- **AiBudget\*** (`services/ai-budget/`) - AI Budget Assistant integration: OAuth+PKCE connection (`AiBudgetOAuthService`, `AiBudgetTokenManager` with refresh lock), account labels (`AiBudgetAccountsService`), company-only mirror sync (`AiBudgetSyncService` + 15-min job), live encrypted <=300 s reads for other accounts (`AiBudgetLiveService`), reconciliation against wFirma, chat tools (`AiBudgetChatFactory`). See `docs/AI_BUDGET_INTEGRATION.md`
- **TaxCalendarService** - Polish statutory tax deadlines (VAT, CIT, PIT, ZUS, PCC, dividends) with weekend/holiday shifting

### Frontend Structure (packages/web/src/)
- `app/` - Next.js App Router pages
- `components/` - React components (chat/, auth/, ui/)
- `contexts/` - React contexts (Auth, Locale, TTS)
- `hooks/` - Custom hooks (useChat, useAuth, useTextToSpeech, useVoiceDictation)
- `i18n/` - Translations (en, pl, ru)
- `lib/api/` - Axios API client

### Database
PostgreSQL with Prisma ORM. Key models: User, AIConversation, Organization, TelegramLink, WFirmaCache, WFirmaInvoice, WFirmaCustomer, AIMemory, AIToolUsage, Referral.

## Tech Stack

**Backend:** Node.js 18+, Express, TypeScript, Prisma, Redis, LangChain/LangGraph, Telegraf, Zod, Winston
**Frontend:** Next.js 15, React 19, Tailwind CSS, React Query, Zustand, next-intl
**Infrastructure:** Docker Compose, Turbo, GitHub Actions

## Environment

API requires `.env` with: DATABASE_URL, REDIS_URL, JWT_SECRET, WFIRMA_* credentials, TELEGRAM_CHATBOT_TOKEN (optional)
AI Budget integration (optional, feature hidden when incomplete): AI_BUDGET_CLIENT_ID, AI_BUDGET_CLIENT_SECRET, AI_BUDGET_API_URL, AI_BUDGET_AUTHORIZE_URL, plus BACKEND_URL (= https://api.eksiegowyai.pl in prod; the redirect URI is `${BACKEND_URL}/api/integrations/ai-budget/callback`), FRONTEND_URL and CREDENTIALS_ENCRYPTION_KEY; needs Redis >= 6.2 (GETDEL)
Web requires `.env.local` with: NEXT_PUBLIC_API_URL

## Key Patterns

- Singleton services via `*.instance.ts` files
- Zod validation on both frontend and backend
- wFirma responses cached in PostgreSQL with configurable TTL
- AI tools return localized markdown (auto-detect user language)
- Protected routes via AuthContext + JWT middleware
- Text-to-speech via Web Speech API or OpenAI TTS (TTSContext, useTextToSpeech hook)
- Voice input via Web Speech Recognition API (useVoiceDictation hook)
- OpenAI TTS: higher quality voices (Nova, Alloy, Echo, etc.) when user has OpenAI key
- AI Context Memory: persistent cross-session memory injected into system prompt (categories: business_fact, frequent_entity, user_preference, workflow_pattern)
- Memory extraction is fire-and-forget after each AI response (zero LLM cost — pattern-based only)
- Organizations: users grouped by company name, org-level roles (admin/member), membership approval flow
- Shared conversations: org members share AI chats, real-time polling (5s messages, 10s list)
- Telegram bot: AI chat via Telegraf, account linking via 6-digit Redis codes
- AI Budget: company/private never mix. Only the company account is stored (mirror); private/other-business data is live, encrypted in Redis for <=300 s, never logged or put in AI memory; resolve the company only via `getCompanyAccount`; never call `/oauth/revoke` except on user disconnect
- Referral program: unique 8-char codes, Stripe credit for referrer (max 10/year), 20% coupon for referred, 7-day revocation window

## Documentation

Detailed docs in `packages/api/docs/` (API.md, ARCHITECTURE.md, AUTH_API.md)
Feature docs: `docs/ORGANIZATIONS_AND_SHARING.md`, `docs/WFIRMA_INTEGRATION.md`, `docs/AI_BUDGET_INTEGRATION.md`, `docs/STRIPE_SETUP.md`, `docs/REFERRAL_PROGRAM.md`
Service docs: `packages/api/src/services/README.wfirma.md`, `README.cache.md`, `README.tts.md`

## Claude Code Subagents

Specialized subagent configurations for different development tasks are available in `.claude/agents/`:

| Agent | File | Purpose |
|-------|------|---------|
| **api-service** | `.claude/agents/api-service.md` | Backend development (Express, TypeScript, Prisma) |
| **frontend** | `.claude/agents/frontend.md` | Frontend development (Next.js 15, React 19, Tailwind) |
| **wfirma** | `.claude/agents/wfirma.md` | wFirma API integration specialist |
| **langgraph** | `.claude/agents/langgraph.md` | LangGraph/LangChain AI agent development |
| **test-runner** | `.claude/agents/test-runner.md` | Testing (Jest, Vitest, Playwright) |
| **prisma** | `.claude/agents/prisma.md` | Database operations (Prisma ORM, PostgreSQL) |
| **code-simplifier** | `.claude/agents/code-simplifier.md` | Code refactoring for clarity and maintainability |
| **security** | `.claude/agents/security.md` | Application security: auth, validation, secrets, OWASP, AI/tool safety, deps |

### Using Subagents

Reference the agent file when asking Claude Code for specialized help:

```
@.claude/agents/langgraph.md Create a new agent for expense tracking
@.claude/agents/wfirma.md Add invoice download functionality
@.claude/agents/prisma.md Add a new model for recurring transactions
```

Each agent contains domain-specific context, patterns, and examples to guide development in that area.

## Claude Code Agent Teams (Experimental)

Agent Teams spawn **independent Claude Code instances** that work in parallel with shared task lists and inter-agent messaging. Unlike subagents (which run within a single session), teammates have their own context windows and can communicate directly.

### Enabling

Enabled via `.claude/settings.json` (`env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`). Teams are created through natural language prompts.

### Teams vs Subagents

| | Subagents (`@.claude/agents/*.md`) | Agent Teams |
|---|---|---|
| **Context** | Shared with main session | Independent per teammate |
| **Communication** | Report back to caller only | Teammates message each other |
| **Best for** | Single-domain tasks | Multi-layer collaborative work |
| **Example** | `@prisma.md Add Employee table` | `Create team to add HR module` |

### Recommended Team Structures

#### 1. Full-Stack Feature (6 members)

**Use for**: New features spanning backend + frontend + AI tools + database.

```
Create an agent team with:
- Team Lead: coordinate architecture, review integration
- Backend Developer: services and routes in packages/api/src/
- Database Specialist: Prisma schema and migrations
- LangGraph AI Developer: AI tools and formatters in packages/api/src/services/ai-chat/
- Frontend Developer: React components and hooks in packages/web/src/
- Test Engineer: unit, integration, and E2E tests
```

**Example** (invoice approval workflow):
```
Create a full-stack feature team to add invoice approval workflow:
- Team Lead: design architecture, coordinate integration
- Backend: create ApprovalService in packages/api/src/services/, add routes
- Database: add approval_status, approver_id fields to Prisma schema, run migration
- LangGraph: create approval tools in packages/api/src/services/ai-chat/tools/approval.tools.ts,
  formatter in formatters/approval.formatter.ts (follow contractor.tools.ts pattern)
- Frontend: ApprovalButton component, useApproval hook in packages/web/src/
- Test: test service, API routes, and UI components
```

#### 2. wFirma Integration Module (7 members)

**Use for**: Adding new wFirma module (service + tools + formatters + routes + UI).

```
Create a wFirma integration team with:
- Team Lead: coordinate integration pattern
- wFirma API Specialist: service with retry logic and WFirmaCacheService integration
- LangGraph Tool Developer: AI tools with Zod schemas
- Formatter Developer: markdown formatters with pl/en/ru localization
- Backend Developer: routes and controllers with auth middleware
- Frontend Developer: React components and hooks
- Database Specialist: cache schema updates
```

**Example** (bank reconciliation):
```
Create a wFirma integration team to add bank statement reconciliation:
- Team Lead: coordinate, follow existing wFirma integration pattern
- wFirma Specialist: BankStatementService following packages/api/src/services/wfirma/invoice.service.ts
- LangGraph: tools in packages/api/src/services/ai-chat/tools/bank-statement.tools.ts
  (follow contractor.tools.ts pattern)
- Formatter: packages/api/src/services/ai-chat/formatters/bank-statement.formatter.ts
  (follow invoice.formatter.ts pattern)
- Backend: packages/api/src/routes/bank-statement.routes.ts (follow hr.routes.ts pattern)
- Frontend: BankReconciliation components in packages/web/src/components/
- Database: update Prisma schema, add cache type to WFirmaCache
```

#### 3. Bug Investigation (5 members)

**Use for**: Cross-layer debugging with competing hypotheses.

```
Create a bug investigation team with:
- Team Lead: coordinate debugging, analyze git history
- Backend Investigator: services, routes, API responses
- Frontend Investigator: React components, hooks, state management
- Database Investigator: data integrity, query performance, cache validity
- Test Engineer: reproduce bug, create failing test, verify fix
```

#### 4. Code Review (5 members)

**Use for**: Comprehensive PR review before merging.

```
Create a code review team with:
- Team Lead: review architecture and API design
- Code Simplifier: refactor for clarity (follow .claude/agents/code-simplifier.md patterns)
- Security Reviewer: auth, credentials, validation, Zod schemas
- Test Coverage Analyst: check test adequacy for all changed files
- Documentation Reviewer: CLAUDE.md, i18n files, service READMEs
```

### Tips

- Keep teams at 5-7 members; smaller teams coordinate faster
- Assign clear file ownership per teammate to avoid merge conflicts
- Reference existing files as patterns (e.g., "follow `contractor.tools.ts` pattern")
- Run `npm run test` and `npm run build` after team integration
- Use subagents for single-domain tasks, teams for multi-layer work
