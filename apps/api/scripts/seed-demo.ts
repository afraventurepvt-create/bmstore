/**
 * Demo store for development and screenshots:
 *   npm run seed:demo                       # slug "demo" -> http://demo.localhost:3001, owner@demo.test / demo-password-123
 *   DEMO_SLUG=acme DEMO_PASSWORD=... npm run seed:demo
 *
 * Creates (or recreates) the tenant, its owner, 4 categories with 25 products from seed/demo-products.csv, generated
 * placeholder images pushed through the real media pipeline (presign -> storage -> complete -> WebP worker), a few
 * customers and orders in every status, two coupons and the policy pages. Needs object storage for the images
 * (docker compose up -d gives you MinIO); without it the products are seeded without photos.
 */
import 'dotenv/config';
import 'reflect-metadata';
import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { PagesService } from '../src/content/pages';
import { ProductImportService } from '../src/imports/product-import.service';
import { MediaWorker } from '../src/media/media-worker';
import { MediaService } from '../src/media/media.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ObjectStorageService } from '../src/storage/object-storage.service';
import { TenantResolver } from '../src/tenancy/tenant-resolver.service';

export interface SeedOptions { slug: string; name?: string; ownerEmail?: string; password?: string; withImages?: boolean; withOrders?: boolean; quiet?: boolean }
export interface SeedResult { tenantId: string; products: number; images: number; orders: number; customers: number; warnings: string[] }

const CATEGORY_COLOURS: Record<string, string> = { Sarees: '#7f1d1d', Kurtas: '#0f766e', Jewellery: '#b45309', 'Home Decor': '#3f6212' };

