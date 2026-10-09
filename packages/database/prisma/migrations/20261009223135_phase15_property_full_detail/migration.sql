-- AlterTable
ALTER TABLE "properties" ADD COLUMN     "detailFetchedAt" TIMESTAMP(3),
ADD COLUMN     "fullDetail" JSONB;
