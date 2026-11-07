/** CSV / XLSX product import: 500+ rows, per-row report, template, dry run, upsert, plan cap, isolation. */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import request from 'supertest';
import { AuthService } from '../src/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createApp, deleteTenants, makeTenant, uniq } from './helpers';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('product import', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let base: PrismaClient;
  let A: any, B: any, tokA: string, tokB: string;
  const PW = 'correct-horse-battery';
  const api = () => request(app.getHttpServer());
  const host = (t: any) => `${t.subdomain}.localhost`;
  const upload = (t: any, tok: string, body: Buffer | string, filename: string, extra = '', type = 'text/csv') =>
    api().post(`/store/import/products?filename=${encodeURIComponent(filename)}${extra}`).set('Host', host(t)).set('Authorization', `Bearer ${tok}`).set('Content-Type', type).send(body);

  const csv = (rows: (string | number)[][], header = ['name', 'description', 'price', 'mrp', 'sku', 'stock', 'category', 'hsn_code', 'image_filename']) =>
    [header, ...rows].map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(',')).join('\r\n') + '\r\n';

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    base = prisma.base;
    A = await makeTenant(base, { plan: 'STANDARD' });
    B = await makeTenant(base, { plan: 'STANDARD' });
    const auth = app.get(AuthService);
    const mk = async (t: any) => {
      const email = `o-${uniq()}@imp.test`;
      await prisma.runAsTenant(t.id, async () => prisma.db.user.create({ data: { email, passwordHash: await auth.hashPassword(PW), role: 'store_owner' } }));
      return (await api().post('/auth/login').set('Host', host(t)).send({ email, password: PW }).expect(200)).body.accessToken;
    };
    tokA = await mk(A);
    tokB = await mk(B);
  });
  afterAll(async () => {
    await deleteTenants(base, [A.id, B.id]);
    await app.close();
  });

  it('imports 600 rows with a per-row report for the bad ones; rupees become paise; categories are created', async () => {
    const rows: (string | number)[][] = [];
    for (let i = 1; i <= 600; i++) rows.push([`Product ${i}`, `Desc ${i}`, (i * 10 + 0.5).toFixed(2), (i * 12).toFixed(2), `SKU-${i}`, i % 7, ['Sarees', 'Kurtas', 'Jewellery', 'Home'][i % 4], '5007', i % 10 === 0 ? `img-${i}.jpg` : '']);
    // deliberately broken rows (file row = index + 2 because row 1 is the heading)
    rows[4] = ['', 'no name', '10', '12', 'SKU-BAD1', '1', '', '', ''];            // row 6
    rows[9] = ['Bad price', '', 'ten', '12', 'SKU-BAD2', '1', '', '', ''];        // row 11
    rows[14] = ['Too many decimals', '', '10.999', '12', 'SKU-BAD3', '1', '', '', '']; // row 16
    rows[19] = ['MRP low', '', '100', '50', 'SKU-BAD4', '1', '', '', ''];           // row 21
    rows[24] = ['Bad stock', '', '10', '12', 'SKU-BAD5', '1.5', '', '', ''];       // row 26
    rows[29] = ['Dup sku', '', '10', '12', 'SKU-1', '1', '', '', ''];              // row 31 (SKU-1 is on row 2)
    rows[34] = ['Bad hsn', '', '10', '12', 'SKU-BAD6', '1', '', '12', ''];         // row 36
    const file = '﻿' + csv(rows); // BOM like Excel writes it
    const r = await upload(A, tokA, file, 'products.csv').expect(200);
    expect(r.body).toMatchObject({ dryRun: false, totalRows: 600, imported: 593, updated: 0, failed: 7 });
    const reasons = Object.fromEntries(r.body.errors.map((e: any) => [e.row, e.reason]));
    expect(reasons[6]).toMatch(/name is missing/);
    expect(reasons[11]).toMatch(/price "ten" is not an amount in rupees/);
    expect(reasons[16]).toMatch(/more than 2 decimals/);
    expect(reasons[21]).toMatch(/mrp \(₹50\.00\) is lower than price \(₹100\.00\)/);
    expect(reasons[26]).toMatch(/stock "1.5" must be a whole number/);
    expect(reasons[31]).toMatch(/SKU "SKU-1" is also used on row 2/);
    expect(reasons[36]).toMatch(/hsn_code "12" must be 4, 6 or 8 digits/);
    expect(r.body.warnings.filter((w: any) => /has not been uploaded yet/.test(w.reason)).length).toBe(57); // img-10 … img-600 (60) minus the 3 broken rows that carried one
    expect(r.body.durationMs).toBeLessThan(20_000);
    const p1 = await base.product.findFirstOrThrow({ where: { tenantId: A.id, sku: 'SKU-1' }, include: { category: true } });
    expect(p1).toMatchObject({ name: 'Product 1', price: 1050, mrp: 1200, stock: 1, status: 'ACTIVE', slug: 'product-1', hsnCode: '5007' });
    expect(p1.category!.name).toBe('Kurtas');
    expect(await base.category.count({ where: { tenantId: A.id } })).toBe(4);
    expect(await base.product.count({ where: { tenantId: A.id } })).toBe(593);
    // the store's own list sees them
    expect((await api().get('/store/products?q=Product%2059').set('Host', host(A)).set('Authorization', `Bearer ${tokA}`).expect(200)).body.total).toBeGreaterThan(0);
  }, 60_000);

  it('a second import of the same file: SKUs clash in create mode, update in upsert mode; dry run changes nothing', async () => {
    const file = csv([['Product 1 renamed', 'd', '1,299.00', '₹1,999', 'SKU-1', '42', 'Sarees', '', ''], ['Brand new', '', '5', '6', 'SKU-NEW', '1', 'New Cat', '', '']]);
    const dry = await upload(A, tokA, file, 'again.csv', '&dryRun=true').expect(200);
    expect(dry.body).toMatchObject({ dryRun: true, imported: 1, failed: 1 });
    expect(await base.product.count({ where: { tenantId: A.id, sku: 'SKU-NEW' } })).toBe(0);
    expect(await base.category.count({ where: { tenantId: A.id, name: 'New Cat' } })).toBe(0);
    const clash = await upload(A, tokA, file, 'again.csv').expect(200);
    expect(clash.body).toMatchObject({ imported: 1, failed: 1 });
    expect(clash.body.errors[0].reason).toMatch(/SKU "SKU-1" already exists in your store/);
    const up = await upload(A, tokA, file, 'again.csv', '&mode=upsert').expect(200);
    expect(up.body).toMatchObject({ imported: 0, updated: 2, failed: 0 });
    const p1 = await base.product.findFirstOrThrow({ where: { tenantId: A.id, sku: 'SKU-1' }, include: { category: true } });
    expect(p1).toMatchObject({ name: 'Product 1 renamed', price: 129900, mrp: 199900, stock: 42 });
    expect(p1.category!.name).toBe('Sarees');
  });

  it('XLSX works the same (numbers as numbers, semicolon CSV too); status can be DRAFT', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Products');
    ws.addRow(['Name', 'Description', 'Price', 'MRP', 'SKU', 'Stock', 'Category', 'HSN Code', 'Image Filename']);
    ws.addRow(['Excel one', 'from xlsx', 499.5, 599, 'XL-1', 3, 'Sheets', 6302, '']);
    ws.addRow(['Excel two', '', 'abc', 599, 'XL-2', 3, '', '', '']);
    ws.addRow([]);
    ws.addRow(['Excel three', '', 10, 12, 'XL-3', 0, '', '', '']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await upload(A, tokA, buf, 'products.xlsx', '&status=DRAFT', XLSX).expect(200);
    expect(r.body).toMatchObject({ totalRows: 3, imported: 2, failed: 1 });
    expect(r.body.errors[0]).toMatchObject({ row: 3 });
    const x = await base.product.findFirstOrThrow({ where: { tenantId: A.id, sku: 'XL-1' } });
    expect(x).toMatchObject({ price: 49950, mrp: 59900, status: 'DRAFT', hsnCode: '6302' });
    const semi = 'name;price;mrp;sku\r\nSemi;10;12;SEMI-1\r\n';
    expect((await upload(A, tokA, semi, 'semi.csv').expect(200)).body.imported).toBe(1);
  });

  it('bad files: missing headings, empty body, wrong type, too many rows', async () => {
    expect((await upload(A, tokA, 'title,cost\nx,1\n', 'x.csv').expect(400)).body.message).toMatch(/Missing: name, price, mrp/);
    await upload(A, tokA, '', 'x.csv').expect(400);
    await upload(A, tokA, 'name,price,mrp\n', 'x.xls').expect(400);
    await upload(A, tokA, 'name,price,mrp\nx,1,1\n', 'x.pdf', '', 'application/octet-stream').expect(400);
    await api().post('/store/import/products').set('Host', host(A)).set('Authorization', `Bearer ${tokA}`).set('Content-Type', 'text/csv').send('name,price,mrp\n').expect(400); // filename required
    const big = csv(Array.from({ length: 5001 }, (_, i) => [`p${i}`, '1', '1']), ['name', 'price', 'mrp']);
    expect((await upload(A, tokA, big, 'big.csv').expect(400)).body.message).toMatch(/At most 5000/);
    await upload(A, tokA, Buffer.from('not a zip'), 'x.xlsx', '', XLSX).expect(400);
  });

  it('templates download and import back cleanly', async () => {
    const c = await api().get('/store/import/products/template?format=csv').set('Host', host(A)).set('Authorization', `Bearer ${tokA}`).expect(200);
    expect(c.headers['content-disposition']).toMatch(/products-template\.csv/);
    expect(c.text).toMatch(/^﻿name,description,price,mrp,sku,stock,category,hsn_code,image_filename/);
    expect((await upload(A, tokA, c.text, 'products-template.csv', '&dryRun=true').expect(200)).body).toMatchObject({ totalRows: 2, imported: 2, failed: 0 });
    const x = await api().get('/store/import/products/template?format=xlsx').set('Host', host(A)).set('Authorization', `Bearer ${tokA}`).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (d) => chunks.push(d)); res.on('end', () => cb(null, Buffer.concat(chunks))); }).expect(200);
    expect(x.headers['content-type']).toMatch(/spreadsheetml/);
    expect((await upload(A, tokA, x.body, 'products-template.xlsx', '&dryRun=true', XLSX).expect(200)).body).toMatchObject({ totalRows: 2, imported: 2, failed: 0 });
  });

  it('isolation: the same SKUs import fine in another store; STARTER cap fails only the rows past the cap', async () => {
    const file = csv([['Product 1', '', '10', '12', 'SKU-1', '1', 'Sarees', '', '']]);
    expect((await upload(B, tokB, file, 'b.csv').expect(200)).body.imported).toBe(1);
    expect(await base.product.count({ where: { sku: 'SKU-1' } })).toBe(2);
    await upload(A, tokB, file, 'b.csv').expect(403); // B's token on A's host
    const S = await makeTenant(base, { plan: 'STARTER' });
    try {
      const email = `o-${uniq()}@imp.test`;
      await prisma.runAsTenant(S.id, async () => prisma.db.user.create({ data: { email, passwordHash: await app.get(AuthService).hashPassword(PW), role: 'store_owner' } }));
      const tok = (await api().post('/auth/login').set('Host', host(S)).send({ email, password: PW }).expect(200)).body.accessToken;
      const twelve = csv(Array.from({ length: 12 }, (_, i) => [`p${i + 1}`, '1', '1', `S-${i + 1}`]), ['name', 'price', 'mrp', 'sku']);
      const r = await upload(S, tok, twelve, 's.csv').expect(200);
      expect(r.body).toMatchObject({ imported: 10, failed: 2 });
      expect(r.body.errors.map((e: any) => e.row)).toEqual([12, 13]);
      expect(r.body.errors[0].reason).toMatch(/STARTER plan allows 10 live products/);
      const asDraft = await upload(S, tok, csv([['draft one', '1', '1', 'S-99']], ['name', 'price', 'mrp', 'sku']), 'd.csv', '&status=DRAFT').expect(200);
      expect(asDraft.body).toMatchObject({ imported: 0, failed: 1 }); // DRAFT still counts as live
      const archived = await upload(S, tok, csv([['archived one', '1', '1', 'S-98']], ['name', 'price', 'mrp', 'sku']), 'a.csv', '&status=ARCHIVED').expect(200);
      expect(archived.body).toMatchObject({ imported: 1, failed: 0 });
    } finally { await deleteTenants(base, [S.id]); }
  });
});
