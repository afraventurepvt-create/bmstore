-- Fixed vocabulary (Prisma enums, exact values) and money as integer paise. Hand-written: Prisma's generated casts
-- (old::text::new) would fail on existing rows because the values themselves change, so every column is mapped.

-- ---------------------------------------------------------------- tenants.plan: free text -> enum
CREATE TYPE "TenantPlan" AS ENUM ('STARTER', 'STANDARD');
ALTER TABLE "tenants" ALTER COLUMN "plan" DROP DEFAULT;
ALTER TABLE "tenants" ALTER COLUMN "plan" TYPE "TenantPlan"
  USING (CASE WHEN lower("plan") = 'starter' THEN 'STARTER' ELSE 'STANDARD' END)::"TenantPlan";
ALTER TABLE "tenants" ALTER COLUMN "plan" SET DEFAULT 'STARTER';

-- ---------------------------------------------------------------- tenants.status
ALTER TYPE "TenantStatus" RENAME TO "TenantStatus_old";
CREATE TYPE "TenantStatus" AS ENUM ('BUILDING', 'LIVE', 'SUSPENDED', 'PARKED');
ALTER TABLE "tenants" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "tenants" ALTER COLUMN "status" TYPE "TenantStatus"
  USING (CASE "status"::text WHEN 'active' THEN 'LIVE' WHEN 'suspended' THEN 'SUSPENDED' END)::"TenantStatus";
ALTER TABLE "tenants" ALTER COLUMN "status" SET DEFAULT 'BUILDING';
DROP TYPE "TenantStatus_old";

-- ---------------------------------------------------------------- products.status
ALTER TYPE "ProductStatus" RENAME TO "ProductStatus_old";
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
ALTER TABLE "products" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "products" ALTER COLUMN "status" TYPE "ProductStatus" USING (upper("status"::text))::"ProductStatus";
ALTER TABLE "products" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
DROP TYPE "ProductStatus_old";

-- ---------------------------------------------------------------- orders.payment_mode
ALTER TYPE "PaymentMode" RENAME TO "PaymentMode_old";
CREATE TYPE "PaymentMode" AS ENUM ('COD', 'ONLINE');
ALTER TABLE "orders" ALTER COLUMN "payment_mode" TYPE "PaymentMode" USING (upper("payment_mode"::text))::"PaymentMode";
DROP TYPE "PaymentMode_old";

-- ---------------------------------------------------------------- orders.payment_status
ALTER TYPE "PaymentStatus" RENAME TO "PaymentStatus_old";
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');
ALTER TABLE "orders" ALTER COLUMN "payment_status" DROP DEFAULT;
ALTER TABLE "orders" ALTER COLUMN "payment_status" TYPE "PaymentStatus" USING (upper("payment_status"::text))::"PaymentStatus";
ALTER TABLE "orders" ALTER COLUMN "payment_status" SET DEFAULT 'PENDING';
DROP TYPE "PaymentStatus_old";

-- ---------------------------------------------------------------- orders.order_status ('placed' becomes PENDING)
ALTER TYPE "OrderStatus" RENAME TO "OrderStatus_old";
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED');
ALTER TABLE "orders" ALTER COLUMN "order_status" DROP DEFAULT;
ALTER TABLE "orders" ALTER COLUMN "order_status" TYPE "OrderStatus"
  USING (CASE "order_status"::text WHEN 'placed' THEN 'PENDING' ELSE upper("order_status"::text) END)::"OrderStatus";
ALTER TABLE "orders" ALTER COLUMN "order_status" SET DEFAULT 'PENDING';
DROP TYPE "OrderStatus_old";

-- ---------------------------------------------------------------- coupons.type
ALTER TYPE "CouponType" RENAME TO "CouponType_old";
CREATE TYPE "CouponType" AS ENUM ('PERCENT', 'FLAT');
ALTER TABLE "coupons" ALTER COLUMN "type" TYPE "CouponType" USING (upper("type"::text))::"CouponType";
DROP TYPE "CouponType_old";

-- ---------------------------------------------------------------- settings.shipping_mode
ALTER TYPE "ShippingMode" RENAME TO "ShippingMode_old";
CREATE TYPE "ShippingMode" AS ENUM ('FLAT', 'FREE', 'FREE_ABOVE');
ALTER TABLE "settings" ALTER COLUMN "shipping_mode" DROP DEFAULT;
ALTER TABLE "settings" ALTER COLUMN "shipping_mode" TYPE "ShippingMode" USING (upper("shipping_mode"::text))::"ShippingMode";
ALTER TABLE "settings" ALTER COLUMN "shipping_mode" SET DEFAULT 'FLAT';
DROP TYPE "ShippingMode_old";

