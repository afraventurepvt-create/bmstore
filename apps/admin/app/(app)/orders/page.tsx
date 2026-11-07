'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { api, qs } from '@/lib/api';
import { ORDER_STATUS, PAYMENT_MODE } from '@/lib/labels';
import { rupees, when } from '@/lib/money';
import { Badge, Chips, Empty, ErrorBox, Input, PageTitle, Pager, Spinner, useLoad } from '@/components/ui';

type Filter = 'open' | 'all' | 'PENDING' | 'CONFIRMED' | 'PACKED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'cod';

function OrdersList() {
  const params = useSearchParams();
  const [filter, setFilter] = useState<Filter>((params.get('filter') as Filter) || 'open');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const query = qs({
    q, page, pageSize: 20,
    open: filter === 'open' ? 'true' : undefined,
    status: ['open', 'all', 'cod'].includes(filter) ? (filter === 'cod' ? 'DELIVERED' : undefined) : filter,
    paymentMode: filter === 'cod' ? 'COD' : undefined, paymentStatus: filter === 'cod' ? 'PENDING' : undefined,
  });
  const { data, error, loading, reload } = useLoad(() => api(`/store/orders${query}`), [query]);
  return (
    <div>
      <PageTitle title="Orders" sub={data ? `${data.total} in this view` : undefined} />
      <div className="flex flex-col gap-3 mb-4">
        <Input type="search" inputMode="search" placeholder="Order number, customer name or phone" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <Chips value={filter} onChange={(f) => { setFilter(f); setPage(1); }} items={[{ value: 'open', label: 'Open' }, { value: 'PENDING', label: 'New' }, { value: 'PACKED', label: 'Packed' }, { value: 'SHIPPED', label: 'Shipped' }, { value: 'cod', label: 'COD to collect' }, { value: 'DELIVERED', label: 'Delivered' }, { value: 'CANCELLED', label: 'Cancelled' }, { value: 'all', label: 'All' }]} />
      </div>
      {error ? <ErrorBox message={error} retry={reload} /> : loading && !data ? <Spinner /> : !data.items.length ? (
        <Empty title={filter === 'open' ? 'No open orders' : 'No orders here'} hint={filter === 'open' ? 'New orders from your store will appear here.' : 'Try another filter.'} />
      ) : (
        <div className="flex flex-col gap-2">
          {data.items.map((o: any) => (
            <Link key={o.id} href={`/orders/${o.id}`} className="card p-4 flex items-center gap-3 tap">
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{o.orderNo} <span className="text-ink-3 font-normal">· {o.customer?.name}</span></div>
                <div className="text-sm text-ink-3">{when(o.createdAt)} · {PAYMENT_MODE[o.paymentMode]}{o.paymentStatus === 'PAID' ? ' · paid' : ''}</div>
              </div>
              <div className="text-right"><div className="font-semibold tabular-nums">{rupees(o.total)}</div><Badge tone={ORDER_STATUS[o.orderStatus]?.tone}>{ORDER_STATUS[o.orderStatus]?.label}</Badge></div>
            </Link>
          ))}
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </div>
      )}
    </div>
  );
}
export default function OrdersPage() { return <Suspense><OrdersList /></Suspense>; }
