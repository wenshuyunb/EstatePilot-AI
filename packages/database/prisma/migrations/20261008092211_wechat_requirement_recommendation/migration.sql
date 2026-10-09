-- CreateEnum
CREATE TYPE "MessageImportSource" AS ENUM ('WECHAT_MANUAL_PASTE', 'PHONE_NOTE', 'SMS', 'EMAIL', 'OTHER');

-- CreateEnum
CREATE TYPE "MessageImportType" AS ENUM ('CUSTOMER_MESSAGE', 'PROPERTY_FEEDBACK', 'AGENT_NOTE');

-- CreateEnum
CREATE TYPE "MessageParseStatus" AS ENUM ('PENDING', 'PARSING', 'SUCCESS', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "PropertyFeedbackSentiment" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "FeedbackReactionType" AS ENUM ('PRICE', 'LOCATION', 'LAYOUT', 'COMMUNITY', 'FLOOR', 'ORIENTATION', 'DECORATION', 'SCHOOL', 'SUBWAY', 'AGE', 'OTHER');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('GENERATED', 'COPIED', 'SENT_CONFIRMED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "ReplyStyle" AS ENUM ('NATURAL_PROFESSIONAL', 'CONCISE', 'DETAILED');

-- DropIndex
DROP INDEX "customer_behavior_profiles_embedding_hnsw_idx";

-- DropIndex
DROP INDEX "customers_name_trgm_idx";

-- DropIndex
DROP INDEX "properties_community_normalized_trgm_idx";

-- DropIndex
DROP INDEX "properties_embedding_hnsw_idx";

-- DropIndex
DROP INDEX "properties_title_trgm_idx";

-- CreateTable
CREATE TABLE "customer_message_imports" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "source" "MessageImportSource" NOT NULL DEFAULT 'WECHAT_MANUAL_PASTE',
    "sourceType" "MessageImportType" NOT NULL DEFAULT 'CUSTOMER_MESSAGE',
    "parseStatus" "MessageParseStatus" NOT NULL DEFAULT 'PENDING',
    "parsedRequirements" JSONB,
    "parseError" TEXT,
    "parseModel" TEXT,
    "parseDurationMs" INTEGER,
    "snapshotId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_message_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_requirement_profiles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "city" TEXT,
    "districts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subDistricts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "communities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "budgetTarget" INTEGER,
    "budgetNormalMax" INTEGER,
    "budgetStretchMax" INTEGER,
    "budgetStrictMax" BOOLEAN NOT NULL DEFAULT false,
    "budgetMin" INTEGER,
    "bedrooms" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "bedroomsStrict" BOOLEAN NOT NULL DEFAULT false,
    "livingRooms" INTEGER,
    "areaMin" INTEGER,
    "areaMax" INTEGER,
    "buildingAgePreference" TEXT,
    "avoidOldCommunity" BOOLEAN NOT NULL DEFAULT false,
    "communityQualityPriority" TEXT,
    "subwayPriority" TEXT,
    "schoolPriority" TEXT,
    "decorationPriority" TEXT,
    "floorPreference" TEXT,
    "orientationPreference" TEXT,
    "avoidFirstFloor" BOOLEAN NOT NULL DEFAULT false,
    "avoidTopFloor" BOOLEAN NOT NULL DEFAULT false,
    "requireElevator" BOOLEAN NOT NULL DEFAULT false,
    "decorationPreference" TEXT,
    "requireFineDecoration" BOOLEAN NOT NULL DEFAULT false,
    "schoolRequired" BOOLEAN NOT NULL DEFAULT false,
    "schoolNotNeeded" BOOLEAN NOT NULL DEFAULT false,
    "schoolNote" TEXT,
    "subwayDistanceMax" INTEGER,
    "commuteLocations" JSONB NOT NULL DEFAULT '[]',
    "carConvenience" BOOLEAN NOT NULL DEFAULT false,
    "purchasePurpose" TEXT,
    "paymentMethod" TEXT,
    "purchaseTimeline" TEXT,
    "decisionMakers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "familyConcerns" JSONB NOT NULL DEFAULT '[]',
    "otherRequirements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DECIMAL(4,3) NOT NULL DEFAULT 0,
    "sourceMessageCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageId" TEXT,
    "lastUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_requirement_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_requirement_snapshots" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "sourceMessageId" TEXT,
    "structuredRequirements" JSONB NOT NULL,
    "changedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "previousValues" JSONB,
    "newValues" JSONB,
    "confidence" DECIMAL(4,3) NOT NULL DEFAULT 0.8,
    "changeSummary" JSONB NOT NULL DEFAULT '[]',
    "hasOverride" BOOLEAN NOT NULL DEFAULT false,
    "needsConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_requirement_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_property_feedback" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "propertyId" TEXT,
    "sourceMessageId" TEXT,
    "mentionedIndex" INTEGER,
    "sentiment" "PropertyFeedbackSentiment" NOT NULL DEFAULT 'UNKNOWN',
    "interestLevel" INTEGER,
    "rawQuote" TEXT,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reactions" JSONB NOT NULL DEFAULT '[]',
    "priceReaction" TEXT,
    "locationReaction" TEXT,
    "layoutReaction" TEXT,
    "communityReaction" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_property_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_batches" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "sourceMessageId" TEXT,
    "requirementSnapshotId" TEXT,
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "hardFilteredCount" INTEGER NOT NULL DEFAULT 0,
    "recommendedPropertyIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scoreBreakdowns" JSONB NOT NULL DEFAULT '[]',
    "status" "RecommendationStatus" NOT NULL DEFAULT 'GENERATED',
    "searchQuery" JSONB,
    "beikeTotalRecalled" INTEGER,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recommendation_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generated_customer_replies" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "recommendationBatchId" TEXT,
    "content" TEXT NOT NULL,
    "style" "ReplyStyle" NOT NULL DEFAULT 'NATURAL_PROFESSIONAL',
    "propertyIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "copiedAt" TIMESTAMP(3),
    "sentConfirmedAt" TIMESTAMP(3),
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generated_customer_replies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_message_imports_organizationId_createdAt_idx" ON "customer_message_imports"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "customer_message_imports_customerId_createdAt_idx" ON "customer_message_imports"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "customer_message_imports_customerId_sourceType_idx" ON "customer_message_imports"("customerId", "sourceType");

-- CreateIndex
CREATE INDEX "customer_message_imports_parseStatus_idx" ON "customer_message_imports"("parseStatus");

-- CreateIndex
CREATE UNIQUE INDEX "customer_requirement_profiles_customerId_key" ON "customer_requirement_profiles"("customerId");

-- CreateIndex
CREATE INDEX "customer_requirement_profiles_organizationId_idx" ON "customer_requirement_profiles"("organizationId");

-- CreateIndex
CREATE INDEX "customer_requirement_profiles_budgetNormalMax_idx" ON "customer_requirement_profiles"("budgetNormalMax");

-- CreateIndex
CREATE INDEX "customer_requirement_profiles_city_districts_idx" ON "customer_requirement_profiles"("city", "districts");

-- CreateIndex
CREATE INDEX "customer_requirement_snapshots_organizationId_createdAt_idx" ON "customer_requirement_snapshots"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "customer_requirement_snapshots_customerId_createdAt_idx" ON "customer_requirement_snapshots"("customerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "customer_requirement_snapshots_customerId_version_key" ON "customer_requirement_snapshots"("customerId", "version");

-- CreateIndex
CREATE INDEX "customer_property_feedback_organizationId_createdAt_idx" ON "customer_property_feedback"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "customer_property_feedback_customerId_createdAt_idx" ON "customer_property_feedback"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "customer_property_feedback_propertyId_idx" ON "customer_property_feedback"("propertyId");

-- CreateIndex
CREATE INDEX "customer_property_feedback_sourceMessageId_idx" ON "customer_property_feedback"("sourceMessageId");

-- CreateIndex
CREATE INDEX "recommendation_batches_organizationId_createdAt_idx" ON "recommendation_batches"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "recommendation_batches_customerId_createdAt_idx" ON "recommendation_batches"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "recommendation_batches_agentId_createdAt_idx" ON "recommendation_batches"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "recommendation_batches_status_idx" ON "recommendation_batches"("status");

-- CreateIndex
CREATE INDEX "generated_customer_replies_organizationId_createdAt_idx" ON "generated_customer_replies"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "generated_customer_replies_customerId_createdAt_idx" ON "generated_customer_replies"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "generated_customer_replies_recommendationBatchId_idx" ON "generated_customer_replies"("recommendationBatchId");

-- AddForeignKey
ALTER TABLE "customer_message_imports" ADD CONSTRAINT "customer_message_imports_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_message_imports" ADD CONSTRAINT "customer_message_imports_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_requirement_profiles" ADD CONSTRAINT "customer_requirement_profiles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_requirement_profiles" ADD CONSTRAINT "customer_requirement_profiles_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_requirement_snapshots" ADD CONSTRAINT "customer_requirement_snapshots_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_requirement_snapshots" ADD CONSTRAINT "customer_requirement_snapshots_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_property_feedback" ADD CONSTRAINT "customer_property_feedback_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_property_feedback" ADD CONSTRAINT "customer_property_feedback_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_property_feedback" ADD CONSTRAINT "customer_property_feedback_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_batches" ADD CONSTRAINT "recommendation_batches_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_batches" ADD CONSTRAINT "recommendation_batches_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_customer_replies" ADD CONSTRAINT "generated_customer_replies_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_customer_replies" ADD CONSTRAINT "generated_customer_replies_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_customer_replies" ADD CONSTRAINT "generated_customer_replies_recommendationBatchId_fkey" FOREIGN KEY ("recommendationBatchId") REFERENCES "recommendation_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
