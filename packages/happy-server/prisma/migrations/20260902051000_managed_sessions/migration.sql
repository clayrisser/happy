-- Managed sessions (DROVE-388, decision 0c). Additive: every existing row is
-- a private session on an account whose new sessions are private, exactly as
-- before; escrowKey fills as the CLI creates managed sessions or an owner
-- turns one on, and a grant on a managed session may carry no key.

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "admin" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Account" ADD COLUMN "newSessionsManaged" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN "escrowKey" BYTEA;
ALTER TABLE "Session" ADD COLUMN "wasManagedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SessionGrant" ALTER COLUMN "wrappedKey" DROP NOT NULL;
