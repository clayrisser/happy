-- Guest accounts and per-session grants (DROVE-388).
-- Additive: every existing account stays an owner, and nothing reads
-- SessionGrant until an owner writes one.

-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('owner', 'guest');

-- CreateEnum
CREATE TYPE "SessionGrantRole" AS ENUM ('read', 'answer');

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "contentPublicKey" TEXT,
ADD COLUMN "kind" "AccountKind" NOT NULL DEFAULT 'owner';

-- CreateTable
CREATE TABLE "SessionGrant" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "granteeAccountId" TEXT NOT NULL,
    "wrappedKey" BYTEA NOT NULL,
    "role" "SessionGrantRole" NOT NULL,
    "grantedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_contentPublicKey_key" ON "Account"("contentPublicKey");

-- CreateIndex
CREATE INDEX "SessionGrant_granteeAccountId_idx" ON "SessionGrant"("granteeAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionGrant_sessionId_granteeAccountId_key" ON "SessionGrant"("sessionId", "granteeAccountId");

-- AddForeignKey
ALTER TABLE "SessionGrant" ADD CONSTRAINT "SessionGrant_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionGrant" ADD CONSTRAINT "SessionGrant_granteeAccountId_fkey" FOREIGN KEY ("granteeAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionGrant" ADD CONSTRAINT "SessionGrant_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
