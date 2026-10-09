-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'OWNER', 'STORE_MANAGER', 'AGENT', 'VIEWER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('FREE', 'PRO', 'STORE', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'EXPORT', 'IMPORT', 'VIEW_SENSITIVE', 'PERMISSION_CHANGE', 'CONFIG_CHANGE', 'REVOKE_CONSENT', 'DELETE_PERSONAL_DATA');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('NEW', 'FOLLOWING', 'HIGH_INTENT', 'VIEWING', 'NEGOTIATING', 'DEAL', 'LOST', 'DORMANT');

-- CreateEnum
CREATE TYPE "IntentLevel" AS ENUM ('A', 'B', 'C', 'D');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CustomerSource" AS ENUM ('PORTAL', 'ONLINE_PLATFORM', 'WALK_IN', 'REFERRAL', 'PHONE_IN', 'WECHAT', 'OLD_CUSTOMER', 'COMMUNITY_EVENT', 'ADVERTISEMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "PurchasePurpose" AS ENUM ('SELF_LIVE', 'IMPROVE', 'SCHOOL', 'INVESTMENT', 'MARRIAGE', 'ELDERLY_CARE', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('FULL', 'MORTGAGE', 'COMBINED', 'HOUSING_FUND', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('NOT_STARTED', 'PREPARING', 'SUBMITTED', 'APPROVED', 'REJECTED', 'NOT_NEEDED');

-- CreateEnum
CREATE TYPE "PurchaseTimeline" AS ENUM ('URGENT', 'ONE_MONTH', 'THREE_MONTHS', 'HALF_YEAR', 'ONE_YEAR', 'UNDECIDED');

-- CreateEnum
CREATE TYPE "FloorPreference" AS ENUM ('LOW', 'MIDDLE', 'HIGH', 'TOP', 'ANY');

-- CreateEnum
CREATE TYPE "DecorationPreference" AS ENUM ('ROUGH', 'SIMPLE', 'FINE', 'LUXURY', 'ANY');

-- CreateEnum
CREATE TYPE "PropertyAgePreference" AS ENUM ('WITHIN_5', 'WITHIN_10', 'WITHIN_20', 'ANY');

