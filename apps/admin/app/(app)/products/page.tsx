'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { api, qs } from '@/lib/api';
import { PRODUCT_STATUS } from '@/lib/labels';
import { rupees } from '@/lib/money';
import { Badge, Chips, Confirm, Empty, ErrorBox, Input, PageTitle, Pager, Spinner, Thumb, useLoad, useToast } from '@/components/ui';

type Filter = 'all' | 'ACTIVE' | 'DRAFT' | 'ARCHIVED' | 'low';

function ProductsList() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>((params.get('filter') as Filter) || 'all');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const query = qs({ q, page, pageSize: 20, status: filter === 'all' || filter === 'low' ? undefined : filter, lowStock: filter === 'low' ? 'true' : undefined });
  const { data, error, loading, reload } = useLoad(() => api(`/store/products${query}`), [query]);
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const bulk = async (action: string) => {
    try {
      const r = await api('/store/products/bulk', { method: 'POST', json: { ids: [...selected], action } });
      toast.push(`${r.affected} product${r.affected === 1 ? '' : 's'} ${action === 'DELETE' ? 'deleted' : action === 'ACTIVATE' ? 'made live' : action === 'ARCHIVE' ? 'archived' : 'set to draft'}`);
      setSelected(new Set()); reload();
    } catch (e: any) { toast.push(e.message, 'bad'); }
  };
  return (
    <div>
      <PageTitle title="Products" sub={data ? `${data.total} in this view` : undefined} action={<Link href="/products/new" className="btn-primary">+ Add</Link>} />
      <div className="flex flex-col gap-3 mb-4">
        <Input type="search" placeholder="Search name or SKU" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <Chips value={filter} onChange={(f) => { setFilter(f); setPage(1); router.replace(f === 'all' ? '/products' : `/products?filter=${f}`); }} items={[{ value: 'all', label: 'All' }, { value: 'ACTIVE', label: 'Live' }, { value: 'DRAFT', label: 'Drafts' }, { value: 'low', label: 'Low stock' }, { value: 'ARCHIVED', label: 'Archived' }]} />
      </div>
      {error ? <ErrorBox message={error} retry={reload} /> : loading && !data ? <Spinner /> : !data.items.length ? (
        <Empty title={q ? 'Nothing matches that search' : 'No products yet'} hint={q ? 'Try another word or SKU' : 'Add one by hand or import a sheet'} action={!q && <div className="flex gap-2 justify-center"><Link href="/products/new" className="btn-primary">Add a product</Link><Link href="/import" className="btn-secondary">Import</Link></div>} />
      ) : (
        <div className="flex flex-col gap-2">
          {data.items.map((p: any) => (
            <div key={p.id} className={`card flex items-center gap-3 p-3 ${selected.has(p.id) ? 'border-brand ring-2 ring-brand/30' : ''}`}>
              <button type="button" aria-label={selected.has(p.id) ? 'Unselect' : 'Select'} onClick={() => toggle(p.id)} className={`h-11 w-11 shrink-0 rounded-xl border grid place-items-center ${selected.has(p.id) ? 'bg-brand border-brand text-white' : 'border-line text-transparent'}`}>✓</button>
              <Link href={`/products/${p.id}`} className="flex items-center gap-3 flex-1 min-w-0 tap">
                <Thumb src={p.images?.[0]} />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold truncate">{p.name}</div>
                  <div className="text-sm text-ink-3 flex flex-wrap gap-x-2">{rupees(p.price)}{p.mrp > p.price && <s className="text-ink-3/70">{rupees(p.mrp)}</s>}<span>·</span><span className={p.stock <= 0 ? 'text-bad font-medium' : ''}>{p.stock <= 0 ? 'Out of stock' : `${p.stock} in stock`}</span></div>
                </div>
                <Badge tone={p.status === 'ACTIVE' ? 'ok' : p.status === 'DRAFT' ? 'note' : 'muted'}>{PRODUCT_STATUS[p.status]}</Badge>
              </Link>
            </div>
          ))}
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </div>
      )}
      {selected.size > 0 && (
        <div className="fixed bottom-20 md:bottom-6 inset-x-4 md:left-72 md:right-8 z-40 card p-3 flex items-center gap-2 shadow-lg">
          <span className="font-semibold px-2 whitespace-nowrap">{selected.size} selected</span>
          <div className="flex gap-2 ml-auto overflow-x-auto">
            <button className="btn-secondary h-11 min-h-0" onClick={() => bulk('ACTIVATE')}>Make live</button>
            <button className="btn-secondary h-11 min-h-0" onClick={() => bulk('ARCHIVE')}>Archive</button>
            <button className="btn-danger h-11 min-h-0" onClick={() => setConfirmDelete(true)}>Delete</button>
          </div>
          <button className="btn-ghost h-11 min-h-0" onClick={() => setSelected(new Set())} aria-label="Clear selection">✕</button>
        </div>
      )}
      <Confirm open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete ${selected.size} product${selected.size === 1 ? '' : 's'}?`} text="This cannot be undone. Archiving hides a product but keeps it." confirmLabel="Delete" danger onConfirm={() => bulk('DELETE')} />
    </div>
  );
}
export default function ProductsPage() { return <Suspense><ProductsList /></Suspense>; }
