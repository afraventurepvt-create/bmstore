-- Hand-written integrity rules Prisma cannot express.

-- 1. Superadmin <=> tenant_id IS NULL. A tenant user can never be a superadmin and vice versa.
ALTER TABLE "users"
  ADD CONSTRAINT "users_role_tenant_chk"
  CHECK (("role" = 'superadmin' AND "tenant_id" IS NULL) OR ("role" <> 'superadmin' AND "tenant_id" IS NOT NULL));

-- 2. (tenant_id, email) unique ignores NULL tenant_id, so enforce uniqueness of superadmin emails separately.
CREATE UNIQUE INDEX "users_superadmin_email_key" ON "users" (lower("email")) WHERE "tenant_id" IS NULL;

-- 3. Emails are stored lower-case.
ALTER TABLE "users" ADD CONSTRAINT "users_email_lower_chk" CHECK ("email" = lower("email"));

-- 4. audit_logs is append-only: no UPDATE / DELETE, not even for the app's DB role.
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