-- CreateEnum
CREATE TYPE "PropertyType" AS ENUM ('APARTMENT', 'VILLA', 'TOWNHOUSE', 'SHOP', 'OFFICE', 'OTHER');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('ACTIVE', 'PENDING', 'SOLD', 'DELISTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "OwnershipType" AS ENUM ('FREEHOLD', 'HOUSING_REFORM', 'AFFORDABLE', 'RELOCATION', 'COMMERCIAL', 'OTHER');

-- CreateEnum
CREATE TYPE "Decoration" AS ENUM ('ROUGH', 'SIMPLE', 'FINE', 'LUXURY');

-- CreateEnum
CREATE TYPE "Orientation" AS ENUM ('SOUTH', 'NORTH', 'EAST', 'WEST', 'SOUTHEAST', 'SOUTHWEST', 'NORTHEAST', 'NORTHWEST', 'SOUTH_NORTH');

-- CreateEnum
CREATE TYPE "PropertyProviderKind" AS ENUM ('MOCK', 'BEIKE', 'ANJUKE', 'INTERNAL');

-- CreateEnum
CREATE TYPE "ImageCategory" AS ENUM ('INTERIOR', 'EXTERIOR', 'FLOOR_PLAN', 'COMMUNITY', 'MAP', 'OTHER');

-- CreateEnum
CREATE TYPE "BehaviorEventType" AS ENUM ('PAGE_VIEW', 'PROPERTY_VIEW', 'PROPERTY_REVISIT', 'PROPERTY_SKIP', 'IMAGE_VIEW', 'IMAGE_GALLERY_COMPLETE', 'FLOOR_PLAN_VIEW', 'MAP_VIEW', 'COMMUNITY_VIEW', 'PRICE_HISTORY_VIEW', 'SCHOOL_VIEW', 'SUBWAY_VIEW', 'COMMUTE_VIEW', 'PROPERTY_FAVORITE', 'PROPERTY_UNFAVORITE', 'PROPERTY_COMPARE', 'PROPERTY_SHARE', 'CONTACT_AGENT', 'BOOK_VIEWING', 'SEARCH', 'FILTER_CHANGE');

-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('DESKTOP', 'MOBILE', 'TABLET', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ScoringConditionKind" AS ENUM ('ALWAYS', 'DURATION_OVER', 'DURATION_UNDER', 'REPEAT_OVER', 'SKIP_STREAK_OVER');

-- CreateEnum
CREATE TYPE "MatchLevel" AS ENUM ('PERFECT', 'HIGH', 'MEDIUM', 'LOW', 'WEAK');

-- CreateEnum
CREATE TYPE "MatchTrigger" AS ENUM ('CUSTOMER_UPDATED', 'BEHAVIOR_UPDATED', 'CUSTOMER_CREATED', 'PROPERTY_CREATED', 'PRICE_CHANGED', 'STATUS_CHANGED', 'MANUAL', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "OpportunityType" AS ENUM ('NEW_MATCH', 'PRICE_DROP', 'CUSTOMER_REVISIT', 'CUSTOMER_HIGH_ACTIVITY', 'CUSTOMER_DORMANT_REACTIVATED', 'PREFERENCE_CHANGED', 'LISTING_NEW', 'LISTING_RELIVE', 'VIEWING_FOLLOWUP', 'NEGOTIATION_FOLLOWUP', 'FOLLOWUP_OVERDUE');

-- CreateEnum
CREATE TYPE "OpportunityPriority" AS ENUM ('URGENT', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'ACTIONED', 'DISMISSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('PRICE_DROP', 'NEW_MATCH', 'CUSTOMER_ACTIVE', 'CUSTOMER_REVISIT', 'FOLLOWUP_DUE', 'VIEWING_REMINDER', 'PREFERENCE_CHANGE', 'HIGH_INTENT');

-- CreateEnum
CREATE TYPE "NotificationPriority" AS ENUM ('URGENT', 'HIGH', 'NORMAL', 'LOW');

-- CreateEnum
CREATE TYPE "ViewingStatus" AS ENUM ('PLANNED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "ViewingFeedbackLiked" AS ENUM ('LIKE', 'DISLIKE', 'NEUTRAL');

-- CreateEnum
CREATE TYPE "IntentTrend" AS ENUM ('WARMING', 'STABLE', 'COOLING');

-- CreateEnum
CREATE TYPE "CommunicationChannel" AS ENUM ('WECHAT', 'PHONE', 'SMS', 'FACE_TO_FACE', 'IN_APP', 'OTHER');

-- CreateEnum
CREATE TYPE "CommunicationDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "CommunicationSource" AS ENUM ('MANUAL', 'PASTED_TRANSCRIPT', 'VOICE_TRANSCRIBED', 'AI_GENERATED');

-- CreateEnum
CREATE TYPE "Sentiment" AS ENUM ('VERY_POSITIVE', 'POSITIVE', 'NEUTRAL', 'NEGATIVE', 'VERY_NEGATIVE');

-- CreateEnum
CREATE TYPE "CommunicationIntent" AS ENUM ('PRICE_INQUIRY', 'SCHEDULE_VIEWING', 'NEGOTIATION', 'LOAN_QUESTION', 'POLICY_QUESTION', 'OBJECTION', 'REQUEST_MORE_OPTIONS', 'REJECTION', 'HESITATION', 'SMALL_TALK', 'OTHER');

-- CreateEnum
CREATE TYPE "VoiceNoteStatus" AS ENUM ('UPLOADED', 'TRANSCRIBING', 'TRANSCRIBED', 'FAILED');

-- CreateEnum
CREATE TYPE "VoiceNoteAnalysisKind" AS ENUM ('VIEWING_FEEDBACK', 'COMMUNICATION');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('FOLLOW_UP', 'VIEWING_PREP', 'VIEWING_FOLLOWUP', 'NEGOTIATION', 'PAPERWORK', 'CALL', 'OTHER');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('URGENT', 'HIGH', 'NORMAL', 'LOW');

-- CreateEnum
CREATE TYPE "AiProviderKind" AS ENUM ('MOCK', 'DEEPSEEK', 'OPENAI', 'ANTHROPIC');

-- CreateEnum
CREATE TYPE "AiRunStatus" AS ENUM ('SUCCESS', 'FAILED', 'FALLBACK');

-- CreateEnum
CREATE TYPE "ChatRole" AS ENUM ('SYSTEM', 'USER', 'ASSISTANT', 'TOOL');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT,
    "unifiedSocialCreditCode" TEXT,
    "brandName" TEXT,
    "city" TEXT,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "logoUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stores" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "city" TEXT NOT NULL,
    "district" TEXT,
    "address" TEXT,
    "longitude" DECIMAL(10,7),
    "latitude" DECIMAL(10,7),
    "phone" TEXT,
    "managerId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "leaderId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "storeId" TEXT,
    "teamId" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'AGENT',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "employeeNo" TEXT,
    "specialties" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "monthlyDealTarget" INTEGER,
    "lastLoginAt" TIMESTAMP(3),
    "lastLoginIp" TEXT,
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3),
    "notifyByEmail" BOOLEAN NOT NULL DEFAULT false,
    "notifyBySms" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "userAgent" TEXT,
    "ipHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "plan" "PlanTier" NOT NULL DEFAULT 'FREE',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "seatLimit" INTEGER NOT NULL DEFAULT 3,
    "customerLimit" INTEGER NOT NULL DEFAULT 200,
    "aiUsageLimit" INTEGER NOT NULL DEFAULT 200,
    "storeLimit" INTEGER NOT NULL DEFAULT 1,
    "aiUsageThisPeriod" INTEGER NOT NULL DEFAULT 0,
    "periodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "periodEnd" TIMESTAMP(3),
    "priceCentsPerMonth" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "action" "AuditAction" NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "changedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ip" TEXT,
    "userAgent" TEXT,
    "traceId" TEXT,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "rolloutPercent" INTEGER NOT NULL DEFAULT 100,
    "organizationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "storeId" TEXT,
    "assignedAgentId" TEXT,
    "createdById" TEXT,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "wechat" TEXT,
    "gender" "Gender" NOT NULL DEFAULT 'UNKNOWN',
    "age" INTEGER,
    "familyStructure" TEXT,
    "source" "CustomerSource" NOT NULL DEFAULT 'OTHER',
    "sourceDetail" TEXT,
    "status" "CustomerStatus" NOT NULL DEFAULT 'NEW',
    "intentLevel" "IntentLevel",
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "budgetMin" INTEGER,
    "budgetMax" INTEGER,
    "preferredCity" TEXT NOT NULL DEFAULT '上海',
    "preferredDistricts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preferredCommunities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bedrooms" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "livingRooms" INTEGER,
    "areaMin" INTEGER,
    "areaMax" INTEGER,
    "propertyAgePreference" "PropertyAgePreference",
    "floorPreference" "FloorPreference",
    "decorationPreference" "DecorationPreference",
    "schoolPreference" TEXT,
    "subwayDistanceMax" INTEGER,
    "commuteLocations" JSONB NOT NULL DEFAULT '[]',
    "purchasePurpose" "PurchasePurpose",
    "paymentMethod" "PaymentMethod",
    "downPaymentBudget" INTEGER,
    "loanRequirement" TEXT,
    "loanStatus" "LoanStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "purchaseTimeline" "PurchaseTimeline",
    "notes" TEXT,
    "intentScore" INTEGER,
    "intentScoreLevel" TEXT,
    "intentScoreAt" TIMESTAMP(3),
    "profileConfidence" DECIMAL(4,3),
    "profileUpdatedAt" TIMESTAMP(3),
    "preferenceDriftScore" DECIMAL(4,3),
    "lastContactAt" TIMESTAMP(3),
    "nextFollowUpAt" TIMESTAMP(3),
    "viewingCount" INTEGER NOT NULL DEFAULT 0,
    "behaviorEventCount" INTEGER NOT NULL DEFAULT 0,
    "lastActiveAt" TIMESTAMP(3),
    "consentBehaviorTracking" BOOLEAN NOT NULL DEFAULT true,
    "consentPersonalization" BOOLEAN NOT NULL DEFAULT true,
    "consentGrantedAt" TIMESTAMP(3),
    "consentRevokedAt" TIMESTAMP(3),
    "consentPolicyVersion" TEXT,
    "dataDeletionRequestedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_profiles" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "rawRequirementText" TEXT,
    "explicit" JSONB NOT NULL DEFAULT '{}',
    "clarityScore" DECIMAL(4,3),
    "clarityNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_behavior_profiles" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "profile" JSONB NOT NULL DEFAULT '{}',
    "inferredBudgetMin" INTEGER,
    "inferredBudgetMax" INTEGER,
    "inferredAreaMin" INTEGER,
    "inferredAreaMax" INTEGER,
    "budgetConfidence" DECIMAL(4,3),
    "topDistricts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "topCommunities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DECIMAL(4,3) NOT NULL DEFAULT 0,
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "reasoningSummary" TEXT,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "driftResult" JSONB,
    "driftDetectedAt" TIMESTAMP(3),
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_behavior_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intent_score_history" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "level" TEXT NOT NULL,
    "factors" JSONB NOT NULL DEFAULT '[]',
    "trigger" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intent_score_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_share_links" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "createdById" TEXT,
    "token" TEXT NOT NULL,
    "shortCode" TEXT NOT NULL,
    "label" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "visitCount" INTEGER NOT NULL DEFAULT 0,
    "sessionCount" INTEGER NOT NULL DEFAULT 0,
    "firstVisitedAt" TIMESTAMP(3),
    "lastVisitedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_share_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_logs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "consentType" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "policyTextSnapshot" TEXT,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "properties" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "externalProvider" "PropertyProviderKind" NOT NULL DEFAULT 'MOCK',
    "externalId" TEXT NOT NULL,
    "rawData" JSONB,
    "city" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "subDistrict" TEXT,
    "community" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "address" TEXT,
    "longitude" DECIMAL(10,7),
    "latitude" DECIMAL(10,7),
    "totalPrice" BIGINT NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "bedrooms" INTEGER NOT NULL,
    "livingRooms" INTEGER NOT NULL DEFAULT 0,
    "bathrooms" INTEGER NOT NULL DEFAULT 0,
    "area" DECIMAL(8,2) NOT NULL,
    "floor" INTEGER,
    "totalFloors" INTEGER,
    "orientation" "Orientation",
    "buildYear" INTEGER,
    "propertyType" "PropertyType" NOT NULL DEFAULT 'APARTMENT',
    "ownershipType" "OwnershipType",
    "decoration" "Decoration",
    "elevator" BOOLEAN,
    "subwayDistance" INTEGER,
    "subwayInfo" JSONB,
    "schoolInfo" JSONB,
    "propertyManagementCompany" TEXT,
    "propertyFee" DECIMAL(6,2),
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "floorPlan" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "coverImage" TEXT,
    "description" TEXT,
    "listingStatus" "ListingStatus" NOT NULL DEFAULT 'ACTIVE',
    "listingDate" TIMESTAMP(3),
    "lastPriceChange" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "wasRelisted" BOOLEAN NOT NULL DEFAULT false,
    "delistedAt" TIMESTAMP(3),
    "communityNormalized" TEXT,
    "districtNormalized" TEXT,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "properties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_images" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "category" "ImageCategory" NOT NULL DEFAULT 'INTERIOR',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "caption" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_price_history" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "oldPrice" BIGINT NOT NULL,
    "newPrice" BIGINT NOT NULL,
    "change" BIGINT NOT NULL,
    "changePercent" DECIMAL(7,3) NOT NULL,
    "oldUnitPrice" INTEGER,
    "newUnitPrice" INTEGER,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_provider_records" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "propertyId" TEXT,
    "provider" "PropertyProviderKind" NOT NULL,
    "externalId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "changeType" TEXT,
    "syncBatchId" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_provider_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_provider_configs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "provider" "PropertyProviderKind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "usePlatformCredentials" BOOLEAN NOT NULL DEFAULT true,
    "appId" TEXT,
    "appKey" TEXT,
    "appSecretEncrypted" TEXT,
    "baseUrl" TEXT,
    "cityCode" TEXT,
    "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 60,
    "syncCron" TEXT DEFAULT '0 */6 * * *',
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "lastSyncCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "property_provider_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "behavior_scoring_rules" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "eventType" "BehaviorEventType" NOT NULL,
    "score" INTEGER NOT NULL,
    "conditionKind" "ScoringConditionKind" NOT NULL DEFAULT 'ALWAYS',
    "conditionValue" INTEGER,
    "maxPerPropertyPerDay" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "behavior_scoring_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_behavior_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "propertyId" TEXT,
    "sessionId" TEXT NOT NULL,
    "eventType" "BehaviorEventType" NOT NULL,
    "metadata" JSONB,
    "duration" INTEGER,
    "device" "DeviceType" NOT NULL DEFAULT 'UNKNOWN',
    "source" TEXT,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "score" INTEGER NOT NULL DEFAULT 0,
    "appliedRuleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_behavior_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "favorites" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "priceAtFavorite" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comparisons" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comparisons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_property_matches" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "assignedAgentId" TEXT,
    "score" INTEGER NOT NULL,
    "level" "MatchLevel" NOT NULL,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "highlights" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "concerns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "behaviorEvidence" JSONB NOT NULL DEFAULT '[]',
    "recommendation" TEXT,
    "stagesApplied" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "passedHardFilter" BOOLEAN NOT NULL DEFAULT true,
    "hardFilterFailures" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "priceAtMatch" BIGINT,
    "trigger" "MatchTrigger" NOT NULL DEFAULT 'SCHEDULED',
    "isViewed" BOOLEAN NOT NULL DEFAULT false,
    "viewedAt" TIMESTAMP(3),
    "isRecommended" BOOLEAN NOT NULL DEFAULT false,
    "recommendedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_property_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunities" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "storeId" TEXT,
    "customerId" TEXT,
    "propertyId" TEXT,
    "assignedAgentId" TEXT,
    "type" "OpportunityType" NOT NULL,
    "priority" "OpportunityPriority" NOT NULL,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "suggestion" TEXT NOT NULL,
    "valueScore" INTEGER NOT NULL DEFAULT 0,
    "expectedValue" BIGINT,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "matchScore" INTEGER,
    "suggestedContactBy" TIMESTAMP(3),
    "dedupeKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "handledAt" TIMESTAMP(3),
    "handledByUserId" TEXT,
    "handleNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "priority" "NotificationPriority" NOT NULL DEFAULT 'NORMAL',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "customerId" TEXT,
    "propertyId" TEXT,
    "opportunityId" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "viewings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "storeId" TEXT,
    "customerId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "status" "ViewingStatus" NOT NULL DEFAULT 'PLANNED',
    "notes" TEXT,
    "feedback" TEXT,
    "satisfaction" INTEGER,
    "analysis" JSONB,
    "analysisAt" TIMESTAMP(3),
    "analysisAiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "viewings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "viewing_properties" (
    "id" TEXT NOT NULL,
    "viewingId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "visitOrder" INTEGER NOT NULL DEFAULT 0,
    "liked" "ViewingFeedbackLiked" NOT NULL DEFAULT 'NEUTRAL',
    "pros" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customerPrice" BIGINT,
    "customerComment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "viewing_properties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communications" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "channel" "CommunicationChannel" NOT NULL,
    "direction" "CommunicationDirection" NOT NULL,
    "source" "CommunicationSource" NOT NULL DEFAULT 'MANUAL',
    "content" TEXT NOT NULL,
    "summary" TEXT,
    "sentiment" "Sentiment",
    "intent" "CommunicationIntent",
    "objections" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "budgetChange" BIGINT,
    "timelineHint" TEXT,
    "requirementChanges" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nextActions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "analysis" JSONB,
    "analysisAt" TIMESTAMP(3),
    "analysisAiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "appliedToProfile" BOOLEAN NOT NULL DEFAULT false,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_notes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "audioUrl" TEXT,
    "durationSeconds" INTEGER,
    "status" "VoiceNoteStatus" NOT NULL DEFAULT 'UPLOADED',
    "transcript" TEXT,
    "transcriptionProvider" TEXT,
    "transcriptionConfidence" DECIMAL(4,3),
    "viewingId" TEXT,
    "analysisKind" "VoiceNoteAnalysisKind",
    "analysis" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voice_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT,
    "propertyId" TEXT,
    "assignedAgentId" TEXT,
    "createdById" TEXT,
    "type" "TaskType" NOT NULL DEFAULT 'FOLLOW_UP',
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "opportunityId" TEXT,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '新对话',
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "ChatRole" NOT NULL,
    "content" TEXT NOT NULL,
    "toolInvocations" JSONB NOT NULL DEFAULT '[]',
    "citations" JSONB NOT NULL DEFAULT '[]',
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_runs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "promptKey" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "provider" "AiProviderKind" NOT NULL,
    "model" TEXT NOT NULL,
    "status" "AiRunStatus" NOT NULL DEFAULT 'SUCCESS',
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "entityType" TEXT,
    "entityId" TEXT,
    "inputSummary" TEXT,
    "outputSummary" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organizations_isActive_idx" ON "organizations"("isActive");

-- CreateIndex
CREATE INDEX "stores_organizationId_idx" ON "stores"("organizationId");

-- CreateIndex
CREATE INDEX "stores_organizationId_city_district_idx" ON "stores"("organizationId", "city", "district");

-- CreateIndex
CREATE UNIQUE INDEX "stores_organizationId_name_key" ON "stores"("organizationId", "name");

-- CreateIndex
CREATE INDEX "teams_organizationId_idx" ON "teams"("organizationId");

-- CreateIndex
CREATE INDEX "teams_storeId_idx" ON "teams"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "teams_storeId_name_key" ON "teams"("storeId", "name");

-- CreateIndex
CREATE INDEX "users_organizationId_role_idx" ON "users"("organizationId", "role");

-- CreateIndex
CREATE INDEX "users_organizationId_status_idx" ON "users"("organizationId", "status");

-- CreateIndex
CREATE INDEX "users_storeId_idx" ON "users"("storeId");

-- CreateIndex
CREATE INDEX "users_teamId_idx" ON "users"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "users_organizationId_email_key" ON "users"("organizationId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "users_organizationId_phone_key" ON "users"("organizationId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");

-- CreateIndex
CREATE INDEX "refresh_tokens_expiresAt_idx" ON "refresh_tokens"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_organizationId_key" ON "subscriptions"("organizationId");

-- CreateIndex
CREATE INDEX "subscriptions_status_idx" ON "subscriptions"("status");

-- CreateIndex
CREATE INDEX "subscriptions_plan_idx" ON "subscriptions"("plan");

-- CreateIndex
CREATE INDEX "audit_logs_organizationId_createdAt_idx" ON "audit_logs"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_organizationId_entity_entityId_idx" ON "audit_logs"("organizationId", "entity", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_organizationId_action_idx" ON "audit_logs"("organizationId", "action");

-- CreateIndex
CREATE INDEX "audit_logs_userId_createdAt_idx" ON "audit_logs"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flags_key_key" ON "feature_flags"("key");

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_key_key" ON "system_settings"("key");

-- CreateIndex
CREATE INDEX "customers_organizationId_status_idx" ON "customers"("organizationId", "status");

-- CreateIndex
CREATE INDEX "customers_organizationId_assignedAgentId_status_idx" ON "customers"("organizationId", "assignedAgentId", "status");

-- CreateIndex
CREATE INDEX "customers_organizationId_createdAt_idx" ON "customers"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "customers_organizationId_phone_idx" ON "customers"("organizationId", "phone");

-- CreateIndex
CREATE INDEX "customers_organizationId_intentLevel_idx" ON "customers"("organizationId", "intentLevel");

-- CreateIndex
CREATE INDEX "customers_organizationId_lastActiveAt_idx" ON "customers"("organizationId", "lastActiveAt");

-- CreateIndex
CREATE INDEX "customers_organizationId_nextFollowUpAt_idx" ON "customers"("organizationId", "nextFollowUpAt");

-- CreateIndex
CREATE INDEX "customers_storeId_idx" ON "customers"("storeId");

-- CreateIndex
CREATE INDEX "customers_assignedAgentId_idx" ON "customers"("assignedAgentId");

-- CreateIndex
CREATE INDEX "customers_deletedAt_idx" ON "customers"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "customer_profiles_customerId_key" ON "customer_profiles"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_behavior_profiles_customerId_key" ON "customer_behavior_profiles"("customerId");

-- CreateIndex
CREATE INDEX "customer_behavior_profiles_inferredBudgetMin_inferredBudget_idx" ON "customer_behavior_profiles"("inferredBudgetMin", "inferredBudgetMax");

-- CreateIndex
CREATE INDEX "customer_behavior_profiles_confidence_idx" ON "customer_behavior_profiles"("confidence");

-- CreateIndex
CREATE INDEX "intent_score_history_customerId_createdAt_idx" ON "intent_score_history"("customerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "customer_share_links_token_key" ON "customer_share_links"("token");

-- CreateIndex
CREATE UNIQUE INDEX "customer_share_links_shortCode_key" ON "customer_share_links"("shortCode");

-- CreateIndex
CREATE INDEX "customer_share_links_customerId_idx" ON "customer_share_links"("customerId");

-- CreateIndex
CREATE INDEX "customer_share_links_organizationId_idx" ON "customer_share_links"("organizationId");

-- CreateIndex
CREATE INDEX "customer_share_links_isActive_idx" ON "customer_share_links"("isActive");

-- CreateIndex
CREATE INDEX "customer_share_links_expiresAt_idx" ON "customer_share_links"("expiresAt");

-- CreateIndex
CREATE INDEX "consent_logs_customerId_createdAt_idx" ON "consent_logs"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "consent_logs_organizationId_idx" ON "consent_logs"("organizationId");

-- CreateIndex
CREATE INDEX "properties_organizationId_listingStatus_idx" ON "properties"("organizationId", "listingStatus");

-- CreateIndex
CREATE INDEX "properties_organizationId_city_district_idx" ON "properties"("organizationId", "city", "district");

-- CreateIndex
CREATE INDEX "properties_organizationId_community_idx" ON "properties"("organizationId", "community");

-- CreateIndex
CREATE INDEX "properties_organizationId_totalPrice_idx" ON "properties"("organizationId", "totalPrice");

-- CreateIndex
CREATE INDEX "properties_organizationId_area_idx" ON "properties"("organizationId", "area");

-- CreateIndex
CREATE INDEX "properties_organizationId_bedrooms_idx" ON "properties"("organizationId", "bedrooms");

-- CreateIndex
CREATE INDEX "properties_organizationId_buildYear_idx" ON "properties"("organizationId", "buildYear");

-- CreateIndex
CREATE INDEX "properties_organizationId_listingStatus_totalPrice_idx" ON "properties"("organizationId", "listingStatus", "totalPrice");

-- CreateIndex
CREATE INDEX "properties_organizationId_districtNormalized_listingStatus_idx" ON "properties"("organizationId", "districtNormalized", "listingStatus");

-- CreateIndex
CREATE INDEX "properties_organizationId_lastPriceChange_idx" ON "properties"("organizationId", "lastPriceChange");

-- CreateIndex
CREATE INDEX "properties_communityNormalized_idx" ON "properties"("communityNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "properties_organizationId_externalProvider_externalId_key" ON "properties"("organizationId", "externalProvider", "externalId");

-- CreateIndex
CREATE INDEX "property_images_propertyId_sortOrder_idx" ON "property_images"("propertyId", "sortOrder");

-- CreateIndex
CREATE INDEX "property_images_propertyId_category_idx" ON "property_images"("propertyId", "category");

-- CreateIndex
CREATE INDEX "property_price_history_propertyId_createdAt_idx" ON "property_price_history"("propertyId", "createdAt");

-- CreateIndex
CREATE INDEX "property_price_history_organizationId_createdAt_idx" ON "property_price_history"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "property_provider_records_provider_externalId_idx" ON "property_provider_records"("provider", "externalId");

-- CreateIndex
CREATE INDEX "property_provider_records_organizationId_createdAt_idx" ON "property_provider_records"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "property_provider_records_syncBatchId_idx" ON "property_provider_records"("syncBatchId");

-- CreateIndex
CREATE INDEX "property_provider_configs_provider_enabled_idx" ON "property_provider_configs"("provider", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "property_provider_configs_organizationId_provider_key" ON "property_provider_configs"("organizationId", "provider");

-- CreateIndex
CREATE INDEX "behavior_scoring_rules_organizationId_enabled_idx" ON "behavior_scoring_rules"("organizationId", "enabled");

-- CreateIndex
CREATE INDEX "behavior_scoring_rules_eventType_idx" ON "behavior_scoring_rules"("eventType");

-- CreateIndex
CREATE UNIQUE INDEX "behavior_scoring_rules_organizationId_name_key" ON "behavior_scoring_rules"("organizationId", "name");

-- CreateIndex
CREATE INDEX "customer_behavior_events_organizationId_createdAt_idx" ON "customer_behavior_events"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "customer_behavior_events_customerId_createdAt_idx" ON "customer_behavior_events"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "customer_behavior_events_customerId_eventType_idx" ON "customer_behavior_events"("customerId", "eventType");

-- CreateIndex
CREATE INDEX "customer_behavior_events_propertyId_createdAt_idx" ON "customer_behavior_events"("propertyId", "createdAt");

-- CreateIndex
CREATE INDEX "customer_behavior_events_sessionId_idx" ON "customer_behavior_events"("sessionId");

-- CreateIndex
CREATE INDEX "customer_behavior_events_customerId_propertyId_idx" ON "customer_behavior_events"("customerId", "propertyId");

-- CreateIndex
CREATE INDEX "favorites_organizationId_createdAt_idx" ON "favorites"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "favorites_propertyId_idx" ON "favorites"("propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "favorites_customerId_propertyId_key" ON "favorites"("customerId", "propertyId");

-- CreateIndex
CREATE INDEX "comparisons_customerId_groupId_idx" ON "comparisons"("customerId", "groupId");

-- CreateIndex
CREATE INDEX "comparisons_propertyId_idx" ON "comparisons"("propertyId");

-- CreateIndex
CREATE INDEX "comparisons_organizationId_idx" ON "comparisons"("organizationId");

-- CreateIndex
CREATE INDEX "customer_property_matches_organizationId_score_idx" ON "customer_property_matches"("organizationId", "score");

-- CreateIndex
CREATE INDEX "customer_property_matches_customerId_score_idx" ON "customer_property_matches"("customerId", "score");

-- CreateIndex
CREATE INDEX "customer_property_matches_propertyId_score_idx" ON "customer_property_matches"("propertyId", "score");

-- CreateIndex
CREATE INDEX "customer_property_matches_assignedAgentId_score_idx" ON "customer_property_matches"("assignedAgentId", "score");

-- CreateIndex
CREATE INDEX "customer_property_matches_organizationId_createdAt_idx" ON "customer_property_matches"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "customer_property_matches_customerId_propertyId_key" ON "customer_property_matches"("customerId", "propertyId");

-- CreateIndex
CREATE INDEX "opportunities_organizationId_status_valueScore_idx" ON "opportunities"("organizationId", "status", "valueScore");

-- CreateIndex
CREATE INDEX "opportunities_organizationId_priority_status_idx" ON "opportunities"("organizationId", "priority", "status");

-- CreateIndex
CREATE INDEX "opportunities_assignedAgentId_status_valueScore_idx" ON "opportunities"("assignedAgentId", "status", "valueScore");

-- CreateIndex
CREATE INDEX "opportunities_customerId_status_idx" ON "opportunities"("customerId", "status");

-- CreateIndex
CREATE INDEX "opportunities_propertyId_status_idx" ON "opportunities"("propertyId", "status");

-- CreateIndex
CREATE INDEX "opportunities_organizationId_type_createdAt_idx" ON "opportunities"("organizationId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "opportunities_expiresAt_idx" ON "opportunities"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "opportunities_organizationId_dedupeKey_key" ON "opportunities"("organizationId", "dedupeKey");

-- CreateIndex
CREATE INDEX "notifications_userId_isRead_createdAt_idx" ON "notifications"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_organizationId_createdAt_idx" ON "notifications"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_userId_priority_isRead_idx" ON "notifications"("userId", "priority", "isRead");

-- CreateIndex
CREATE INDEX "notifications_dedupeKey_idx" ON "notifications"("dedupeKey");

-- CreateIndex
CREATE INDEX "viewings_organizationId_scheduledAt_idx" ON "viewings"("organizationId", "scheduledAt");

-- CreateIndex
CREATE INDEX "viewings_customerId_scheduledAt_idx" ON "viewings"("customerId", "scheduledAt");

-- CreateIndex
CREATE INDEX "viewings_agentId_scheduledAt_idx" ON "viewings"("agentId", "scheduledAt");

-- CreateIndex
CREATE INDEX "viewings_organizationId_status_scheduledAt_idx" ON "viewings"("organizationId", "status", "scheduledAt");

-- CreateIndex
CREATE INDEX "viewings_storeId_scheduledAt_idx" ON "viewings"("storeId", "scheduledAt");

-- CreateIndex
CREATE INDEX "viewing_properties_propertyId_idx" ON "viewing_properties"("propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "viewing_properties_viewingId_propertyId_key" ON "viewing_properties"("viewingId", "propertyId");

-- CreateIndex
CREATE INDEX "communications_organizationId_occurredAt_idx" ON "communications"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "communications_customerId_occurredAt_idx" ON "communications"("customerId", "occurredAt");

-- CreateIndex
CREATE INDEX "communications_agentId_occurredAt_idx" ON "communications"("agentId", "occurredAt");

-- CreateIndex
CREATE INDEX "communications_customerId_channel_idx" ON "communications"("customerId", "channel");

-- CreateIndex
CREATE INDEX "voice_notes_customerId_createdAt_idx" ON "voice_notes"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "voice_notes_organizationId_createdAt_idx" ON "voice_notes"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "voice_notes_viewingId_idx" ON "voice_notes"("viewingId");

-- CreateIndex
CREATE INDEX "tasks_organizationId_status_dueAt_idx" ON "tasks"("organizationId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "tasks_assignedAgentId_status_dueAt_idx" ON "tasks"("assignedAgentId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "tasks_customerId_idx" ON "tasks"("customerId");

-- CreateIndex
CREATE INDEX "ai_conversations_organizationId_userId_updatedAt_idx" ON "ai_conversations"("organizationId", "userId", "updatedAt");

-- CreateIndex
CREATE INDEX "ai_messages_conversationId_createdAt_idx" ON "ai_messages"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_runs_organizationId_createdAt_idx" ON "ai_runs"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_runs_organizationId_promptKey_createdAt_idx" ON "ai_runs"("organizationId", "promptKey", "createdAt");

-- CreateIndex
CREATE INDEX "ai_runs_organizationId_status_idx" ON "ai_runs"("organizationId", "status");

-- CreateIndex
CREATE INDEX "ai_runs_entityType_entityId_idx" ON "ai_runs"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "stores" ADD CONSTRAINT "stores_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_behavior_profiles" ADD CONSTRAINT "customer_behavior_profiles_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intent_score_history" ADD CONSTRAINT "intent_score_history_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_share_links" ADD CONSTRAINT "customer_share_links_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_logs" ADD CONSTRAINT "consent_logs_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "properties" ADD CONSTRAINT "properties_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_images" ADD CONSTRAINT "property_images_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_price_history" ADD CONSTRAINT "property_price_history_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_provider_records" ADD CONSTRAINT "property_provider_records_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_provider_configs" ADD CONSTRAINT "property_provider_configs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "behavior_scoring_rules" ADD CONSTRAINT "behavior_scoring_rules_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_behavior_events" ADD CONSTRAINT "customer_behavior_events_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_behavior_events" ADD CONSTRAINT "customer_behavior_events_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparisons" ADD CONSTRAINT "comparisons_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comparisons" ADD CONSTRAINT "comparisons_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_property_matches" ADD CONSTRAINT "customer_property_matches_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_property_matches" ADD CONSTRAINT "customer_property_matches_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_handledByUserId_fkey" FOREIGN KEY ("handledByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "viewings" ADD CONSTRAINT "viewings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "viewings" ADD CONSTRAINT "viewings_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "viewings" ADD CONSTRAINT "viewings_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "viewings" ADD CONSTRAINT "viewings_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "viewing_properties" ADD CONSTRAINT "viewing_properties_viewingId_fkey" FOREIGN KEY ("viewingId") REFERENCES "viewings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "viewing_properties" ADD CONSTRAINT "viewing_properties_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communications" ADD CONSTRAINT "communications_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communications" ADD CONSTRAINT "communications_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_notes" ADD CONSTRAINT "voice_notes_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_notes" ADD CONSTRAINT "voice_notes_viewingId_fkey" FOREIGN KEY ("viewingId") REFERENCES "viewings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
