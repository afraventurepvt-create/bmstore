'use client';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ErrorBox, Field, Input, PageTitle, Spinner, Textarea, Toggle, useLoad, useToast } from '@/components/ui';

export default function EditPagePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(() => api(`/store/pages/${id}`), [id]);
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [content, setContent] = useState('');
  const [isPolicy, setPolicy] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) { setTitle(data.title); setSlug(data.slug); setContent(data.content); setPolicy(data.isPolicy); } }, [data]);
  const save = async () => {
    setBusy(true);
    try { await api(`/store/pages/${id}`, { method: 'PATCH', json: { title, slug, content, isPolicy } }); toast.push('Page saved'); router.refresh(); } catch (e: any) { toast.push(e.message, 'bad'); } finally { setBusy(false); }
  };
  if (error) return <ErrorBox message={error} retry={reload} />;
  if (loading && !data) return <Spinner />;
  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <PageTitle title={data.title} back="/pages" />
      <div className="card p-4 flex flex-col gap-4">
        <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="Web address" hint={`yourstore.com/${slug || '…'}`}><Input value={slug} onChange={(e) => setSlug(e.target.value)} /></Field>
        <Field label="Content" hint="Plain text or simple HTML"><Textarea value={content} onChange={(e) => setContent(e.target.value)} className="min-h-72" /></Field>
        <Toggle checked={isPolicy} onChange={setPolicy} label="This is a policy page" hint="Shown in the footer of your store" />
      </div>
      <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save page'}</button>
    </form>
  );
}
