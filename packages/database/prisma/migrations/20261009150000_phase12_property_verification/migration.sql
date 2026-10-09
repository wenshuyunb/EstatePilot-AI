-- CreateEnum
CREATE TYPE "PropertyVerificationStatus" AS ENUM ('VERIFIED', 'PENDING', 'EXPIRED');

-- AlterTable
ALTER TABLE "properties" ADD COLUMN     "dataReliabilityScore" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "lastVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "verificationStatus" "PropertyVerificationStatus" NOT NULL DEFAULT 'PENDING';

-- CreateIndex
CREATE INDEX "properties_organizationId_verificationStatus_dataReliabilit_idx" ON "properties"("organizationId", "verificationStatus", "dataReliabilityScore");

-- CreateIndex
CREATE INDEX "properties_lastVerifiedAt_idx" ON "properties"("lastVerifiedAt");
