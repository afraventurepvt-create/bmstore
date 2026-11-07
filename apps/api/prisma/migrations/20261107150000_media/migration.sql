-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('PENDING', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "media" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "original_key" TEXT NOT NULL,
    "key" TEXT,
    "thumb_key" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "declared_bytes" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "status" "MediaStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ready_at" TIMESTAMP(3),

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_tenant_id_status_idx" ON "media"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "media_tenant_id_filename_idx" ON "media"("tenant_id", "filename");

-- CreateIndex
CREATE INDEX "media_status_created_at_idx" ON "media"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "media_tenant_id_id_key" ON "media"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security like every tenant table.
ALTER TABLE "media" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "media" FOR ALL
  USING ("tenant_id" = app_tenant_id()) WITH CHECK ("tenant_id" = app_tenant_id());