-- ---------------------------------------------------------------- money: DECIMAL(12,2) rupees -> INTEGER paise
ALTER TABLE "products"
  ALTER COLUMN "price" TYPE INTEGER USING round("price" * 100)::integer,
  ALTER COLUMN "mrp"   TYPE INTEGER USING round("mrp" * 100)::integer;
ALTER TABLE "variants"
  ALTER COLUMN "price_delta" DROP DEFAULT,
  ALTER COLUMN "price_delta" TYPE INTEGER USING round("price_delta" * 100)::integer,
  ALTER COLUMN "price_delta" SET DEFAULT 0;
ALTER TABLE "orders"
  ALTER COLUMN "subtotal" TYPE INTEGER USING round("subtotal" * 100)::integer,
  ALTER COLUMN "shipping" DROP DEFAULT,
  ALTER COLUMN "shipping" TYPE INTEGER USING round("shipping" * 100)::integer,
  ALTER COLUMN "shipping" SET DEFAULT 0,
  ALTER COLUMN "tax" DROP DEFAULT,
  ALTER COLUMN "tax" TYPE INTEGER USING round("tax" * 100)::integer,
  ALTER COLUMN "tax" SET DEFAULT 0,
  ALTER COLUMN "total" TYPE INTEGER USING round("total" * 100)::integer;
-- coupons.value: FLAT coupons are money (paise); PERCENT coupons keep their whole-number percent.
ALTER TABLE "coupons"
  ALTER COLUMN "value" TYPE INTEGER USING (CASE WHEN "type" = 'FLAT' THEN round("value" * 100) ELSE round("value") END)::integer,
  ALTER COLUMN "min_order" DROP DEFAULT,
  ALTER COLUMN "min_order" TYPE INTEGER USING round("min_order" * 100)::integer,
  ALTER COLUMN "min_order" SET DEFAULT 0;
ALTER TABLE "settings"
  ALTER COLUMN "flat_rate" DROP DEFAULT,
  ALTER COLUMN "flat_rate" TYPE INTEGER USING round("flat_rate" * 100)::integer,
  ALTER COLUMN "flat_rate" SET DEFAULT 0,
  ALTER COLUMN "free_above" TYPE INTEGER USING round("free_above" * 100)::integer,
  ALTER COLUMN "cod_charge" DROP DEFAULT,
  ALTER COLUMN "cod_charge" TYPE INTEGER USING round("cod_charge" * 100)::integer,
  ALTER COLUMN "cod_charge" SET DEFAULT 0;

-- Amounts are never negative (a variant's price delta may be).
ALTER TABLE "products" ADD CONSTRAINT "products_money_nonneg_chk" CHECK ("price" >= 0 AND "mrp" >= 0);
ALTER TABLE "orders"   ADD CONSTRAINT "orders_money_nonneg_chk"   CHECK ("subtotal" >= 0 AND "shipping" >= 0 AND "tax" >= 0 AND "total" >= 0);
ALTER TABLE "coupons"  ADD CONSTRAINT "coupons_value_chk"         CHECK ("value" >= 0 AND "min_order" >= 0 AND ("type" <> 'PERCENT' OR "value" <= 100));
ALTER TABLE "settings" ADD CONSTRAINT "settings_money_nonneg_chk" CHECK ("flat_rate" >= 0 AND "cod_charge" >= 0 AND ("free_above" IS NULL OR "free_above" >= 0));

-- ---------------------------------------------------------------- plan limits: STARTER = at most 10 products
-- Enforced in the database so no code path can forget it. The tenant row is locked FOR UPDATE so concurrent inserts
-- for the same tenant serialise and cannot both pass the count. Runs with the caller's privileges: under RLS the
-- pinned tenant sees its own row and products, the owner connection sees everything.
CREATE OR REPLACE FUNCTION enforce_plan_product_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t_plan "TenantPlan";
  n integer;
BEGIN
  SELECT "plan" INTO t_plan FROM "tenants" WHERE "id" = NEW."tenant_id" FOR UPDATE;
  IF t_plan = 'STARTER' THEN
    SELECT count(*) INTO n FROM "products" WHERE "tenant_id" = NEW."tenant_id";
    IF n >= 10 THEN
      RAISE EXCEPTION 'plan_limit_exceeded: the STARTER plan allows at most 10 products';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER products_plan_limit
  BEFORE INSERT ON "products"
  FOR EACH ROW EXECUTE FUNCTION enforce_plan_product_limit();
