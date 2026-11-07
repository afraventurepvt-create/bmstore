-- STARTER cap counts only DRAFT and ACTIVE products: archiving frees a slot, so a store can swap products.
-- Checked on INSERT and when a product is un-archived (UPDATE OF status leaving ARCHIVED).
CREATE OR REPLACE FUNCTION enforce_plan_product_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t_plan "TenantPlan";
  n integer;
BEGIN
  IF NEW."status" = 'ARCHIVED' THEN
    RETURN NEW; -- archived products never count
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" <> 'ARCHIVED' THEN
    RETURN NEW; -- already counted
  END IF;
  SELECT "plan" INTO t_plan FROM "tenants" WHERE "id" = NEW."tenant_id" FOR UPDATE;
  IF t_plan = 'STARTER' THEN
    SELECT count(*) INTO n FROM "products"
      WHERE "tenant_id" = NEW."tenant_id" AND "status" <> 'ARCHIVED' AND "id" <> NEW."id";
    IF n >= 10 THEN
      RAISE EXCEPTION 'plan_limit_exceeded: the STARTER plan allows at most 10 live (DRAFT or ACTIVE) products';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS products_plan_limit ON "products";
CREATE TRIGGER products_plan_limit
  BEFORE INSERT OR UPDATE OF "status" ON "products"
  FOR EACH ROW EXECUTE FUNCTION enforce_plan_product_limit();