/** A 1200x1200 placeholder: category colour, product initials, product name. Real enough to see layouts with. */
export async function placeholderImage(name: string, category: string, i: number): Promise<Buffer> {
  const bg = CATEGORY_COLOURS[category] ?? '#374151';
  const initials = name.split(/[\s-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  const label = name.length > 26 ? name.slice(0, 25) + '…' : name;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200">
    <rect width="1200" height="1200" fill="${bg}"/>
    <circle cx="${300 + (i % 5) * 150}" cy="${250 + (i % 3) * 120}" r="420" fill="#ffffff" fill-opacity="0.08"/>
    <circle cx="${900 - (i % 4) * 100}" cy="${950 - (i % 2) * 200}" r="300" fill="#000000" fill-opacity="0.12"/>
    <text x="600" y="640" font-family="sans-serif" font-size="360" font-weight="700" fill="#ffffff" text-anchor="middle">${esc(initials)}</text>
    <text x="600" y="1080" font-family="sans-serif" font-size="56" fill="#ffffff" fill-opacity="0.9" text-anchor="middle">${esc(label)}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}

export async function seedDemo(app: INestApplicationContext, opts: SeedOptions): Promise<SeedResult> {
  const prisma = app.get(PrismaService);
  const auth = app.get(AuthService);
  const imports = app.get(ProductImportService);
  const media = app.get(MediaService);
  const worker = app.get(MediaWorker);
  const storage = app.get(ObjectStorageService);
  const pages = app.get(PagesService);
  const log = (m: string) => { if (!opts.quiet) console.log(m); };
  const warnings: string[] = [];
  const name = opts.name ?? 'Sri Lakshmi Silks';
  const ownerEmail = (opts.ownerEmail ?? `owner@${opts.slug}.test`).toLowerCase();
  const password = opts.password ?? 'demo-password-123';
  const withImages = (opts.withImages ?? true) && storage.configured;
  if ((opts.withImages ?? true) && !storage.configured) warnings.push('Object storage is not configured (S3_BUCKET): products seeded without photos');

  // 1. tenant (recreated from scratch so the demo is always the same)
  const old = await prisma.base.tenant.findUnique({ where: { slug: opts.slug } });
  if (old) {
    if (storage.configured) {
      const files = await prisma.base.media.findMany({ where: { tenantId: old.id } });
      await storage.delete(files.flatMap((m) => [m.originalKey, m.key, m.thumbKey]));
    }
    await prisma.base.tenant.delete({ where: { id: old.id } });
    log(`removed previous "${opts.slug}" store`);
  }
  const tenant = await prisma.base.tenant.create({
    data: { name, slug: opts.slug, subdomain: opts.slug, plan: 'STANDARD', status: 'LIVE', address: '12, Nethaji Road, Kanchipuram 631501', gstNumber: '33ABCDE1234F1Z5', supportPhone: '9876543210', whatsappNumber: '919876543210' },
  });
  // the Host -> tenant cache may still point at the previous store with this slug (5 min TTL): drop it
  await app.get(TenantResolver).invalidate({ subdomain: opts.slug }, old ?? {});
  const passwordHash = await auth.hashPassword(password);
  await prisma.base.user.create({ data: { tenantId: tenant.id, email: ownerEmail, passwordHash, role: 'store_owner' } });
  await prisma.base.user.create({ data: { tenantId: tenant.id, email: `staff@${opts.slug}.test`, passwordHash, role: 'staff' } });
  await prisma.base.settings.create({ data: { tenantId: tenant.id, shippingMode: 'FREE_ABOVE', flatRate: 7900, freeAbove: 199900, codEnabled: true, codCharge: 4900, orderPrefix: 'SLS', cityRates: [{ city: 'Chennai', ratePaise: 4900 }, { city: 'Kanchipuram', ratePaise: 0 }] } });
  await prisma.base.themeConfig.create({ data: { tenantId: tenant.id, paletteId: 'teal', primaryColor: '#0f766e', secondaryColor: '#c9731a' } });
  log(`store "${name}" (${opts.slug}) created, owner ${ownerEmail}`);

  const csv = readFileSync(join(__dirname, '..', 'seed', 'demo-products.csv'));
  const rows = csv.toString('utf8').split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(','));

  return prisma.runAsTenant(tenant.id, async () => {
    const db = prisma.db;
    // 2. placeholder images through the real pipeline
    let images = 0;
    if (withImages) {
      const files = await Promise.all(rows.map(async (r, i) => ({ filename: r[8], contentType: 'image/jpeg', size: 0, kind: 'product' as const, bytes: await placeholderImage(r[0], r[6], i) })));
      const pre = await media.presign({ files: files.map((f) => ({ filename: f.filename, contentType: f.contentType, size: f.bytes.length, kind: f.kind })) });
      const byId = new Map(pre.files.map((p, i) => [p.id, files[i]]));
      for (const p of pre.files) {
        const m = await db.media.findUniqueOrThrow({ where: { id: p.id } });
        await storage.put(m.originalKey, byId.get(p.id)!.bytes, 'image/jpeg'); // same bytes a browser would PUT to uploadUrl
      }
      const done = await media.complete({ ids: pre.files.map((p) => p.id) });
      const bad = done.results.filter((r) => r.status !== 'UPLOADED');
      if (bad.length) warnings.push(`${bad.length} image(s) could not be confirmed`);
      await worker.runOnce(25);
      images = await db.media.count({ where: { status: 'READY' } });
      const failed = await db.media.findMany({ where: { status: 'FAILED' } });
      for (const f of failed) warnings.push(`image ${f.filename}: ${f.error}`);
      log(`${images} placeholder images processed to WebP`);
    }

    // 3. products from the CSV (categories are created by the import)
    const report = await imports.run(csv, { filename: 'demo-products.csv', status: 'ACTIVE' });
    if (report.failed) warnings.push(`${report.failed} demo rows failed: ${report.errors.map((e) => `row ${e.row}: ${e.reason}`).join('; ')}`);
    log(`${report.imported} products imported into ${await db.category.count()} categories`);

    // 4. coupons, policy pages
    await db.coupon.createMany({ data: [
      { tenantId: tenant.id, code: 'WELCOME10', type: 'PERCENT', value: 10, minOrder: 99900 },
      { tenantId: tenant.id, code: 'FLAT200', type: 'FLAT', value: 20000, minOrder: 149900, usageLimit: 100, expiresAt: new Date(Date.now() + 60 * 86_400_000) },
    ] });
    await pages.ensurePolicyPages();
    await db.page.create({ data: { tenantId: tenant.id, slug: 'about-us', title: 'About us', content: '<p>Family-run silk and handloom store from Kanchipuram since 1987.</p>' } });

    // 5. customers and orders
    let orders = 0;
    let customers = 0;
    if (opts.withOrders ?? true) {
      const people = [['Priya Raman', '9840011111', 'Chennai', '600042'], ['Karthik Subramanian', '9790022222', 'Coimbatore', '641001'], ['Meena Lakshmi', '9444033333', 'Madurai', '625001'], ['Arun Prakash', '9600044444', 'Kanchipuram', '631501'], ['Divya Venkatesh', '9962055555', 'Chennai', '600017'], ['Senthil Kumar', '9003066666', 'Trichy', '620001']];
      const cust = [];
      for (const [n, phone, city, pincode] of people) {
        cust.push(await db.customer.create({ data: { tenantId: tenant.id, name: n, phone, email: `${n.split(' ')[0].toLowerCase()}@example.com`, addresses: [{ label: 'Home', line1: `${Math.floor(Math.random() * 90) + 1}, Gandhi Street`, city, state: 'Tamil Nadu', pincode }] } }));
      }
      customers = cust.length;
      const products = await db.product.findMany({ orderBy: { name: 'asc' } });
      const plan: Array<[string, string, string, number]> = [
        ['PENDING', 'COD', 'PENDING', 0], ['PENDING', 'ONLINE', 'PAID', 0], ['CONFIRMED', 'COD', 'PENDING', 0], ['CONFIRMED', 'ONLINE', 'PAID', 1],
        ['PACKED', 'ONLINE', 'PAID', 1], ['SHIPPED', 'COD', 'PENDING', 2], ['SHIPPED', 'ONLINE', 'PAID', 3], ['DELIVERED', 'COD', 'PENDING', 4],
        ['DELIVERED', 'ONLINE', 'PAID', 6], ['DELIVERED', 'COD', 'PAID', 9], ['CANCELLED', 'ONLINE', 'REFUNDED', 11], ['RETURNED', 'COD', 'PAID', 15],
      ];
      for (let i = 0; i < plan.length; i++) {
        const [orderStatus, paymentMode, paymentStatus, daysAgo] = plan[i];
        const c = cust[i % cust.length];
        const picks = [products[(i * 3) % products.length], products[(i * 7 + 1) % products.length]].slice(0, 1 + (i % 2));
        const items = picks.map((p, j) => ({ productId: p.id, variantId: null, name: p.name, sku: p.sku, qty: 1 + (j % 2), unitPrice: p.price, total: p.price * (1 + (j % 2)), image: p.images[0] ?? null }));
        const subtotal = items.reduce((n, it) => n + it.total, 0);
        const shipping = subtotal >= 199900 ? 0 : 7900;
        const addr = (c.addresses as any[])[0];
        await db.order.create({ data: {
          tenantId: tenant.id, orderNo: `SLS-${1041 + i}`, customerId: c.id, items, subtotal, shipping, tax: 0, total: subtotal + shipping + (paymentMode === 'COD' ? 4900 : 0),
          paymentMode: paymentMode as any, paymentStatus: paymentStatus as any, orderStatus: orderStatus as any, address: addr,
          createdAt: new Date(Date.now() - daysAgo * 86_400_000 - (i % 5) * 3_600_000),
        } });
        orders++;
      }
      log(`${customers} customers and ${orders} orders created`);
    }
    return { tenantId: tenant.id, products: report.imported, images, orders, customers, warnings };
  });
}

if (require.main === module) {
  (async () => {
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    try {
      const slug = process.env.DEMO_SLUG ?? 'demo';
      const r = await seedDemo(app, { slug, password: process.env.DEMO_PASSWORD, ownerEmail: process.env.DEMO_OWNER_EMAIL });
      console.log(`\nDemo store ready: http://${slug}.localhost:3001  (owner@${slug}.test / ${process.env.DEMO_PASSWORD ? 'your DEMO_PASSWORD' : 'demo-password-123'})`);
      console.log(`${r.products} products, ${r.images} images, ${r.customers} customers, ${r.orders} orders`);
      for (const w of r.warnings) console.warn('warning:', w);
    } finally {
      await app.close();
    }
  })().catch((e) => { console.error('seed failed:', e instanceof Error ? e.message : e); process.exit(1); });
}
