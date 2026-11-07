// Test defaults. CI / local shells can override any of these.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://bmstore_app:bmstore_app@localhost:5432/bmstore_test?schema=public'; // RLS-enforced app role
process.env.DATABASE_ADMIN_URL ??= 'postgresql://bmstore:bmstore@localhost:5432/bmstore_test?schema=public'; // owner: migrations + bypass
process.env.REDIS_URL ??= 'redis://localhost:6379/15';
process.env.ROOT_DOMAIN ??= 'localhost';
process.env.JWT_ACCESS_SECRET ??= 'test-jwt-secret-test-jwt-secret-test-jwt-secret';
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
// Suites log in many times from 127.0.0.1; the dedicated auth-protection suite sets tight limits itself.
process.env.LOGIN_IP_LIMIT ??= '1000';
process.env.FORGOT_PER_IP_LIMIT ??= '1000';
// Object storage: the in-process S3 double started by global-setup.ts (real MinIO/R2/S3 use the same client).
process.env.S3_ENDPOINT ??= `http://127.0.0.1:${process.env.FAKE_S3_PORT ?? 9100}`;
process.env.S3_FORCE_PATH_STYLE ??= '1';
process.env.S3_BUCKET ??= 'bmstore-test';
process.env.S3_REGION ??= 'ap-south-1';
process.env.S3_ACCESS_KEY_ID ??= 'test-access-key';
process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret-key';
process.env.MEDIA_WORKER ??= '0';
