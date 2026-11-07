/** Store admin API: products/variants/categories, orders, customers, coupons, pages, settings, theme, profile. */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AuthService } from '../src/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createApp, deleteTenants, makeTenant, uniq } from './helpers';

describe('store admin API', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base: PrismaClient;
  let db: any;
  let A: any, B: any, owner: string, staff: string, ownerB: string;
  const PW = 'correct-horse-battery';
  const api = () => request(app.getHttpServer());
  const host = (t: any) => `${t.subdomain}.localhost`;
  const as = (tok: string, t: any = A) => ({
    get: (p: string) => api().get(p).set('Host', host(t)).set('Authorization', `Bearer ${tok}`),
    post: (p: string, b?: any) => api().post(p).set('Host', host(t)).set('Authorization', `Bearer ${tok}`).send(b),
    patch: (p: string, b?: any) => api().patch(p).set('Host', host(t)).set('Authorization', `Bearer ${tok}`).send(b),
    put: (p: string, b?: any) => api().put(p).set('Host', host(t)).set('Authorization', `Bearer ${tok}`).send(b),
    del: (p: string) => api().delete(p).set('Host', host(t)).set('Authorization', `Bearer ${tok}`),
  });
  const img = (t: any, name = 'a.webp') => `https://cdn.example.test/tenants/${t.id}/product/2026/11/${name}`;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    base = prisma.base;
    db = prisma.db;
    A = await makeTenant(base, { plan: 'STANDARD' });
    B = await makeTenant(base, { plan: 'STANDARD' });
    const auth = app.get(AuthService);
    const passwordHash = await auth.hashPassword(PW);
    const mk = async (t: any, role: any) => {
      const email = `${role}-${uniq()}@admin.test`;
      await prisma.runAsTenant(t.id, () => db.user.create({ data: { email, passwordHash, role } }));
      return (await api().post('/auth/login').set('Host', host(t)).send({ email, password: PW }).expect(200)).body.accessToken;
    };
    owner = await mk(A, 'store_owner');
    staff = await mk(A, 'staff');
    ownerB = await mk(B, 'store_owner');
  });
  afterAll(async () => {
    await deleteTenants(base, [A.id, B.id]);
    await app.close();
  });

  describe('products and variants', () => {
    let cat: any, p: any;
    it('creates with auto slug, variants, images from own media only; MRP >= price', async () => {
      cat = (await as(owner).post('/store/categories', { name: 'Sarees' }).expect(201)).body;
      expect(cat.slug).toBe('sarees');
      const r = await as(owner).post('/store/products', {
        name: 'Kanchipuram Silk Saree', price: 249900, mrp: 299900, stock: 5, status: 'ACTIVE', categoryId: cat.id, images: [img(A)], hsnCode: '5007',
        variants: [{ optionName: 'Colour', optionValue: 'Red', stock: 2 }, { optionName: 'Colour', optionValue: 'Green', priceDelta: 5000, stock: 3 }],
      }).expect(201);
      p = r.body;
      expect(p).toMatchObject({ slug: 'kanchipuram-silk-saree', tenantId: A.id, price: 249900, category: { slug: 'sarees' } });
      expect(p.variants).toHaveLength(2);
      // same name -> slug-2
      const dup = await as(owner).post('/store/products', { name: 'Kanchipuram Silk Saree', price: 1, mrp: 1 }).expect(201);
      expect(dup.body.slug).toBe('kanchipuram-silk-saree-2');
      // Tamil name -> random fallback slug
      const ta = await as(owner).post('/store/products', { name: 'பட்டுப் புடவை', price: 1, mrp: 1 }).expect(201);
      expect(ta.body.slug).toMatch(/^product-[0-9a-f]{6}$/);
      await as(owner).post('/store/products', { name: 'x', price: 200, mrp: 100 }).expect(400);
      await as(owner).post('/store/products', { name: 'x', price: 19.99, mrp: 20 }).expect(400); // paise are integers
      await as(owner).post('/store/products', { name: 'x', price: 1, mrp: 1, images: [img(B)] }).expect(400); // other store's media
      await as(owner).post('/store/products', { name: 'x', price: 1, mrp: 1, images: ['not a url'] }).expect(400);
      await as(owner).post('/store/products', { name: 'x', price: 1, mrp: 1, sku: p.sku ?? 'X', slug: 'kanchipuram-silk-saree' }).expect(201); // slug de-duplicated, sku null ok
      await as(owner).post('/store/products', { name: 'x', price: 1, mrp: 1, sku: 'SKU-1' }).expect(201);
      expect((await as(owner).post('/store/products', { name: 'y', price: 1, mrp: 1, sku: 'SKU-1' }).expect(409)).body.message).toMatch(/SKU is already in use/);
    });

    it('lists with filters, search and pagination; staff can read and write', async () => {
      const l = await as(staff).get('/store/products?q=kanchipuram&status=ACTIVE').expect(200);
      expect(l.body.total).toBe(1);
      expect(l.body.items[0].id).toBe(p.id);
      expect((await as(staff).get(`/store/products?categoryId=${cat.id}`).expect(200)).body.total).toBe(1);
      expect((await as(staff).get('/store/products?pageSize=2&page=1').expect(200)).body.items).toHaveLength(2);
      await as(staff).get('/store/products?pageSize=1000').expect(400);
      await as(staff).get('/store/products?status=live').expect(400);
    });

    it('updates, stock by value or delta, low-stock filter, bulk actions, delete', async () => {
      const u = await as(owner).patch(`/store/products/${p.id}`, { price: 199900, description: 'Pure silk' }).expect(200);
      expect(u.body.price).toBe(199900);
      await as(owner).patch(`/store/products/${p.id}`, { mrp: 100 }).expect(400); // below price
      expect((await as(owner).patch(`/store/products/${p.id}/stock`, { delta: -3 }).expect(200)).body.stock).toBe(2);
      await as(owner).patch(`/store/products/${p.id}/stock`, { delta: -5 }).expect(400);
      expect((await as(owner).patch(`/store/products/${p.id}/stock`, { stock: 1 }).expect(200)).body.stock).toBe(1);
      await as(owner).patch(`/store/products/${p.id}/stock`, {}).expect(400);
      const low = await as(owner).get('/store/products?lowStock=true').expect(200);
      expect(low.body.items.map((x: any) => x.id)).toContain(p.id);
      // variants
      const v = (await as(owner).post(`/store/products/${p.id}/variants`, { optionName: 'Colour', optionValue: 'Blue', stock: 4 }).expect(201)).body;
      await as(owner).post(`/store/products/${p.id}/variants`, { optionName: 'Colour', optionValue: 'Blue' }).expect(409);
      expect((await as(owner).patch(`/store/products/${p.id}/variants/${v.id}/stock`, { delta: -1 }).expect(200)).body.stock).toBe(3);
      expect((await as(owner).patch(`/store/products/${p.id}/variants/${v.id}`, { priceDelta: -1000 }).expect(200)).body.priceDelta).toBe(-1000);
      await as(owner).del(`/store/products/${p.id}/variants/${v.id}`).expect(204);
      await as(owner).del(`/store/products/${p.id}/variants/${v.id}`).expect(404);
      // bulk
      const ids = (await as(owner).get('/store/products?pageSize=100').expect(200)).body.items.map((x: any) => x.id);
      expect((await as(owner).post('/store/products/bulk', { ids, action: 'ARCHIVE' }).expect(200)).body.affected).toBe(ids.length);
      expect((await as(owner).get('/store/products?status=ARCHIVED').expect(200)).body.total).toBe(ids.length);
      expect((await as(owner).post('/store/products/bulk', { ids: [p.id], action: 'ACTIVATE' }).expect(200)).body.affected).toBe(1);
      await as(owner).post('/store/products/bulk', { ids: ['nope'], action: 'ACTIVATE' }).expect(400);
      const victim = ids.find((i: string) => i !== p.id);
      await as(owner).del(`/store/products/${victim}`).expect(204);
      await as(owner).get(`/store/products/${victim}`).expect(404);
    });

    it('STARTER plan: friendly 403 before the database trigger', async () => {
      const S = await makeTenant(base, { plan: 'STARTER' });
      try {
        const auth = app.get(AuthService);
        const email = `o-${uniq()}@admin.test`;
        await prisma.runAsTenant(S.id, async () => db.user.create({ data: { email, passwordHash: await auth.hashPassword(PW), role: 'store_owner' } }));
        const tok = (await api().post('/auth/login').set('Host', host(S)).send({ email, password: PW }).expect(200)).body.accessToken;
        for (let i = 0; i < 10; i++) await as(tok, S).post('/store/products', { name: `p${i}`, price: 1, mrp: 1 }).expect(201);
        const r = await as(tok, S).post('/store/products', { name: 'p11', price: 1, mrp: 1 }).expect(403);
        expect(r.body.message).toMatch(/STARTER plan allows 10 live products/);
        await as(tok, S).post('/store/products', { name: 'p11', price: 1, mrp: 1, status: 'ARCHIVED' }).expect(201); // archived is fine
        const ids = (await as(tok, S).get('/store/products?status=ARCHIVED').expect(200)).body.items.map((x: any) => x.id);
        await as(tok, S).post('/store/products/bulk', { ids, action: 'ACTIVATE' }).expect(403);
      } finally {
        await deleteTenants(base, [S.id]);
      }
    });

    it('categories: nesting, depth limit, no cycles, delete guards', async () => {
      const child = (await as(owner).post('/store/categories', { name: 'Silk', parentId: cat.id }).expect(201)).body;
      const grand = (await as(owner).post('/store/categories', { name: 'Bridal', parentId: child.id }).expect(201)).body;
      await as(owner).post('/store/categories', { name: 'Too deep', parentId: grand.id }).expect(400);
      await as(owner).patch(`/store/categories/${cat.id}`, { parentId: grand.id }).expect(400); // cycle
      await as(owner).patch(`/store/categories/${cat.id}`, { parentId: cat.id }).expect(400);
      const tree = (await as(staff).get('/store/categories').expect(200)).body;
      expect(tree.tree.find((c: any) => c.id === cat.id).children[0].children[0].id).toBe(grand.id);
      expect(tree.items.find((c: any) => c.id === cat.id).productCount).toBe(1);
      await as(owner).del(`/store/categories/${cat.id}`).expect(409); // has children + products
      await as(owner).del(`/store/categories/${grand.id}`).expect(204);
      await as(owner).post('/store/categories', { name: 'Sarees' }).then((r) => expect(r.body.slug).toBe('sarees-2'));
      await as(owner).post('/store/categories', { name: 'X', image: img(B, 'c.webp') }).expect(400);
    });
  });

  describe('orders', () => {
    let cust: any, order: any, prod: any;
    beforeAll(async () => {
      prod = await prisma.runAsTenant(A.id, () => db.product.create({ data: { name: 'Mug', slug: 'mug', price: 25000, mrp: 30000, stock: 10, status: 'ACTIVE' } }));
      cust = await prisma.runAsTenant(A.id, () => db.customer.create({ data: { name: 'Priya', phone: '9876543210', email: 'priya@example.test' } }));
      const mkOrder = (over: any = {}) => prisma.runAsTenant(A.id, () => db.order.create({ data: {
        orderNo: `ORD-${uniq()}`, customerId: cust.id, items: [{ productId: prod.id, variantId: null, name: 'Mug', sku: null, qty: 2, unitPrice: 25000, total: 50000, image: null }],
        subtotal: 50000, shipping: 4000, tax: 0, total: 54000, paymentMode: 'COD', address: { city: 'Chennai' }, ...over,
      } }));
      order = await mkOrder();
      await mkOrder({ orderStatus: 'DELIVERED', paymentMode: 'ONLINE', paymentStatus: 'PAID' });
      await mkOrder({ orderStatus: 'CANCELLED' });
      await prisma.runAsTenant(B.id, async () => {
        const cb = await db.customer.create({ data: { name: 'B', phone: '1' } });
        await db.order.create({ data: { orderNo: 'B-1', customerId: cb.id, items: [], subtotal: 1, total: 1, paymentMode: 'COD', address: {} } });
      });
    });

    it('lists with filters and search; detail parses items; other store invisible', async () => {
      expect((await as(staff).get('/store/orders').expect(200)).body.total).toBe(3);
      expect((await as(staff).get('/store/orders?open=true').expect(200)).body.total).toBe(1);
      expect((await as(staff).get('/store/orders?status=DELIVERED').expect(200)).body.total).toBe(1);
      expect((await as(staff).get('/store/orders?paymentMode=ONLINE&paymentStatus=PAID').expect(200)).body.total).toBe(1);
      expect((await as(staff).get('/store/orders?q=98765').expect(200)).body.total).toBe(3);
      expect((await as(staff).get(`/store/orders?q=${order.orderNo}`).expect(200)).body.items[0].id).toBe(order.id);
      await as(staff).get('/store/orders?status=placed').expect(400);
      const d = await as(staff).get(`/store/orders/${order.id}`).expect(200);
      expect(d.body.items[0]).toMatchObject({ name: 'Mug', qty: 2, unitPrice: 25000 });
      expect(d.body.customer.phone).toBe('9876543210');
      const bOrder = await base.order.findFirstOrThrow({ where: { tenantId: B.id } });
      await as(staff).get(`/store/orders/${bOrder.id}`).expect(404);
      await as(staff).post(`/store/orders/${bOrder.id}/status`, { status: 'CONFIRMED' }).expect(404);
    });

    it('status transitions are enforced; cancel restocks; COD mark-paid; history recorded', async () => {
      const go = (s: string) => as(staff).post(`/store/orders/${order.id}/status`, { status: s });
      await go('SHIPPED').expect(400);
      expect((await go('CONFIRMED').expect(200)).body.orderStatus).toBe('CONFIRMED');
      expect((await go('PACKED').expect(200)).body.orderStatus).toBe('PACKED');
      expect((await go('SHIPPED').expect(200)).body.orderStatus).toBe('SHIPPED');
      await go('CANCELLED').expect(400);
      expect((await go('DELIVERED').expect(200)).body.orderStatus).toBe('DELIVERED');
      expect((await as(staff).post(`/store/orders/${order.id}/mark-paid`).expect(200)).body.paymentStatus).toBe('PAID');
      await as(staff).post(`/store/orders/${order.id}/mark-paid`).expect(400); // already paid
      expect((await go('RETURNED').expect(200)).body.orderStatus).toBe('RETURNED');
      expect((await base.product.findUniqueOrThrow({ where: { id: prod.id } })).stock).toBe(12); // 10 + 2 restocked
      await go('PENDING').expect(400);
      const d = await as(staff).get(`/store/orders/${order.id}`).expect(200);
      expect(d.body.history.map((h: any) => h.action)).toEqual(['order.status', 'order.status', 'order.status', 'order.status', 'order.payment', 'order.status']);
      expect((await as(staff).post(`/store/orders/${order.id}/payment-status`, { status: 'REFUNDED' }).expect(200)).body.paymentStatus).toBe('REFUNDED');
      const online = await base.order.findFirstOrThrow({ where: { tenantId: A.id, paymentMode: 'ONLINE' } });
      await as(staff).post(`/store/orders/${online.id}/mark-paid`).expect(400);
    });

    it('dashboard numbers', async () => {
      const d = (await as(owner).get('/store/dashboard').expect(200)).body;
      expect(d.today.orders).toBe(2); // 3 created today minus the cancelled one
      expect(d.today.salesPaise).toBe(108000);
      expect(typeof d.toPack).toBe('number');
      expect(d.lowStock).toBeGreaterThanOrEqual(0);
    });

    it('customers: list with totals, detail with orders, update; search', async () => {
      const l = await as(staff).get('/store/customers?q=priya').expect(200);
      expect(l.body.items[0]).toMatchObject({ phone: '9876543210', orderCount: 3 });
      const d = await as(staff).get(`/store/customers/${cust.id}`).expect(200);
      expect(d.body.orders).toHaveLength(3);
      expect(d.body.spentPaise).toBe(54000); // only the paid, delivered online order counts (cancelled + returned excluded)
      await as(owner).patch(`/store/customers/${cust.id}`, { email: 'PRIYA@EXAMPLE.TEST', addresses: [{ line1: '1 Main St', city: 'Chennai', pincode: '600001' }] }).expect(200)
        .then((r) => expect(r.body.email).toBe('priya@example.test'));
      await as(owner).patch(`/store/customers/${cust.id}`, { email: 'nope' }).expect(400);
      const cb = await base.customer.findFirstOrThrow({ where: { tenantId: B.id } });
      await as(owner).get(`/store/customers/${cb.id}`).expect(404);
    });
  });

  describe('coupons, pages, settings, theme, profile', () => {
    it('coupons: PERCENT <= 100, FLAT paise, upper-cased unique code', async () => {
      const c = (await as(owner).post('/store/coupons', { code: 'diwali10', type: 'PERCENT', value: 10, minOrder: 50000 }).expect(201)).body;
      expect(c.code).toBe('DIWALI10');
      await as(owner).post('/store/coupons', { code: 'DIWALI10', type: 'FLAT', value: 100 }).expect(409);
      await as(owner).post('/store/coupons', { code: 'BIG', type: 'PERCENT', value: 150 }).expect(400);
      await as(owner).post('/store/coupons', { code: 'bad code!', type: 'FLAT', value: 100 }).expect(400);
      const f = (await as(owner).post('/store/coupons', { code: 'FLAT50', type: 'FLAT', value: 5000, expiresAt: '2020-01-01T00:00:00Z' }).expect(201)).body;
      expect(f.expired).toBe(true);
      await as(owner).patch(`/store/coupons/${c.id}`, { value: 101 }).expect(400);
      expect((await as(owner).patch(`/store/coupons/${c.id}`, { value: 15, expiresAt: null }).expect(200)).body.value).toBe(15);
      expect((await as(staff).get('/store/coupons?q=diw').expect(200)).body.total).toBe(1);
      await as(owner).del(`/store/coupons/${f.id}`).expect(204);
    });

    it('pages incl. policy pages', async () => {
      const pol = (await as(owner).post('/store/pages/policies').expect(200)).body;
      expect(pol.map((p: any) => p.slug).sort()).toEqual(['contact-us', 'privacy-policy', 'refund-and-returns', 'shipping-policy', 'terms-and-conditions']);
      expect((await as(owner).post('/store/pages/policies').expect(200)).body).toHaveLength(5); // idempotent
      const about = (await as(owner).post('/store/pages', { title: 'About us', content: '<p>Hi</p>' }).expect(201)).body;
      expect(about.slug).toBe('about-us');
      expect((await as(owner).patch(`/store/pages/${about.id}`, { slug: 'privacy-policy' }).expect(200)).body.slug).toBe('privacy-policy-2');
      expect((await as(staff).get('/store/pages?policy=true').expect(200)).body.total).toBe(5);
      expect((await as(staff).get('/store/pages?policy=false').expect(200)).body.total).toBe(1);
      await as(owner).del(`/store/pages/${about.id}`).expect(204);
    });

    it('settings: shipping modes, city overrides, COD, prefix; owner-only writes', async () => {
      const s = (await as(staff).get('/store/settings').expect(200)).body;
      expect(s).toMatchObject({ shippingMode: 'FLAT', flatRate: 0, codEnabled: true, orderPrefix: 'ORD', cityRates: [] });
      await as(staff).put('/store/settings', { flatRate: 4000 }).expect(403);
      await as(owner).put('/store/settings', { shippingMode: 'FREE_ABOVE' }).expect(400); // needs freeAbove
      const u = (await as(owner).put('/store/settings', {
        shippingMode: 'FREE_ABOVE', freeAbove: 99900, flatRate: 4900, codEnabled: true, codCharge: 2500, orderPrefix: 'SR',
        cityRates: [{ city: 'Chennai', ratePaise: 3000 }, { city: 'Madurai', ratePaise: 5000 }], lowStockThreshold: 3,
      }).expect(200)).body;
      expect(u.cityRates).toEqual([{ city: 'Chennai', ratePaise: 3000 }, { city: 'Madurai', ratePaise: 5000 }]);
      await as(owner).put('/store/settings', { cityRates: [{ city: 'Chennai', ratePaise: 1 }, { city: 'chennai', ratePaise: 2 }] }).expect(400);
      await as(owner).put('/store/settings', { orderPrefix: 'toolongprefix' }).expect(400);
      await as(owner).put('/store/settings', { flatRate: 49.5 }).expect(400);
    });

    it('theme and profile', async () => {
      expect((await as(staff).get('/store/theme').expect(200)).body.paletteId).toBe('classic');
      const t = (await as(owner).put('/store/theme', { primaryColor: '#0f766e', secondaryColor: '#f59e0b', logoUrl: img(A, 'logo.webp') }).expect(200)).body;
      expect(t.primaryColor).toBe('#0f766e');
      await as(owner).put('/store/theme', { primaryColor: 'teal' }).expect(400);
      await as(owner).put('/store/theme', { logoUrl: img(B, 'logo.webp') }).expect(400);
      await as(staff).put('/store/theme', { primaryColor: '#000000' }).expect(403);
      const p = (await as(owner).patch('/store/profile', { name: 'Sri Silks', gstNumber: '33ABCDE1234F1Z5', whatsappNumber: '919403892971' }).expect(200)).body;
      expect(p).toMatchObject({ name: 'Sri Silks', razorpayConfigured: false });
      expect(JSON.stringify(p)).not.toMatch(/razorpayKeyEnc/);
      await as(owner).patch('/store/profile', { plan: 'STANDARD' }).expect(400); // not whitelisted
      await as(owner).patch('/store/profile', { gstNumber: 'short' }).expect(400);
      expect((await api().get('/health').set('Host', host(A)).expect(200)).body.tenant).toBe(A.slug);
    });
  });

  it("other store's token is refused on every admin route", async () => {
    for (const p of ['/store/products', '/store/categories', '/store/orders', '/store/customers', '/store/coupons', '/store/pages', '/store/settings', '/store/theme', '/store/profile', '/store/dashboard']) {
      await api().get(p).set('Host', host(A)).set('Authorization', `Bearer ${ownerB}`).expect(403);
      await api().get(p).set('Host', host(A)).expect(401);
    }
  });
});
