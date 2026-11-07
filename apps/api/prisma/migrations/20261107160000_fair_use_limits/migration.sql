-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "max_media_mb" INTEGER NOT NULL DEFAULT 10240,
ADD COLUMN     "max_products" INTEGER NOT NULL DEFAULT 2000;

-- CreateTable
CREATE TABLE "tenant_usage" (
    "tenant_id" UUID NOT NULL,
    "product_count" INTEGER NOT NULL DEFAULT 0,
    "media_bytes" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_usage_pkey" PRIMARY KEY ("tenant_id")
);

-- AddForeignKey
ALTER TABLE "tenant_usage" ADD CONSTRAINT "tenant_usage_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security like every tenant table.
ALTER TABLE "tenant_usage" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenant_usage" FOR ALL
  USING ("tenant_id" = app_tenant_id()) WITH CHECK ("tenant_id" = app_tenant_id());

-- ---------------------------------------------------------------- counters kept by triggers
-- Runs with the caller's privileges: under RLS the pinned tenant may only touch its own usage row, which is the one
-- these deltas are for. While a tenant is being deleted (cascade) the parent row is already gone, so no row is created.
CREATE OR REPLACE FUNCTION tenant_usage_bump(t_id uuid, d_products integer, d_bytes bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "tenant_usage" SET "product_count" = "product_count" + d_products, "media_bytes" = "media_bytes" + d_bytes, "updated_at" = now()
    WHERE "tenant_id" = t_id;
  IF NOT FOUND AND EXISTS (SELECT 1 FROM "tenants" WHERE "id" = t_id) THEN
    INSERT INTO "tenant_usage" ("tenant_id", "product_count", "media_bytes") VALUES (t_id, GREATEST(d_products, 0), GREATEST(d_bytes, 0))
      ON CONFLICT ("tenant_id") DO UPDATE SET "product_count" = "tenant_usage"."product_count" + d_products, "media_bytes" = "tenant_usage"."media_bytes" + d_bytes, "updated_at" = now();
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION products_usage_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM tenant_usage_bump(NEW."tenant_id", 1, 0);
  ELSIF TG_OP = 'DELETE' THEN PERFORM tenant_usage_bump(OLD."tenant_id", -1, 0);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER products_usage AFTER INSERT OR DELETE ON "products" FOR EACH ROW EXECUTE FUNCTION products_usage_trigger();

CREATE OR REPLACE FUNCTION media_usage_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM tenant_usage_bump(NEW."tenant_id", 0, NEW."bytes");
  ELSIF TG_OP = 'UPDATE' THEN IF NEW."bytes" <> OLD."bytes" THEN PERFORM tenant_usage_bump(NEW."tenant_id", 0, NEW."bytes" - OLD."bytes"); END IF;
  ELSIF TG_OP = 'DELETE' THEN PERFORM tenant_usage_bump(OLD."tenant_id", 0, -OLD."bytes");
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER media_usage AFTER INSERT OR UPDATE OF "bytes" OR DELETE ON "media" FOR EACH ROW EXECUTE FUNCTION media_usage_trigger();

-- Backfill for existing tenants.
INSERT INTO "tenant_usage" ("tenant_id", "product_count", "media_bytes")
SELECT t."id",
       (SELECT count(*) FROM "products" p WHERE p."tenant_id" = t."id"),
       (SELECT coalesce(sum(m."bytes"), 0) FROM "media" m WHERE m."tenant_id" = t."id")
FROM "tenants" t
ON CONFLICT ("tenant_id") DO UPDATE SET "product_count" = EXCLUDED."product_count", "media_bytes" = EXCLUDED."media_bytes", "updated_at" = now();
