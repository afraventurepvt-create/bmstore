'use client';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { NEXT_STATUS, ORDER_STATUS, PAYMENT_MODE, PAYMENT_STATUS } from '@/lib/labels';
import { rupees, when } from '@/lib/money';
import { Badge, Card, Confirm, ErrorBox, PageTitle, Spinner, Thumb, useLoad, useToast } from '@/components/ui';

export default function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { data: o, error, loading, reload, setData } = useLoad(() => api(`/store/orders/${id}`), [id]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ to: string; label: string } | null>(null);
  const move = async (to: string) => {
    setBusy(true);
    try { setData(await api(`/store/orders/${id}/status`, { method: 'POST', json: { status: to } })); toast.push(`Order ${ORDER_STATUS[to].label.toLowerCase()}`); reload(); }
    catch (e: any) { toast.push(e.message, 'bad'); } finally { setBusy(false); }
  };
  const markPaid = async () => {
    setBusy(true);
    try { setData(await api(`/store/orders/${id}/mark-paid`, { method: 'POST' })); toast.push('Marked as paid'); reload(); }
    catch (e: any) { toast.push(e.message, 'bad'); } finally { setBusy(false); }
  };
  if (error) return <ErrorBox message={error} retry={reload} />;
  if (loading && !o) return <Spinner />;
  const addr = o.address ?? {};
  const phone = o.customer?.phone?.replace(/\D/g, '');
  const next = NEXT_STATUS[o.orderStatus] ?? [];
  return (
    <div className="flex flex-col gap-4">
      <PageTitle title={o.orderNo} back="/orders" sub={when(o.createdAt)} action={<Badge tone={ORDER_STATUS[o.orderStatus]?.tone}>{ORDER_STATUS[o.orderStatus]?.label}</Badge>} />

      {next.length > 0 && (
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(next.length, 2)}, minmax(0, 1fr))` }}>
          {next.map((n) => <button key={n.to} disabled={busy} className={n.primary ? 'btn-primary' : n.to === 'CANCELLED' ? 'btn-danger' : 'btn-secondary'} onClick={() => (n.to === 'CANCELLED' || n.to === 'RETURNED' ? setConfirm(n) : move(n.to))}>{n.label}</button>)}
        </div>
      )}
      {o.paymentMode === 'COD' && o.paymentStatus === 'PENDING' && (
        <button disabled={busy} className="btn-secondary border-accent/40 text-accent" onClick={markPaid}>₹ Cash collected, mark as paid</button>
      )}

      <Card>
        <h2 className="font-semibold mb-3">Items</h2>
        <ul className="divide-y divide-line">
          {o.items.map((it: any, i: number) => (
            <li key={i} className="flex items-center gap-3 py-3">
              <Thumb src={it.image} />
              <div className="min-w-0 flex-1"><div className="font-medium truncate">{it.name}</div><div className="text-sm text-ink-3">{it.qty} × {rupees(it.unitPrice)}{it.sku ? ` · ${it.sku}` : ''}</div></div>
              <div className="font-semibold tabular-nums">{rupees(it.total)}</div>
            </li>
          ))}
        </ul>
        <dl className="mt-3 text-sm grid grid-cols-2 gap-y-1">
          <dt className="text-ink-3">Items</dt><dd className="text-right tabular-nums">{rupees(o.subtotal)}</dd>
          <dt className="text-ink-3">Shipping</dt><dd className="text-right tabular-nums">{o.shipping ? rupees(o.shipping) : 'Free'}</dd>
          {o.tax > 0 && <><dt className="text-ink-3">Tax</dt><dd className="text-right tabular-nums">{rupees(o.tax)}</dd></>}
          <dt className="font-semibold text-base pt-1">Total</dt><dd className="text-right font-bold text-base pt-1 tabular-nums">{rupees(o.total)}</dd>
        </dl>
        <div className="mt-3 flex items-center justify-between text-sm"><span className="text-ink-3">{PAYMENT_MODE[o.paymentMode]}</span><Badge tone={o.paymentStatus === 'PAID' ? 'ok' : o.paymentStatus === 'PENDING' ? 'note' : 'muted'}>{PAYMENT_STATUS[o.paymentStatus]}</Badge></div>
      </Card>

      <Card>
        <h2 className="font-semibold mb-2">Customer</h2>
        <div className="font-medium">{o.customer?.name}</div>
        <div className="text-sm text-ink-2 whitespace-pre-line">{[addr.line1, addr.line2, [addr.city, addr.state, addr.pincode].filter(Boolean).join(', ')].filter(Boolean).join('\n')}</div>
        {phone && (
          <div className="grid grid-cols-2 gap-2 mt-3">
            <a className="btn-secondary" href={`tel:+${phone.length === 10 ? '91' + phone : phone}`}>Call</a>
            <a className="btn-secondary text-[#1f8f5a]" href={`https://wa.me/${phone.length === 10 ? '91' + phone : phone}?text=${encodeURIComponent(`Hi ${o.customer?.name}, about your order ${o.orderNo}: `)}`} target="_blank" rel="noopener noreferrer">WhatsApp</a>
          </div>
        )}
      </Card>

      {o.history?.length > 0 && (
        <Card>
          <h2 className="font-semibold mb-2">History</h2>
          <ul className="text-sm flex flex-col gap-1">
            {o.history.map((h: any, i: number) => <li key={i} className="flex justify-between gap-3"><span>{h.action === 'order.payment' ? `Payment: ${PAYMENT_STATUS[h.meta?.to] ?? h.meta?.to}` : `${ORDER_STATUS[h.meta?.to]?.label ?? h.meta?.to}`}{h.meta?.note ? ` · ${h.meta.note}` : ''}</span><span className="text-ink-3 whitespace-nowrap">{when(h.at)}</span></li>)}
          </ul>
        </Card>
      )}
      <Confirm open={!!confirm} onClose={() => setConfirm(null)} title={confirm?.to === 'CANCELLED' ? 'Cancel this order?' : 'Mark as returned?'} text="Stock for the items goes back into your inventory." confirmLabel={confirm?.label ?? 'Yes'} danger={confirm?.to === 'CANCELLED'} onConfirm={() => confirm && move(confirm.to)} />
    </div>
  );
}
