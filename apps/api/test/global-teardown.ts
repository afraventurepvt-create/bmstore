export default async function globalTeardown() {
  await (globalThis as any).__FAKE_S3__?.close();
}
