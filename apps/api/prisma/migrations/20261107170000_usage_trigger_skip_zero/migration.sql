-- Usage counters: do not touch tenant_usage when nothing changed (e.g. a media row inserted with 0 stored bytes).
CREATE OR REPLACE FUNCTION products_usage_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM tenant_usage_bump(NEW."tenant_id", 1, 0);
  ELSIF TG_OP = 'DELETE' THEN PERFORM tenant_usage_bump(OLD."tenant_id", -1, 0);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION media_usage_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."bytes" <> 0 THEN PERFORM tenant_usage_bump(NEW."tenant_id", 0, NEW."bytes"); END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW."bytes" <> OLD."bytes" THEN PERFORM tenant_usage_bump(NEW."tenant_id", 0, NEW."bytes" - OLD."bytes"); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."bytes" <> 0 THEN PERFORM tenant_usage_bump(OLD."tenant_id", 0, -OLD."bytes"); END IF;
  END IF;
  RETURN NULL;
END;
$$;
