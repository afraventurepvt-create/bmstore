'use client';
import Link from 'next/link';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

// ---- toasts --------------------------------------------------------------------------------------
type Toast = { id: number; text: string; tone: 'ok' | 'bad' | 'note' };
const ToastCtx = createContext<{ push: (text: string, tone?: Toast['tone']) => void }>({ push: () => {} });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === 'bad' ? 6000 : 3500);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-4 pointer-events-none" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`pointer-events-auto max-w-md w-full rounded-xl px-4 py-3 text-sm font-medium shadow-card border ${t.tone === 'ok' ? 'bg-ok-soft text-ok border-ok/20' : t.tone === 'bad' ? 'bg-bad-soft text-bad border-bad/20' : 'bg-note-soft text-note border-note/20'}`}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---- primitives ----------------------------------------------------------------------------------
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card p-4 ${className}`}>{children}</div>;
}
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && !error && <span className="block mt-1 text-xs text-ink-3">{hint}</span>}
      {error && <span className="block mt-1 text-xs text-bad">{error}</span>}
    </label>
  );
}
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`field ${props.className ?? ''}`} />;
}
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`field py-3 min-h-28 ${props.className ?? ''}`} />;
}
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`field appearance-none pr-10 ${props.className ?? ''}`} style={{ backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' fill='none' stroke='%234b5563' stroke-width='2'><path d='m6 8 4 4 4-4'/></svg>\")", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 0.9rem center' }} />;
}
export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="w-full flex items-center justify-between gap-4 tap py-2 text-left">
      <span><span className="block font-medium">{label}</span>{hint && <span className="block text-sm text-ink-3">{hint}</span>}</span>
      <span className={`relative inline-flex h-8 w-14 shrink-0 rounded-full transition ${checked ? 'bg-brand' : 'bg-line'}`}><span className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition ${checked ? 'left-7' : 'left-1'}`} /></span>
    </button>
  );
}
export type Tone = 'new' | 'work' | 'ok' | 'bad' | 'muted' | 'accent' | 'note';
export function Badge({ tone = 'muted', children }: { tone?: Tone; children: ReactNode }) {
  const cls = { new: 'bg-accent-soft text-accent', work: 'bg-brand-soft text-brand', ok: 'bg-ok-soft text-ok', bad: 'bg-bad-soft text-bad', muted: 'bg-paper text-ink-2 border border-line', accent: 'bg-accent-soft text-accent', note: 'bg-note-soft text-note' }[tone];
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold whitespace-nowrap ${cls}`}>{children}</span>;
}
export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="card p-8 text-center">
      <p className="font-semibold">{title}</p>
      {hint && <p className="mt-1 text-sm text-ink-3">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <div className="flex items-center justify-center gap-3 py-12 text-ink-3" role="status"><span className="h-5 w-5 rounded-full border-2 border-line border-t-brand animate-spin" />{label}</div>;
}
export function PageTitle({ title, back, action, sub }: { title: string; back?: string; action?: ReactNode; sub?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 mb-4">
      <div className="min-w-0">
        {back && <Link href={back} className="inline-flex items-center gap-1 text-sm text-brand font-medium mb-1 tap -ml-1 pl-1 pr-2">‹ Back</Link>}
        <h1 className="text-2xl font-bold tracking-tight truncate">{title}</h1>
        {sub && <p className="text-sm text-ink-3 mt-0.5">{sub}</p>}
      </div>
      {action}
    </div>
  );
}
export function Chips<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: Array<{ value: T; label: string }> }) {
  return (
    <div className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1 [scrollbar-width:none]">
      {items.map((i) => <button key={i.value} type="button" onClick={() => onChange(i.value)} className={value === i.value ? 'chip-on' : 'chip'}>{i.label}</button>)}
    </div>
  );
}
export function Row({ href, onClick, children }: { href?: string; onClick?: () => void; children: ReactNode }) {
  const cls = 'card flex items-center gap-3 p-4 tap text-left w-full hover:border-brand/40 active:bg-paper';
  return href ? <Link href={href} className={cls}>{children}</Link> : <button type="button" onClick={onClick} className={cls}>{children}</button>;
}
export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-3 mt-4 text-sm">
      <button type="button" className="btn-secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ Previous</button>
      <span className="text-ink-3">Page {page} of {pages}</span>
      <button type="button" className="btn-secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next ›</button>
    </div>
  );
}
/** Simple data hook: loads once per key, exposes reload. */
export function useLoad<T = any>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    load().then((d) => { if (alive) { setData(d); setError(null); } }).catch((e) => { if (alive) setError(e.message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data: data as any, error, loading, reload: () => setTick((t) => t + 1), setData };
}
export function ErrorBox({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="card p-4 border-bad/30 bg-bad-soft text-bad text-sm flex items-center justify-between gap-3"><span>{message}</span>{retry && <button type="button" className="btn-secondary h-10 min-h-0" onClick={retry}>Retry</button>}</div>;
}
export function Confirm({ open, title, text, confirmLabel = 'Yes, do it', danger, onConfirm, onClose }: { open: boolean; title: string; text?: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div className="card w-full max-w-md p-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <h2 className="text-lg font-bold">{title}</h2>
        {text && <p className="mt-1 text-ink-2">{text}</p>}
        <div className="mt-5 grid grid-cols-2 gap-3">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className={danger ? 'btn-danger' : 'btn-primary'} onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
export function Thumb({ src, size = 'h-12 w-12' }: { src?: string | null; size?: string }) {
  return src ? <img src={src.replace(/\.webp$/, '_thumb.webp')} alt="" className={`${size} rounded-xl object-cover bg-paper shrink-0`} onError={(e) => { const el = e.target as HTMLImageElement; if (el.src !== src) el.src = src; }} /> : <div className={`${size} rounded-xl bg-paper border border-line shrink-0 grid place-items-center text-ink-3`}><svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 16 5-5 4 4 3-3 6 6"/><circle cx="16" cy="9" r="1.5"/></svg></div>;
}
