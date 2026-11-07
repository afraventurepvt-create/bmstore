import { Injectable } from '@nestjs/common';
import { ProductStatus } from '@prisma/client';
import { RequestContext } from '../common/request-context';
import { slugify } from '../common/slug';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from '../catalog/products.service';
import { PLAN_LIMITS } from '../tenancy/plans';
import { detectFormat, parseImportFile, RawRow } from './import-parse';

export interface RowIssue { row: number; reason: string }
export interface ImportReport {
  dryRun: boolean;
  totalRows: number;
  imported: number;
  updated: number;
  failed: number;
  errors: RowIssue[];
  warnings: RowIssue[];
  durationMs: number;
}
export interface ImportOptions { filename: string; contentType?: string; dryRun?: boolean; status?: ProductStatus; mode?: 'create' | 'upsert' }

interface Valid { row: number; name: string; description: string | null; price: number; mrp: number; sku: string | null; stock: number; category: string | null; hsnCode: string | null; imageFilename: string | null }

/** Resolves image_filename to a public URL of this tenant's media (wired by the media module); null = not found. */
export abstract class ImportImageResolver {
  abstract resolve(filenames: string[]): Promise<Map<string, string>>;
}
@Injectable()
export class NoImageResolver extends ImportImageResolver {
  async resolve(): Promise<Map<string, string>> { return new Map(); }
}

const CHUNK = 100;

@Injectable()
export class ProductImportService {
  constructor(private readonly prisma: PrismaService, private readonly products: ProductsService, private readonly images: ImportImageResolver) {}
  private get db() { return this.prisma.db; }

