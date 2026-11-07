-- =============================================================================
-- BMStore: application database role ("db:app-role").
--
-- The API connects as :app_user (default bmstore_app), a NON-owner role that can only read/write
-- rows. The owner role (POSTGRES_USER, default bmstore) owns every object and is the only role
-- that runs Prisma migrations. Run this after EVERY migration (deploy/deploy.sh does) — it is
-- idempotent. The ALTER DEFAULT PRIVILEGES lines make future tables/sequences created by the
-- owner readable/writable by the app role automatically; the explicit GRANTs cover what exists now.
--
-- Usage (psql variables):
--   psql -v app_user=bmstore_app -v app_password='…' -v owner=bmstore -v dbname=bmstore -f app-role.sql
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on

-- 1. Role exists, can log in, nothing else (no CREATEDB/CREATEROLE/SUPERUSER/BYPASSRLS).
SELECT format('CREATE ROLE %I LOGIN', :'app_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec

SELECT format('ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION LOGIN CONNECTION LIMIT 60', :'app_user') \gexec

-- 2. Password (rotated by re-running with a new -v app_password).
SELECT format('ALTER ROLE %I PASSWORD %L', :'app_user', :'app_password') \gexec

-- 3. Database / schema access.
SELECT format('GRANT CONNECT, TEMP ON DATABASE %I TO %I', :'dbname', :'app_user') \gexec
SELECT format('REVOKE CREATE ON SCHEMA public FROM %I', :'app_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_user') \gexec

-- 4. DML on everything that exists today (tables, sequences, functions).
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'app_user') \gexec
SELECT format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', :'app_user') \gexec
SELECT format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', :'app_user') \gexec

-- 5. The app never needs Prisma's bookkeeping table.
SELECT format('REVOKE ALL ON TABLE public._prisma_migrations FROM %I', :'app_user')
WHERE to_regclass('public._prisma_migrations') IS NOT NULL \gexec

-- 6. Objects the OWNER creates in future migrations get the same grants automatically.
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'owner', :'app_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', :'owner', :'app_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I', :'owner', :'app_user') \gexec

-- 7. Sanity output.
\set QUIET off
SELECT r.rolname AS role, r.rolsuper AS superuser, r.rolcreatedb AS createdb, r.rolcreaterole AS createrole,
       (SELECT count(*) FROM information_schema.role_table_grants g
         WHERE g.grantee = r.rolname AND g.table_schema = 'public' AND g.privilege_type = 'SELECT') AS tables_readable
FROM pg_roles r WHERE r.rolname = :'app_user';
