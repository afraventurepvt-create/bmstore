'use client';
import { useEffect, useRef, useState } from 'react';
import { api, uploadImages } from '@/lib/api';
import { Card, ErrorBox, Field, Input, PageTitle, Select, Spinner, useLoad, useToast } from '@/components/ui';

const PALETTES = [
  { id: 'classic', name: 'Classic', primary: '#111827', secondary: '#6b7280' },
  { id: 'teal', name: 'Teal', primary: '#0f766e', secondary: '#c9731a' },
  { id: 'maroon', name: 'Maroon', primary: '#7f1d1d', secondary: '#b45309' },
  { id: 'indigo', name: 'Indigo', primary: '#3730a3', secondary: '#db2777' },
  { id: 'forest', name: 'Forest', primary: '#14532d', secondary: '#ca8a04' },
];

export default function ThemePage() {
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(() => api('/store/theme'), []);
  const [t, setT] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (data) setT(data); }, [data]);
  const save = async () => {
    setBusy(true);
    try { await api('/store/theme', { method: 'PUT', json: { paletteId: t.paletteId, primaryColor: t.primaryColor, secondaryColor: t.secondaryColor, fontPairId: t.fontPairId, headerStyle: t.headerStyle, cardStyle: t.cardStyle, logoUrl: t.logoUrl || null } }); toast.push('Look saved'); reload(); }
    catch (e: any) { toast.push(e.message, 'bad'); } finally { setBusy(false); }
  };
  const pickLogo = async (files: FileList | null) => {
    if (!files?.[0]) return;
    setUploading(true);
    try { const [m] = await uploadImages([files[0]], 'logo'); setT({ ...t, logoUrl: m.url }); toast.push('Logo uploaded. Save to keep it.'); } catch (e: any) { toast.push(e.message, 'bad'); } finally { setUploading(false); if (ref.current) ref.current.value = ''; }
  };
  if (error) return <ErrorBox message={error} retry={reload} />;
  if (!t) return <Spinner />;
  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="Look & logo" back="/settings" />
      <Card className="flex flex-col gap-4">
        <div className="flex items-center gap-4">
          {t.logoUrl ? <img src={t.logoUrl} alt="Logo" className="h-20 w-20 rounded-2xl object-cover bg-paper border border-line" /> : <div className="h-20 w-20 rounded-2xl bg-paper border border-dashed border-line grid place-items-center text-ink-3 text-sm">No logo</div>}
          <div className="flex flex-col gap-2">
            <button type="button" className="btn-secondary" disabled={uploading} onClick={() => ref.current?.click()}>{uploading ? 'Uploading…' : t.logoUrl ? 'Change logo' : 'Upload logo'}</button>
            {t.logoUrl && <button type="button" className="btn-ghost text-bad h-10 min-h-0" onClick={() => setT({ ...t, logoUrl: null })}>Remove</button>}
          </div>
          <input ref={ref} type="file" accept="image/*" className="hidden" onChange={(e) => pickLogo(e.target.files)} />
        </div>
        <p className="text-xs text-ink-3">A square image works best (at least 400×400).</p>
      </Card>
      <Card className="flex flex-col gap-4">
        <h2 className="font-semibold">Colours</h2>
        <div className="grid grid-cols-5 gap-2">
          {PALETTES.map((p) => (
            <button key={p.id} type="button" onClick={() => setT({ ...t, paletteId: p.id, primaryColor: p.primary, secondaryColor: p.secondary })} className={`rounded-xl border-2 p-1.5 ${t.paletteId === p.id ? 'border-ink' : 'border-line'}`} aria-label={p.name}>
              <div className="h-10 rounded-lg" style={{ background: `linear-gradient(135deg, ${p.primary} 60%, ${p.secondary} 60%)` }} />
              <div className="text-[11px] mt-1 text-center">{p.name}</div>
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Main colour"><div className="flex gap-2 items-center"><input type="color" value={t.primaryColor} onChange={(e) => setT({ ...t, primaryColor: e.target.value, paletteId: 'custom' })} className="h-12 w-14 rounded-xl border border-line bg-card p-1" /><Input value={t.primaryColor} onChange={(e) => setT({ ...t, primaryColor: e.target.value })} /></div></Field>
          <Field label="Accent colour"><div className="flex gap-2 items-center"><input type="color" value={t.secondaryColor} onChange={(e) => setT({ ...t, secondaryColor: e.target.value, paletteId: 'custom' })} className="h-12 w-14 rounded-xl border border-line bg-card p-1" /><Input value={t.secondaryColor} onChange={(e) => setT({ ...t, secondaryColor: e.target.value })} /></div></Field>
        </div>
        <div className="rounded-xl p-4 text-white" style={{ background: t.primaryColor }}><div className="font-bold">Preview</div><div className="text-sm opacity-90">Buttons and headings use the main colour</div><span className="inline-block mt-2 rounded-lg px-3 py-1.5 text-sm font-semibold" style={{ background: t.secondaryColor }}>Buy now</span></div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Fonts"><Select value={t.fontPairId} onChange={(e) => setT({ ...t, fontPairId: e.target.value })}><option value="modern">Modern</option><option value="classic">Classic</option><option value="friendly">Friendly</option></Select></Field>
          <Field label="Header"><Select value={t.headerStyle} onChange={(e) => setT({ ...t, headerStyle: e.target.value })}><option value="standard">Standard</option><option value="centered">Centered logo</option><option value="minimal">Minimal</option></Select></Field>
        </div>
      </Card>
      <button className="btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save look'}</button>
    </div>
  );
}