  async run(buf: Buffer, opts: ImportOptions): Promise<ImportReport> {
    const t0 = Date.now();
    const format = detectFormat(opts.filename, opts.contentType);
    const { rows, unknownColumns } = await parseImportFile(buf, format);
    const status = opts.status ?? 'ACTIVE';
    const mode = opts.mode ?? 'create';
    const errors: RowIssue[] = [];
    const warnings: RowIssue[] = [];
    if (unknownColumns.length) warnings.push({ row: 1, reason: `Ignored columns the import does not know: ${unknownColumns.join(', ')}` });

    // 1. validate every row
    const valid: Valid[] = [];
    const skuRow = new Map<string, number>();
    for (const r of rows) {
      const v = validateRow(r, errors);
      if (!v) continue;
      if (v.sku) {
        const k = v.sku.toLowerCase();
        if (skuRow.has(k)) { errors.push({ row: r.row, reason: `SKU "${v.sku}" is also used on row ${skuRow.get(k)}` }); continue; }
        skuRow.set(k, r.row);
      }
      valid.push(v);
    }

    // 2. existing SKUs in this store (create mode: error; upsert mode: update)
    const skus = valid.filter((v) => v.sku).map((v) => v.sku!);
    const existing = skus.length ? await this.db.product.findMany({ where: { sku: { in: skus } }, select: { id: true, sku: true, status: true } }) : [];
    const bySku = new Map(existing.map((p) => [p.sku!.toLowerCase(), p]));
    const toCreate: Valid[] = [];
    const toUpdate: Array<Valid & { id: string; wasArchived: boolean }> = [];
    for (const v of valid) {
      const ex = v.sku ? bySku.get(v.sku.toLowerCase()) : undefined;
      if (!ex) toCreate.push(v);
      else if (mode === 'upsert') toUpdate.push({ ...v, id: ex.id, wasArchived: ex.status === 'ARCHIVED' });
      else errors.push({ row: v.row, reason: `SKU "${v.sku}" already exists in your store (use "update existing" to overwrite)` });
    }

    // 3. plan cap: rows past the remaining live slots fail with a clear reason, the rest still import
    const plan = RequestContext.get()?.tenant?.plan ?? (await this.db.tenant.findUniqueOrThrow({ where: { id: RequestContext.tenantId()! }, select: { plan: true } })).plan;
    const max = PLAN_LIMITS[plan].maxProducts;
    if (max !== null && status !== 'ARCHIVED') {
      const live = await this.db.product.count({ where: { status: { not: 'ARCHIVED' } } });
      let room = max - live - (toUpdate.filter((u) => u.wasArchived).length);
      const keep: Valid[] = [];
      for (const v of toCreate) {
        if (room > 0) { keep.push(v); room--; } else errors.push({ row: v.row, reason: `Your ${plan} plan allows ${max} live products; there is no room for this one. Archive or delete products, import with status DRAFT, or upgrade.` });
      }
      toCreate.length = 0; toCreate.push(...keep);
    }
    await this.products.assertCanAddLiveProducts(0); // fair-use hook point (no-op here)

    // 4. categories by name (find or create, top level), images by filename
    const catNames = [...new Set([...toCreate, ...toUpdate].map((v) => v.category).filter(Boolean) as string[])];
    const catIds = opts.dryRun ? new Map<string, string>() : await this.categoriesByName(catNames);
    const wantedImages = [...new Set([...toCreate, ...toUpdate].map((v) => v.imageFilename).filter(Boolean) as string[])];
    const imageUrls = wantedImages.length ? await this.images.resolve(wantedImages) : new Map<string, string>();
    for (const v of [...toCreate, ...toUpdate]) {
      if (v.imageFilename && !imageUrls.has(v.imageFilename.toLowerCase())) warnings.push({ row: v.row, reason: `Image "${v.imageFilename}" has not been uploaded yet; the product was imported without it` });
    }

    let imported = 0;
    let updated = 0;
    if (!opts.dryRun) {
      // 5. slugs: unique within the store and within the file
      const taken = new Set((await this.db.product.findMany({ select: { slug: true } })).map((p) => p.slug));
      const slugFor = (name: string) => {
        const base = slugify(name, 'product');
        let s = base;
        for (let i = 2; taken.has(s); i++) s = `${base}-${i}`;
        taken.add(s);
        return s;
      };
      const tenantId = RequestContext.tenantId()!;
      // 6. insert in chunks; if a chunk fails, retry row by row so the error lands on the right row
      for (let i = 0; i < toCreate.length; i += CHUNK) {
        const chunk = toCreate.slice(i, i + CHUNK);
        const data = chunk.map((v) => ({
          tenantId, name: v.name, slug: slugFor(v.name), description: v.description, price: v.price, mrp: v.mrp, sku: v.sku, stock: v.stock, status,
          categoryId: v.category ? catIds.get(v.category.toLowerCase()) ?? null : null, hsnCode: v.hsnCode,
          images: v.imageFilename && imageUrls.get(v.imageFilename.toLowerCase()) ? [imageUrls.get(v.imageFilename.toLowerCase())!] : [],
        }));
        try {
          imported += (await this.db.product.createMany({ data })).count;
        } catch {
          for (let j = 0; j < data.length; j++) {
            try { await this.db.product.create({ data: data[j] }); imported++; }
            catch (e) { errors.push({ row: chunk[j].row, reason: plain(e) }); }
          }
        }
      }
      for (const u of toUpdate) {
        try {
          await this.db.product.update({ where: { id: u.id }, data: {
            name: u.name, description: u.description, price: u.price, mrp: u.mrp, stock: u.stock, hsnCode: u.hsnCode,
            ...(u.category ? { categoryId: catIds.get(u.category.toLowerCase()) ?? null } : {}),
            ...(u.imageFilename && imageUrls.get(u.imageFilename.toLowerCase()) ? { images: [imageUrls.get(u.imageFilename.toLowerCase())!] } : {}),
            ...(u.wasArchived ? { status } : {}),
          } });
          updated++;
        } catch (e) { errors.push({ row: u.row, reason: plain(e) }); }
      }
    } else {
      imported = toCreate.length;
      updated = toUpdate.length;
    }
    errors.sort((a, b) => a.row - b.row);
    warnings.sort((a, b) => a.row - b.row);
    return { dryRun: Boolean(opts.dryRun), totalRows: rows.length, imported, updated, failed: errors.filter((e) => e.row > 1).length, errors, warnings, durationMs: Date.now() - t0 };
  }

