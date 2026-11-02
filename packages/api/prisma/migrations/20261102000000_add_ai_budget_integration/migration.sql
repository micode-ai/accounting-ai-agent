-- CreateEnum
CREATE TYPE "AiBudgetConnectionStatus" AS ENUM ('active', 'needs_reconnect', 'revoked');

-- CreateEnum
CREATE TYPE "AiBudgetLabel" AS ENUM ('company', 'other_business', 'private');

-- CreateEnum
CREATE TYPE "AiBudgetLabelSource" AS ENUM ('auto', 'manual');

-- AlterTable
ALTER TABLE "ai_conversations" ADD COLUMN     "containsPrivateAiBudgetData" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ai_budget_connections" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "accessTokenEnc" TEXT,
    "refreshTokenEnc" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "status" "AiBudgetConnectionStatus" NOT NULL DEFAULT 'active',
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "needsCompanyChoice" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_budget_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_budget_accounts" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "access" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "inactiveReason" TEXT,
    "label" "AiBudgetLabel" NOT NULL,
    "labelSource" "AiBudgetLabelSource" NOT NULL DEFAULT 'auto',
    "syncCursor" TEXT,
    "syncGeneration" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "fullResyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_budget_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_budget_expenses" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "date" DATE NOT NULL,
    "categoryId" TEXT,
    "categorySplits" JSONB NOT NULL DEFAULT '[]',
    "merchant" TEXT,
    "description" TEXT,
    "isDebt" BOOLEAN NOT NULL DEFAULT false,
    "isSplitReceivable" BOOLEAN NOT NULL DEFAULT false,
    "remoteUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncGeneration" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ai_budget_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_budget_reconciliation_dismissals" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "externalExpenseId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_budget_reconciliation_dismissals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_budget_connections_userId_key" ON "ai_budget_connections"("userId");

-- CreateIndex
CREATE INDEX "ai_budget_accounts_userId_idx" ON "ai_budget_accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_budget_accounts_connectionId_externalId_key" ON "ai_budget_accounts"("connectionId", "externalId");

-- CreateIndex
CREATE INDEX "ai_budget_expenses_accountId_date_idx" ON "ai_budget_expenses"("accountId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ai_budget_expenses_accountId_externalId_key" ON "ai_budget_expenses"("accountId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_budget_reconciliation_dismissals_accountId_externalExpen_key" ON "ai_budget_reconciliation_dismissals"("accountId", "externalExpenseId");

-- AddForeignKey
ALTER TABLE "ai_budget_connections" ADD CONSTRAINT "ai_budget_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_budget_accounts" ADD CONSTRAINT "ai_budget_accounts_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ai_budget_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_budget_expenses" ADD CONSTRAINT "ai_budget_expenses_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ai_budget_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_budget_reconciliation_dismissals" ADD CONSTRAINT "ai_budget_reconciliation_dismissals_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ai_budget_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one company account per connection (Prisma cannot model a partial unique index)
CREATE UNIQUE INDEX "ai_budget_accounts_one_company_per_connection"
  ON "ai_budget_accounts" ("connectionId") WHERE "label" = 'company';
