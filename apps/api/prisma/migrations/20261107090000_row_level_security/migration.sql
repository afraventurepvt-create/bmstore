-- ROW-LEVEL SECURITY: the database enforces tenant isolation on its own, underneath the Prisma extension.
--
-- How it works
--   * The application connects as a role that does NOT own the tables and has NOBYPASSRLS (scripts/db-app-role.ts).
--     Row security applies to it on every table below. The owner role (migrations, the audited superadmin
--     bypass) is exempt, as Postgres defines for table owners.
--   * Before each query / transaction the app pins the tenant with
--       SELECT set_config('app.tenant_id', '<uuid>', true)      -- transaction-local, so pooled connections never leak it
--     and optionally set_config('app.platform', 'on', true) for the pre-login platform scope (tenant_id IS NULL rows).
--   * If nothing is pinned, app_tenant_id() is NULL, every comparison below is NULL and NO ROW is visible or writable.
--     Bypassing the app layer therefore yields an empty database, never another tenant's rows.
--   * WITH CHECK mirrors USING, so a row can neither be inserted into nor moved to a tenant other than the pinned one.
--   * Referential actions (composite FKs, ON DELETE CASCADE) are evaluated by Postgres with owner privileges and keep working.

CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_platform_scope() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(current_setting('app.platform', true), '') = 'on'
$$;

-- tenants: a tenant sees exactly its own row.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenants" FOR ALL
  USING ("id" = app_tenant_id()) WITH CHECK ("id" = app_tenant_id());

-- tables with a NOT NULL tenant_id
ALTER TABLE "theme_configs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "theme_configs" FOR ALL
  USING ("tenant_id" = app_tenant_id()) WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "settings" FOR ALL
  USING ("tenant_id" = app_tenant_id()) WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "categories" FOR ALL
  USING ("tenant_id" = app_tenant_id()) WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "products" FOR ALL
  USING ("tenant_id" = app_tenant_id()) WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "customers" FOR ALL
  USING ("tenant_id" = app_tenant_id()) WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "orders" FOR ALL
  USING ("tenant_id" = app_tenant_id()) WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "coupons" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "coupons" FOR ALL
  USING ("tenant_id" = app_tenant_id()) WITH CHECK ("tenant_id" = app_tenant_id());

ALTER TABLE "pages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "pages" FOR ALL
  USING ("tenant_id" = app_tenant_id()) WITH CHECK ("tenant_id" = app_tenant_id());

-- variants carry no tenant_id (yet): scoped through their product, whose own policy applies inside the subquery.
ALTER TABLE "variants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "variants" FOR ALL
  USING (EXISTS (SELECT 1 FROM "products" p WHERE p."id" = "variants"."product_id" AND p."tenant_id" = app_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "products" p WHERE p."id" = "variants"."product_id" AND p."tenant_id" = app_tenant_id()));

-- tables with a nullable tenant_id: NULL rows (superadmins, their tokens, platform audit) are reachable only in platform scope.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "users" FOR ALL
  USING ("tenant_id" = app_tenant_id() OR ("tenant_id" IS NULL AND app_platform_scope()))
  WITH CHECK ("tenant_id" = app_tenant_id() OR ("tenant_id" IS NULL AND app_platform_scope()));

ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "refresh_tokens" FOR ALL
  USING ("tenant_id" = app_tenant_id() OR ("tenant_id" IS NULL AND app_platform_scope()))
  WITH CHECK ("tenant_id" = app_tenant_id() OR ("tenant_id" IS NULL AND app_platform_scope()));

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "audit_logs" FOR ALL
  USING ("tenant_id" = app_tenant_id() OR ("tenant_id" IS NULL AND app_platform_scope()))
  WITH CHECK ("tenant_id" = app_tenant_id() OR ("tenant_id" IS NULL AND app_platform_scope()));