  private async categoriesByName(names: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!names.length) return out;
    const existing = await this.db.category.findMany({ select: { id: true, name: true } });
    for (const c of existing) out.set(c.name.toLowerCase(), c.id);
    const taken = new Set((await this.db.category.findMany({ select: { slug: true } })).map((c) => c.slug));
    for (const n of names) {
      if (out.has(n.toLowerCase())) continue;
      let slug = slugify(n, 'category');
      for (let i = 2; taken.has(slug); i++) slug = `${slugify(n, 'category')}-${i}`;
      taken.add(slug);
      const c = await this.db.category.create({ data: { tenantId: RequestContext.tenantId()!, name: n, slug } });
      out.set(n.toLowerCase(), c.id);
    }
    return out;
  }
}

// ---- row validation ------------------------------------------------------------------------------
const HSN = /^\d{4}(\d{2})?(\d{2})?$/;

function validateRow(r: RawRow, errors: RowIssue[]): Valid | null {
  const c = r.cells;
  const problems: string[] = [];
  const name = (c.name ?? '').trim();
  if (!name) problems.push('name is missing');
  else if (name.length > 200) problems.push('name is longer than 200 characters');
  const price = money(c.price, 'price', problems);
  const mrp = money(c.mrp, 'mrp', problems);
  if (price !== null && mrp !== null && mrp < price) problems.push(`mrp (₹${(mrp / 100).toFixed(2)}) is lower than price (₹${(price / 100).toFixed(2)})`);
  let stock = 0;
  if (c.stock !== undefined && c.stock !== '') {
    const n = Number(c.stock.replace(/,/g, ''));
    if (!Number.isInteger(n) || n < 0) problems.push(`stock "${c.stock}" must be a whole number (0 or more)`);
    else if (n > 1_000_000) problems.push('stock is unrealistically large (max 1,000,000)');
    else stock = n;
  }
  const sku = (c.sku ?? '').trim() || null;
  if (sku && sku.length > 60) problems.push('sku is longer than 60 characters');
  const hsn = (c.hsn_code ?? '').trim().replace(/\.0$/, '') || null;
  if (hsn && !HSN.test(hsn)) problems.push(`hsn_code "${hsn}" must be 4, 6 or 8 digits`);
  const description = (c.description ?? '').trim() || null;
  if (description && description.length > 5000) problems.push('description is longer than 5000 characters');
  const category = (c.category ?? '').trim() || null;
  if (category && category.length > 80) problems.push('category name is longer than 80 characters');
  const imageFilename = (c.image_filename ?? '').trim() || null;
  if (problems.length) { errors.push({ row: r.row, reason: problems.join('; ') }); return null; }
  return { row: r.row, name, description, price: price!, mrp: mrp!, sku, stock, category, hsnCode: hsn, imageFilename };
}

/** "₹1,299.50" / "1299" / "1299.5" -> paise. Rejects more than 2 decimals, negatives and junk. */
export function money(raw: string | undefined, field: string, problems: string[]): number | null {
  const s = (raw ?? '').replace(/[₹,\s]|rs\.?/gi, '');
  if (!s) { problems.push(`${field} is missing`); return null; }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    problems.push(/^\d+\.\d{3,}$/.test(s) ? `${field} "${raw}" has more than 2 decimals` : `${field} "${raw}" is not an amount in rupees`);
    return null;
  }
  const [rupees, paise = ''] = s.split('.');
  const v = Number(rupees) * 100 + Number((paise + '00').slice(0, 2));
  if (v > 2_000_000_000) { problems.push(`${field} is unrealistically large`); return null; }
  return v;
}

function plain(e: unknown): string {
  const m = String((e as Error)?.message ?? '');
  if (/plan_limit_exceeded/.test(m)) return 'Your plan has no room for another live product';
  if (/Unique constraint/.test(m)) return 'A product with the same SKU or web address already exists';
  if (/check constraint/.test(m)) return 'A value is out of range';
  return 'Could not save this row';
}
