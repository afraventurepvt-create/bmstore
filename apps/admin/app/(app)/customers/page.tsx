'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, qs } from '@/lib/api';
import { day, rupees } from '@/lib/money';
import { Empty, ErrorBox, Input, PageTitle, Pager, Spinner, useLoad } from '@/components/ui';

export default function CustomersPage() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const query = qs({ q, page, pageSize: 25 });
  const { data, error, loading, reload } = useLoad(() => api(`/store/customers${query}`), [query]);
  return (
    <div>
      <PageTitle title="Customers" sub={data ? `${data.total} total` : undefined} />
      <Input type="search" placeholder="Name, phone or email" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="mb-4" />
      {error ? <ErrorBox message={error} retry={reload} /> : loading && !data ? <Spinner /> : !data.items.length ? <Empty title={q ? 'No one matches' : 'No customers yet'} hint="Customers appear here after their first order." /> : (
        <div className="flex flex-col gap-2">
          {data.items.map((c: any) => (
            <Link key={c.id} href={`/customers/${c.id}`} className="card p-4 flex items-center gap-3 tap">
              <div className="h-11 w-11 rounded-full bg-brand-soft text-brand grid place-items-center font-bold shrink-0">{c.name.slice(0, 1).toUpperCase()}</div>
              <div className="min-w-0 flex-1"><div className="font-semibold truncate">{c.name}</div><div className="text-sm text-ink-3">{c.phone}{c.lastOrderAt ? ` · last order ${day(c.lastOrderAt)}` : ''}</div></div>
              <div className="text-right text-sm"><div className="font-semibold tabular-nums">{rupees(c.spentPaise)}</div><div className="text-ink-3">{c.orderCount} order{c.orderCount === 1 ? '' : 's'}</div></div>
            </Link>
          ))}
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </div>
      )}
    </div>
  );
}
