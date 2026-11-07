'use client';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { api, uploadImages } from '@/lib/api';
import { fromPaise, toPaise } from '@/lib/money';
import { Confirm, Field, Input, Select, Textarea, useLoad, useToast } from './ui';

type Variant = { id?: string; optionName: string; optionValue: string; priceDelta: number; stock: number; sku?: string | null };

export function ProductForm({ product }: { product?: any }) {
  const router = useRouter();
  const toast = useToast();
  const isNew = !product;
  const [name, setName] = useState(product?.name ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [price, setPrice] = useState(fromPaise(product?.price));
  const [mrp, setMrp] = useState(fromPaise(product?.mrp));
  const [sku, setSku] = useState(product?.sku ?? '');
  const [stock, setStock] = useState(String(product?.stock ?? 0));
  const [status, setStatus] = useState(product?.status ?? 'ACTIVE');
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? '');
  const [hsnCode, setHsn] = useState(product?.hsnCode ?? '');
  const [images, setImages] = useState<string[]>(product?.images ?? []);
  const [variants, setVariants] = useState<Variant[]>(product?.variants ?? []);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const cats = useLoad(() => api('/store/categories'), []);

  const validate = () => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = 'Give the product a name';
    const p = toPaise(price); const m = toPaise(mrp || price);
    if (p === null) e.price = 'Enter the selling price in rupees, e.g. 499 or 499.50';
    if (m === null) e.mrp = 'Enter the MRP in rupees';
    if (p !== null && m !== null && m < p) e.mrp = 'MRP cannot be lower than the selling price';
    if (!/^\d+$/.test(stock)) e.stock = 'Stock must be a whole number';
    if (hsnCode && !/^\d{4}(\d{2})?(\d{2})?$/.test(hsnCode)) e.hsnCode = 'HSN code is 4, 6 or 8 digits';
    setErrors(e);
    return !Object.keys(e).length;
  };
  const save = async () => {
    if (!validate()) return;
    setBusy(true);
    const body: any = { name: name.trim(), description: description || null, price: toPaise(price), mrp: toPaise(mrp || price), sku: sku || null, stock: Number(stock), status, categoryId: categoryId || null, images, hsnCode: hsnCode || null };
    try {
      if (isNew) {
        const created = await api('/store/products', { method: 'POST', json: { ...body, variants: variants.map(({ id, ...v }) => v) } });
        toast.push('Product added');
        router.replace(`/products/${created.id}`);
      } else {
        await api(`/store/products/${product.id}`, { method: 'PATCH', json: body });
        toast.push('Saved');
        router.refresh();
      }
    } catch (e: any) { toast.push(e.message, 'bad'); } finally { setBusy(false); }
  };
  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(`Uploading ${files.length} image${files.length > 1 ? 's' : ''}…`);
    try {
      const media = await uploadImages([...files], 'product', (d, t) => setUploading(`Uploaded ${d} of ${t}… making web copies`));
      setImages((x) => [...x, ...media.map((m) => m.url)].slice(0, 12));
      toast.push('Images added. Remember to save.');
    } catch (e: any) { toast.push(e.message, 'bad'); } finally { setUploading(null); if (fileRef.current) fileRef.current.value = ''; }
  };
  const saveVariant = async (i: number) => {
    const v = variants[i];
    if (isNew) return;
    const payload = { optionName: v.optionName, optionValue: v.optionValue, priceDelta: v.priceDelta, stock: v.stock, sku: v.sku || null };
    try {
      const saved = v.id
        ? await api(`/store/products/${product.id}/variants/${v.id}`, { method: 'PATCH', json: payload })
        : await api(`/store/products/${product.id}/variants`, { method: 'POST', json: payload });
      setVariants((vs) => vs.map((x, j) => (j === i ? saved : x)));
      toast.push('Variant saved');
    } catch (e: any) { toast.push(e.message, 'bad'); }
  };
  const removeVariant = async (i: number) => {
    const v = variants[i];
    if (v.id && !isNew) { try { await api(`/store/products/${product.id}/variants/${v.id}`, { method: 'DELETE' }); } catch (e: any) { return toast.push(e.message, 'bad'); } }
    setVariants((vs) => vs.filter((_, j) => j !== i));
  };
  const del = async () => {
    try { await api(`/store/products/${product.id}`, { method: 'DELETE' }); toast.push('Product deleted'); router.replace('/products'); } catch (e: any) { toast.push(e.message, 'bad'); }
  };
  const setV = (i: number, patch: Partial<Variant>) => setVariants((vs) => vs.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <section className="card p-4 flex flex-col gap-4">
        <Field label="Product name" error={errors.name}><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kanchipuram silk saree / பட்டுப் புடவை" autoFocus={isNew} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Selling price (₹)" error={errors.price}><Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="499" /></Field>
          <Field label="MRP (₹)" error={errors.mrp} hint="Shown struck out"><Input inputMode="decimal" value={mrp} onChange={(e) => setMrp(e.target.value)} placeholder="599" /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="In stock" error={errors.stock}><Input inputMode="numeric" value={stock} onChange={(e) => setStock(e.target.value)} /></Field>
          <Field label="Status"><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="ACTIVE">Live (customers can buy)</option><option value="DRAFT">Draft (hidden)</option><option value="ARCHIVED">Archived</option></Select></Field>
        </div>
        <Field label="Category"><Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">No category</option>{cats.data?.items?.map((c: any) => <option key={c.id} value={c.id}>{c.parentId ? '— ' : ''}{c.name}</option>)}</Select></Field>
        <Field label="Description" hint="Material, size, care… what a customer asks on WhatsApp"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="SKU (your code)"><Input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="SAR-001" /></Field>
          <Field label="HSN code" error={errors.hsnCode} hint="For GST invoices"><Input inputMode="numeric" value={hsnCode} onChange={(e) => setHsn(e.target.value)} placeholder="5007" /></Field>
        </div>
      </section>

      <section className="card p-4">
        <div className="flex items-center justify-between mb-3"><h2 className="font-semibold">Photos</h2><span className="text-xs text-ink-3">{images.length}/12</span></div>
        <div className="grid grid-cols-3 gap-2">
          {images.map((src, i) => (
            <div key={src} className="relative aspect-square">
              <img src={src} alt="" className="h-full w-full rounded-xl object-cover bg-paper" />
              {i === 0 && <span className="absolute left-1.5 top-1.5 rounded-md bg-ink/70 text-white text-[10px] px-1.5 py-0.5">Main</span>}
              <button type="button" aria-label="Remove photo" onClick={() => setImages((x) => x.filter((s) => s !== src))} className="absolute -right-1.5 -top-1.5 h-8 w-8 rounded-full bg-card border border-line shadow text-ink-2">✕</button>
            </div>
          ))}
          {images.length < 12 && (
            <button type="button" onClick={() => fileRef.current?.click()} disabled={!!uploading} className="aspect-square rounded-xl border-2 border-dashed border-line text-ink-3 grid place-items-center text-sm hover:border-brand hover:text-brand">{uploading ? '…' : '+ Add'}</button>
          )}
        </div>
        {uploading && <p className="text-sm text-ink-3 mt-2">{uploading}</p>}
        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => pick(e.target.files)} />
        <p className="text-xs text-ink-3 mt-2">Photos are shrunk and converted for the web automatically. The first one is the main photo.</p>
      </section>

      <section className="card p-4">
        <div className="flex items-center justify-between mb-3"><h2 className="font-semibold">Variants <span className="text-ink-3 font-normal text-sm">(size, colour…)</span></h2><button type="button" className="btn-ghost h-10 min-h-0" onClick={() => setVariants((v) => [...v, { optionName: v[0]?.optionName ?? 'Size', optionValue: '', priceDelta: 0, stock: 0 }])}>+ Add</button></div>
        {!variants.length && <p className="text-sm text-ink-3">No variants. Add one if this product comes in sizes or colours.</p>}
        <div className="flex flex-col gap-3">
          {variants.map((v, i) => (
            <div key={v.id ?? i} className="rounded-xl border border-line p-3 grid grid-cols-2 gap-2">
              <Input placeholder="Option (Size)" value={v.optionName} onChange={(e) => setV(i, { optionName: e.target.value })} />
              <Input placeholder="Value (XL)" value={v.optionValue} onChange={(e) => setV(i, { optionValue: e.target.value })} />
              <Input inputMode="decimal" placeholder="+ ₹ extra" value={v.priceDelta ? fromPaise(v.priceDelta) : ''} onChange={(e) => setV(i, { priceDelta: toPaise(e.target.value || '0') ?? 0 })} />
              <Input inputMode="numeric" placeholder="Stock" value={String(v.stock)} onChange={(e) => setV(i, { stock: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
              <div className="col-span-2 flex gap-2">
                {!isNew && <button type="button" className="btn-secondary h-11 min-h-0 flex-1" onClick={() => saveVariant(i)}>{v.id ? 'Save variant' : 'Add variant'}</button>}
                <button type="button" className="btn-ghost h-11 min-h-0 text-bad" onClick={() => removeVariant(i)}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="sticky bottom-20 md:static z-20 flex gap-3">
        <button className="btn-primary flex-1" disabled={busy}>{busy ? 'Saving…' : isNew ? 'Add product' : 'Save changes'}</button>
        {!isNew && <button type="button" className="btn-danger" onClick={() => setConfirmDelete(true)}>Delete</button>}
      </div>
      <Confirm open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this product?" text="This cannot be undone. Archiving hides it but keeps it." confirmLabel="Delete" danger onConfirm={del} />
    </form>
  );
}
