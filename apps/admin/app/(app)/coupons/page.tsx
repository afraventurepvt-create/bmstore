'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { day, fromPaise, rupees, toPaise } from '@/lib/money';
import { Badge, Card, Confirm, Empty, ErrorBox, Field, Input, PageTitle, Select, Spinner, useLoad, useToast } from '@/components/ui';

type Draft = { id?: string; code: string; type: 'PERCENT' | 'FLAT'; value: string; minOrder: string; usageLimit: string; expiresAt: string };
const empty: Draft = { code: '', type: 'PERCENT', value: '', minOrder: '', usageLimit: '', expiresAt: '' };

export default function CouponsPage() {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(() => api('/store/coupons?pageSize=100'), []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<any>(null);
  const edit = (c: any) => setDraft({ id: c.id, code: c.code, type: c.type, value: c.type === 'FLAT' ? fromPaise(c.value) : String(c.value), minOrder: c.minOrder ? fromPaise(c.minOrder) : '', usageLimit: c.usageLimit ? String(c.usageLimit) : '', expiresAt: c.expiresAt ? c.expiresAt.slice(0, 10) : '' });
  const save = async () => {
    if (!draft) return;
    const value = draft.type === 'FLAT' ? toPaise(draft.value) : Number(draft.value);
    const minOrder = draft.minOrder ? toPaise(draft.minOrder) : 0;
    if (value === null || !Number.isInteger(value) || value <= 0) return toast.push(draft.type === 'FLAT' ? 'Enter the discount in rupees' : 'Enter a whole percent, e.g. 10', 'bad');
    if (minOrder === null) return toast.push('Minimum order must be an amount in rupees', 'bad');
    const body: any = { code: draft.code.trim().toUpperCase(), type: draft.type, value, minOrder, usageLimit: draft.usageLimit ? Number(draft.usageLimit) : null, expiresAt: draft.expiresAt ? new Date(draft.expiresAt + 'T23:59:59+05:30').toISOString() : null };
    setBusy(true);
    try {
      if (draft.id) await api(`/store/coupons/${draft.id}`, { method: 'PATCH', json: body }); else await api('/store/coupons', { method: 'POST', json: body });
      toast.push(draft.id ? 'Coupon saved' : 'Coupon created'); setDraft(null); reload();
    } catch (e: any) { toast.push(e.message, 'bad'); } finally { setBusy(false); }
  };
  const remove = async (c: any) => { try { await api(`/store/coupons/${c.id}`, { method: 'DELETE' }); toast.push('Coupon deleted'); reload(); } catch (e: any) { toast.push(e.message, 'bad'); } };
  return (
    <div>
      <PageTitle title="Coupons" action={<button className="btn-primary" onClick={() => setDraft({ ...empty })}>+ New</button>} />
      {draft && (
        <Card className="mb-4 flex flex-col gap-3">
          <h2 className="font-semibold">{draft.id ? 'Edit coupon' : 'New coupon'}</h2>
          <Field label="Code" hint="What customers type at checkout"><Input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })} placeholder="DIWALI10" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type"><Select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as any, value: '' })}><option value="PERCENT">% off</option><option value="FLAT">₹ off</option></Select></Field>
            <Field label={draft.type === 'PERCENT' ? 'Percent off' : 'Rupees off'}><Input inputMode="decimal" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} placeholder={draft.type === 'PERCENT' ? '10' : '100'} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Minimum order (₹)" hint="Leave empty for none"><Input inputMode="decimal" value={draft.minOrder} onChange={(e) => setDraft({ ...draft, minOrder: e.target.value })} /></Field>
            <Field label="Max uses" hint="Leave empty for unlimited"><Input inputMode="numeric" value={draft.usageLimit} onChange={(e) => setDraft({ ...draft, usageLimit: e.target.value.replace(/\D/g, '') })} /></Field>
          </div>
          <Field label="Valid until" hint="Leave empty for no expiry"><Input type="date" value={draft.expiresAt} onChange={(e) => setDraft({ ...draft, expiresAt: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3"><button className="btn-secondary" onClick={() => setDraft(null)}>Cancel</button><button className="btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div>
        </Card>
      )}
      {error ? <ErrorBox message={error} retry={reload} /> : loading && !data ? <Spinner /> : !data.items.length ? <Empty title="No coupons yet" hint="Create a code like DIWALI10 to give customers a discount." /> : (
        <div className="flex flex-col gap-2">
          {data.items.map((c: any) => (
            <div key={c.id} className="card p-4 flex items-center gap-3">
              <button className="min-w-0 flex-1 text-left tap" onClick={() => edit(c)}>
                <div className="font-mono font-bold text-lg">{c.code}</div>
                <div className="text-sm text-ink-3">{c.type === 'PERCENT' ? `${c.value}% off` : `${rupees(c.value)} off`}{c.minOrder ? ` on orders above ${rupees(c.minOrder)}` : ''}{c.usageLimit ? ` · max ${c.usageLimit} uses` : ''}{c.expiresAt ? ` · until ${day(c.expiresAt)}` : ''}</div>
              </button>
              {c.expired ? <Badge tone="muted">Expired</Badge> : <Badge tone="ok">Active</Badge>}
              <button className="btn-ghost h-11 min-h-0 text-bad px-3" aria-label="Delete coupon" onClick={() => setDel(c)}>✕</button>
            </div>
          ))}
        </div>
      )}
      <Confirm open={!!del} onClose={() => setDel(null)} title={`Delete ${del?.code}?`} text="Customers will no longer be able to use it." confirmLabel="Delete" danger onConfirm={() => remove(del)} />
    </div>
  );
}
