// Test defaults. CI / local shells can override any of these.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://bmstore:bmstore@localhost:5432/bmstore_test?schema=public';
process.env.REDIS_URL ??= 'redis://localhost:6379/15';
process.env.ROOT_DOMAIN ??= 'localhost';
process.env.JWT_ACCESS_SECRET ??= 'test-jwt-secret-test-jwt-secret-test-jwt-secret';
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
