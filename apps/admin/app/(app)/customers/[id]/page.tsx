'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { ORDER_STATUS } from '@/lib/labels';
import { rupees, when } from '@/lib/money';
import { Badge, Card, ErrorBox, PageTitle, Spinner, useLoad } from '@/components/ui';

export default function CustomerPage() {
  const { id } = useParams<{ id: string }>();
  const { data: c, error, loading, reload } = useLoad(() => api(`/store/customers/${id}`), [id]);
  if (error) return <ErrorBox message={error} retry={reload} />;
  if (loading && !c) return <Spinner />;
  const phone = c.phone?.replace(/\D/g, '');
  const full = phone?.length === 10 ? '91' + phone : phone;
  return (
    <div className="flex flex-col gap-4">
      <PageTitle title={c.name} back="/customers" sub={`${c.orderCount} order${c.orderCount === 1 ? '' : 's'} · ${rupees(c.spentPaise)} spent`} />
      <Card>
        <div className="text-sm text-ink-3">Phone</div><div className="font-medium">{c.phone}</div>
        {c.email && <><div className="text-sm text-ink-3 mt-2">Email</div><div className="font-medium">{c.email}</div></>}
        {Array.isArray(c.addresses) && c.addresses.length > 0 && <><div className="text-sm text-ink-3 mt-2">Address</div>{c.addresses.map((a: any, i: number) => <div key={i} className="font-medium whitespace-pre-line">{[a.line1, a.line2, [a.city, a.state, a.pincode].filter(Boolean).join(', ')].filter(Boolean).join('\n')}</div>)}</>}
        {phone && <div className="grid grid-cols-2 gap-2 mt-3"><a className="btn-secondary" href={`tel:+${full}`}>Call</a><a className="btn-secondary text-[#1f8f5a]" href={`https://wa.me/${full}`} target="_blank" rel="noopener noreferrer">WhatsApp</a></div>}
      </Card>
      <section>
        <h2 className="font-semibold text-lg mb-2">Orders</h2>
        {!c.orders.length ? <Card className="text-sm text-ink-3">No orders yet.</Card> : (
          <div className="flex flex-col gap-2">
            {c.orders.map((o: any) => (
              <Link key={o.id} href={`/orders/${o.id}`} className="card p-4 flex items-center gap-3 tap">
                <div className="min-w-0 flex-1"><div className="font-semibold">{o.orderNo}</div><div className="text-sm text-ink-3">{when(o.createdAt)}</div></div>
                <div className="text-right"><div className="font-semibold tabular-nums">{rupees(o.total)}</div><Badge tone={ORDER_STATUS[o.orderStatus]?.tone}>{ORDER_STATUS[o.orderStatus]?.label}</Badge></div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
