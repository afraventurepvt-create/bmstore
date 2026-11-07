'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fromPaise, mb, num, toPaise } from '@/lib/money';
import { Card, ErrorBox, Field, Input, PageTitle, Select, Spinner, Toggle, useLoad, useToast } from '@/components/ui';

export default function SettingsPage() {
  const toast = useToast();
  const settings = useLoad(() => api('/store/settings'), []);
  const profile = useLoad(() => api('/store/profile'), []);
  const usage = useLoad(() => api('/store/usage'), []);
  const [s, setS] = useState<any>(null);
  const [p, setP] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { if (settings.data) setS({ ...settings.data, flatRate: fromPaise(settings.data.flatRate), freeAbove: settings.data.freeAbove === null ? '' : fromPaise(settings.data.freeAbove), codCharge: fromPaise(settings.data.codCharge), cityRates: settings.data.cityRates.map((c: any) => ({ city: c.city, rate: fromPaise(c.ratePaise) })) }); }, [settings.data]);
  useEffect(() => { if (profile.data) setP({ name: profile.data.name, address: profile.data.address ?? '', gstNumber: profile.data.gstNumber ?? '', supportPhone: profile.data.supportPhone ?? '', whatsappNumber: profile.data.whatsappNumber ?? '' }); }, [profile.data]);

  const saveShipping = async () => {
    const flatRate = toPaise(s.flatRate || '0'); const codCharge = toPaise(s.codCharge || '0'); const freeAbove = s.freeAbove === '' ? null : toPaise(s.freeAbove);
    if (flatRate === null || codCharge === null || freeAbove === undefined) return toast.push('Amounts must be in rupees, e.g. 49 or 49.50', 'bad');
    const cityRates = s.cityRates.filter((c: any) => c.city.trim()).map((c: any) => ({ city: c.city.trim(), ratePaise: toPaise(c.rate || '0') ?? 0 }));
    setBusy('shipping');
    try { await api('/store/settings', { method: 'PUT', json: { shippingMode: s.shippingMode, flatRate, freeAbove, codEnabled: s.codEnabled, codCharge, orderPrefix: s.orderPrefix, lowStockThreshold: Number(s.lowStockThreshold) || 0, cityRates } }); toast.push('Settings saved'); settings.reload(); }
    catch (e: any) { toast.push(e.message, 'bad'); } finally { setBusy(null); }
  };
  const saveProfile = async () => {
    setBusy('profile');
    try { await api('/store/profile', { method: 'PATCH', json: { name: p.name, address: p.address || null, gstNumber: p.gstNumber || null, supportPhone: p.supportPhone || null, whatsappNumber: p.whatsappNumber || null } }); toast.push('Store details saved'); profile.reload(); }
    catch (e: any) { toast.push(e.message, 'bad'); } finally { setBusy(null); }
  };
  if (settings.error) return <ErrorBox message={settings.error} retry={settings.reload} />;
  if (!s || !p) return <Spinner />;
  const u = usage.data;
  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="Settings" action={<Link href="/settings/theme" className="btn-secondary">Look &amp; logo</Link>} />

      <Card className="flex flex-col gap-4">
        <h2 className="font-semibold text-lg">Shipping</h2>
        <Field label="How do you charge for shipping?">
          <Select value={s.shippingMode} onChange={(e) => setS({ ...s, shippingMode: e.target.value })}><option value="FLAT">Same rate for every order</option><option value="FREE_ABOVE">Free above an order value</option><option value="FREE">Always free</option></Select>
        </Field>
        {s.shippingMode !== 'FREE' && <Field label="Shipping charge (₹)"><Input inputMode="decimal" value={s.flatRate} onChange={(e) => setS({ ...s, flatRate: e.target.value })} /></Field>}
        {s.shippingMode === 'FREE_ABOVE' && <Field label="Free when the order is above (₹)"><Input inputMode="decimal" value={s.freeAbove} onChange={(e) => setS({ ...s, freeAbove: e.target.value })} placeholder="999" /></Field>}
        {s.shippingMode !== 'FREE' && (
          <div>
            <div className="label">Different rate for some cities</div>
            <div className="flex flex-col gap-2">
              {s.cityRates.map((c: any, i: number) => (
                <div key={i} className="grid grid-cols-[1fr_6rem_3rem] gap-2 items-center">
                  <Input placeholder="City" value={c.city} onChange={(e) => setS({ ...s, cityRates: s.cityRates.map((x: any, j: number) => (j === i ? { ...x, city: e.target.value } : x)) })} />
                  <Input inputMode="decimal" placeholder="₹" value={c.rate} onChange={(e) => setS({ ...s, cityRates: s.cityRates.map((x: any, j: number) => (j === i ? { ...x, rate: e.target.value } : x)) })} />
                  <button type="button" className="btn-ghost h-12 min-h-0 px-0 text-bad" aria-label="Remove city" onClick={() => setS({ ...s, cityRates: s.cityRates.filter((_: any, j: number) => j !== i) })}>✕</button>
                </div>
              ))}
              <button type="button" className="btn-ghost h-11 min-h-0 self-start" onClick={() => setS({ ...s, cityRates: [...s.cityRates, { city: '', rate: '' }] })}>+ Add a city</button>
            </div>
          </div>
        )}
        <Toggle checked={s.codEnabled} onChange={(v) => setS({ ...s, codEnabled: v })} label="Cash on delivery" hint={s.codEnabled ? 'Customers can pay when the parcel arrives' : 'Online payment only'} />
        {s.codEnabled && <Field label="Extra charge for COD (₹)" hint="0 for none"><Input inputMode="decimal" value={s.codCharge} onChange={(e) => setS({ ...s, codCharge: e.target.value })} /></Field>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Order number prefix" hint={`e.g. ${s.orderPrefix || 'ORD'}-1042`}><Input value={s.orderPrefix} onChange={(e) => setS({ ...s, orderPrefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) })} /></Field>
          <Field label="Low stock alert at" hint="Items or fewer"><Input inputMode="numeric" value={String(s.lowStockThreshold)} onChange={(e) => setS({ ...s, lowStockThreshold: e.target.value.replace(/\D/g, '') })} /></Field>
        </div>
        <button className="btn-primary" disabled={busy === 'shipping'} onClick={saveShipping}>{busy === 'shipping' ? 'Saving…' : 'Save shipping & orders'}</button>
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="font-semibold text-lg">Store details</h2>
        <Field label="Store name"><Input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></Field>
        <Field label="Address" hint="Shown on invoices and the contact page"><Input value={p.address} onChange={(e) => setP({ ...p, address: e.target.value })} /></Field>
        <Field label="GST number" hint="15 characters, leave empty if not registered"><Input value={p.gstNumber} onChange={(e) => setP({ ...p, gstNumber: e.target.value.toUpperCase() })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Support phone"><Input inputMode="tel" value={p.supportPhone} onChange={(e) => setP({ ...p, supportPhone: e.target.value })} /></Field>
          <Field label="WhatsApp number"><Input inputMode="tel" value={p.whatsappNumber} onChange={(e) => setP({ ...p, whatsappNumber: e.target.value })} /></Field>
        </div>
        <button className="btn-primary" disabled={busy === 'profile'} onClick={saveProfile}>{busy === 'profile' ? 'Saving…' : 'Save store details'}</button>
      </Card>

      {u && (
        <Card>
          <h2 className="font-semibold text-lg mb-3">Your plan: {u.plan === 'STARTER' ? 'Starter' : 'Standard'}</h2>
          <Meter label="Products" used={u.products.liveLimit ? u.products.live : u.products.used} limit={u.products.liveLimit ?? u.products.limit} text={u.products.liveLimit ? `${u.products.live} of ${u.products.liveLimit} live products` : `${num(u.products.used)} of ${num(u.products.limit)} products`} />
          <Meter label="Photos" used={u.media.usedBytes} limit={u.media.limitBytes} text={`${mb(u.media.usedBytes)} of ${u.media.limitMb >= 1024 ? (u.media.limitMb / 1024).toFixed(0) + ' GB' : u.media.limitMb + ' MB'}`} />
        </Card>
      )}
    </div>
  );
}
function Meter({ label, used, limit, text }: { label: string; used: number; limit: number; text: string }) {
  const pct = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  return (
    <div className="mb-3">
      <div className="flex justify-between text-sm mb-1"><span className="font-medium">{label}</span><span className="text-ink-3">{text}</span></div>
      <div className="h-2.5 rounded-full bg-paper border border-line overflow-hidden"><div className={`h-full rounded-full ${pct >= 90 ? 'bg-bad' : pct >= 70 ? 'bg-accent' : 'bg-brand'}`} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}
