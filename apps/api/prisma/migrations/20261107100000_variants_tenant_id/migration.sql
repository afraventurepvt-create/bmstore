-- variants get tenant_id like every other table. Backfilled from the owning product, then locked down with a
-- composite FK (tenant_id, product_id) -> products(tenant_id, id): a variant can never point at another tenant's product.

-- AlterTable (nullable first so existing rows can be backfilled)
ALTER TABLE "variants" ADD COLUMN "tenant_id" UUID;
UPDATE "variants" v SET "tenant_id" = p."tenant_id" FROM "products" p WHERE p."id" = v."product_id";
ALTER TABLE "variants" ALTER COLUMN "tenant_id" SET NOT NULL;

-- DropForeignKey (replaced by the composite one below)
ALTER TABLE "variants" DROP CONSTRAINT "variants_product_id_fkey";

-- DropIndex (replaced by the tenant-first unique index below)
DROP INDEX "variants_product_id_option_name_option_value_key";

-- CreateIndex
CREATE UNIQUE INDEX "products_tenant_id_id_key" ON "products"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "variants_tenant_id_product_id_idx" ON "variants"("tenant_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "variants_tenant_id_id_key" ON "variants"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "variants_tenant_id_product_id_option_name_option_value_key" ON "variants"("tenant_id", "product_id", "option_name", "option_value");

-- CreateIndex
CREATE UNIQUE INDEX "variants_tenant_id_sku_key" ON "variants"("tenant_id", "sku");

-- AddForeignKey
ALTER TABLE "variants" ADD CONSTRAINT "variants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variants" ADD CONSTRAINT "variants_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Row-level security: scope directly on the column now, like every other table.
DROP POLICY "tenant_isolation" ON "variants";
CREATE POLICY "tenant_isolation" ON "variants" FOR ALL
  USING ("tenant_id" = app_tenant_id()) WITH CHECK ("tenant_id" = app_tenant_id());
