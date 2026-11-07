'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Confirm, Empty, ErrorBox, Field, Input, PageTitle, Spinner, useLoad, useToast } from '@/components/ui';

export default function PagesPage() {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(() => api('/store/pages?pageSize=100'), []);
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<any>(null);
  const create = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try { await api('/store/pages', { method: 'POST', json: { title: title.trim(), content: '' } }); setTitle(''); setCreating(false); toast.push('Page created'); reload(); } catch (e: any) { toast.push(e.message, 'bad'); } finally { setBusy(false); }
  };
  const policies = async () => { setBusy(true); try { await api('/store/pages/policies', { method: 'POST' }); toast.push('Policy pages are ready to fill in'); reload(); } catch (e: any) { toast.push(e.message, 'bad'); } finally { setBusy(false); } };
  const remove = async (p: any) => { try { await api(`/store/pages/${p.id}`, { method: 'DELETE' }); toast.push('Page deleted'); reload(); } catch (e: any) { toast.push(e.message, 'bad'); } };
  const items: any[] = data?.items ?? [];
  const hasPolicies = items.some((p) => p.isPolicy);
  return (
    <div>
      <PageTitle title="Pages" sub="About, policies, contact…" action={<button className="btn-primary" onClick={() => setCreating(true)}>+ New</button>} />
      {creating && (
        <div className="card p-4 mb-4 flex flex-col gap-3">
          <Field label="Page title"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="About us" autoFocus /></Field>
          <div className="grid grid-cols-2 gap-3"><button className="btn-secondary" onClick={() => setCreating(false)}>Cancel</button><button className="btn-primary" disabled={busy || !title.trim()} onClick={create}>Create</button></div>
        </div>
      )}
      {!hasPolicies && !loading && (
        <div className="card p-4 mb-4 bg-note-soft border-note/30">
          <p className="font-semibold text-note">Policy pages are missing</p>
          <p className="text-sm text-ink-2 mt-1">Online stores in India need privacy, terms, shipping, refund and contact pages. Create the five standard pages and fill them in.</p>
          <button className="btn-secondary mt-3 w-full" disabled={busy} onClick={policies}>Create policy pages</button>
        </div>
      )}
      {error ? <ErrorBox message={error} retry={reload} /> : loading && !data ? <Spinner /> : !items.length ? <Empty title="No pages yet" /> : (
        <div className="flex flex-col gap-2">
          {items.map((p) => (
            <div key={p.id} className="card p-4 flex items-center gap-3">
              <Link href={`/pages/${p.id}`} className="min-w-0 flex-1 tap flex items-center"><div><div className="font-semibold">{p.title}</div><div className="text-sm text-ink-3">/{p.slug}</div></div></Link>
              {p.isPolicy && <Badge tone="work">Policy</Badge>}
              <button className="btn-ghost h-11 min-h-0 text-bad px-3" aria-label="Delete page" onClick={() => setDel(p)}>✕</button>
            </div>
          ))}
        </div>
      )}
      <Confirm open={!!del} onClose={() => setDel(null)} title={`Delete "${del?.title}"?`} confirmLabel="Delete" danger onConfirm={() => remove(del)} />
    </div>
  );
}
