-- AlterTable
ALTER TABLE "settings" ADD COLUMN "city_rates" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "low_stock_threshold" INTEGER NOT NULL DEFAULT 5;
