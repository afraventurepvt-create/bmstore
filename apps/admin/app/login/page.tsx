'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Field, Input } from '@/components/ui';
import { WhatsAppButton } from '@/components/shell';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [store, setStore] = useState<any>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => { fetch('/api/store/public').then((r) => (r.ok ? r.json() : null)).then(setStore).catch(() => undefined); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        const ra = r.headers.get('retry-after');
        setError(r.status === 429 ? `Too many attempts. Please wait ${ra ? Math.ceil(Number(ra) / 60) + ' minute(s)' : 'a little'} and try again.` : r.status === 401 ? 'That email or password is not right.' : Array.isArray(b.message) ? b.message.join('. ') : b.message || 'Could not sign in.');
        return;
      }
      router.replace(params.get('next') || '/');
    } finally { setBusy(false); }
  };
  const sendReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/auth/forgot-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
      if (!r.ok) { setError('Could not send the email right now. Please try again in a minute.'); return; }
      setSent(true);
    } finally { setBusy(false); }
  };

  return (
    <main className="min-h-dvh flex flex-col justify-center px-5 py-10 max-w-md mx-auto">
      <div className="mb-8 text-center">
        {store?.theme?.logoUrl ? <img src={store.theme.logoUrl} alt="" className="mx-auto h-16 w-16 rounded-2xl object-cover mb-3" /> : <div className="mx-auto h-16 w-16 rounded-2xl bg-brand text-white grid place-items-center text-2xl font-bold mb-3">{(store?.name ?? 'S').slice(0, 1)}</div>}
        <h1 className="text-2xl font-bold">{store?.name ?? 'Store admin'}</h1>
        <p className="text-ink-3 mt-1">Sign in to manage your store</p>
      </div>
      {!forgot ? (
        <form onSubmit={submit} className="card p-5 flex flex-col gap-4">
          <Field label="Email"><Input type="email" inputMode="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></Field>
          <Field label="Password"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {error && <p className="text-sm text-bad bg-bad-soft rounded-xl px-3 py-2" role="alert">{error}</p>}
          <button className="btn-primary w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <button type="button" className="btn-ghost w-full" onClick={() => { setForgot(true); setError(null); }}>Forgot password?</button>
        </form>
      ) : (
        <form onSubmit={sendReset} className="card p-5 flex flex-col gap-4">
          <h2 className="font-semibold text-lg">Reset your password</h2>
          {sent ? (
            <p className="text-ink-2">If that email belongs to this store, a reset link is on its way. It works for 30 minutes.</p>
          ) : (
            <>
              <Field label="Email"><Input type="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
              {error && <p className="text-sm text-bad bg-bad-soft rounded-xl px-3 py-2" role="alert">{error}</p>}
              <button className="btn-primary w-full" disabled={busy}>Send reset link</button>
            </>
          )}
          <button type="button" className="btn-ghost w-full" onClick={() => { setForgot(false); setSent(false); }}>Back to sign in</button>
        </form>
      )}
      <div className="mt-6 flex flex-col items-center gap-3">
        <WhatsAppButton className="w-full" />
        <p className="text-xs text-ink-3">Stuck? Message us, we will sort it out.</p>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
