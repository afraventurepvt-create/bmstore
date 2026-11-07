'use client';
import Link from 'next/link';
import { api } from '@/lib/api';
import { ORDER_STATUS } from '@/lib/labels';
import { rupees, when } from '@/lib/money';
import { Badge, Card, ErrorBox, Spinner, useLoad } from '@/components/ui';

export default function Dashboard() {
  const dash = useLoad(() => api('/store/dashboard'), []);
  const orders = useLoad(() => api('/store/orders?open=true&pageSize=5'), []);
  const low = useLoad(() => api('/store/products?lowStock=true&pageSize=5'), []);
  const greeting = (() => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; })();
  if (dash.error) return <ErrorBox message={dash.error} retry={dash.reload} />;
  const d = dash.data;
  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-ink-3">{greeting}</p>
        <h1 className="text-2xl font-bold">Today</h1>
      </div>
      {!d ? <Spinner /> : (
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Orders today" value={String(d.today.orders)} />
          <Stat label="Sales today" value={rupees(d.today.salesPaise)} />
          <Link href="/orders?filter=open" className="contents"><Stat label="To pack" value={String(d.toPack)} tone={d.toPack ? 'accent' : undefined} hint={d.toPack ? 'Tap to see them' : 'All caught up'} /></Link>
          <Link href="/products?filter=low" className="contents"><Stat label="Low stock" value={String(d.lowStock)} tone={d.lowStock ? 'bad' : undefined} hint={d.lowStock ? 'Tap to restock' : 'Looking good'} /></Link>
        </div>
      )}
      {d && d.codToCollect > 0 && (
        <Link href="/orders?filter=cod" className="card p-4 flex items-center justify-between gap-3 border-accent/30 bg-accent-soft">
          <span><span className="font-semibold">{d.codToCollect} delivered COD order{d.codToCollect > 1 ? 's' : ''}</span> still marked as payment due</span><span className="text-accent font-semibold">Mark paid ›</span>
        </Link>
      )}
      <section>
        <div className="flex items-center justify-between mb-2"><h2 className="font-semibold text-lg">Open orders</h2><Link href="/orders" className="text-brand font-medium text-sm tap inline-flex items-center">See all</Link></div>
        {orders.loading ? <Spinner /> : !orders.data?.items?.length ? <Card className="text-ink-3 text-sm">No open orders. New orders will show up here.</Card> : (
          <div className="flex flex-col gap-2">
            {orders.data.items.map((o: any) => (
              <Link key={o.id} href={`/orders/${o.id}`} className="card p-4 flex items-center gap-3 tap">
                <div className="min-w-0 flex-1"><div className="font-semibold">{o.orderNo} <span className="text-ink-3 font-normal">· {o.customer?.name}</span></div><div className="text-sm text-ink-3">{when(o.createdAt)} · {rupees(o.total)}</div></div>
                <Badge tone={ORDER_STATUS[o.orderStatus]?.tone}>{ORDER_STATUS[o.orderStatus]?.label ?? o.orderStatus}</Badge>
              </Link>
            ))}
          </div>
        )}
      </section>
      {low.data?.items?.length ? (
        <section>
          <div className="flex items-center justify-between mb-2"><h2 className="font-semibold text-lg">Running low</h2><Link href="/products?filter=low" className="text-brand font-medium text-sm tap inline-flex items-center">See all</Link></div>
          <div className="flex flex-col gap-2">
            {low.data.items.map((p: any) => (
              <Link key={p.id} href={`/products/${p.id}`} className="card p-4 flex items-center gap-3 tap">
                <Thumb src={p.images?.[0]} />
                <div className="min-w-0 flex-1"><div className="font-semibold truncate">{p.name}</div><div className="text-sm text-bad">{p.stock === 0 ? 'Out of stock' : `Only ${p.stock} left`}</div></div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'accent' | 'bad' }) {
  return (
    <div className={`card p-4 ${tone === 'accent' ? 'border-accent/40' : tone === 'bad' ? 'border-bad/40' : ''}`}>
      <div className="text-sm text-ink-3">{label}</div>
      <div className={`text-3xl font-bold mt-1 tabular-nums ${tone === 'accent' ? 'text-accent' : tone === 'bad' ? 'text-bad' : ''}`}>{value}</div>
      {hint && <div className="text-xs text-ink-3 mt-1">{hint}</div>}
    </div>
  );
}
export function Thumb({ src, size = 'h-12 w-12' }: { src?: string | null; size?: string }) {
  return src ? <img src={src.replace(/\.webp$/, '_thumb.webp')} alt="" className={`${size} rounded-xl object-cover bg-paper shrink-0`} onError={(e) => { (e.target as HTMLImageElement).src = src; }} /> : <div className={`${size} rounded-xl bg-paper border border-line shrink-0 grid place-items-center text-ink-3`}><svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 16 5-5 4 4 3-3 6 6"/><circle cx="16" cy="9" r="1.5"/></svg></div>;
}
