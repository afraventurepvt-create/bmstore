'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { WhatsAppButton } from '@/components/shell';
import { PageTitle, useLoad } from '@/components/ui';

const ITEMS = [
  { href: '/customers', label: 'Customers', hint: 'Who buys from you' },
  { href: '/import', label: 'Import products', hint: 'From a CSV or Excel sheet' },
  { href: '/coupons', label: 'Coupons', hint: 'Discount codes' },
  { href: '/pages', label: 'Pages', hint: 'About, policies, contact' },
  { href: '/settings', label: 'Settings', hint: 'Shipping, COD, store details' },
  { href: '/settings/theme', label: 'Look & logo', hint: 'Colours and branding' },
];

export default function MorePage() {
  const router = useRouter();
  const { data: me } = useLoad(() => api('/auth/me'), []);
  const logout = async () => { await fetch('/api/auth/logout', { method: 'POST' }); router.replace('/login'); };
  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="More" sub={me ? `Signed in as ${me.role === 'store_owner' ? 'owner' : 'staff'}` : undefined} />
      <div className="flex flex-col gap-2">
        {ITEMS.map((i) => <Link key={i.href} href={i.href} className="card p-4 tap flex items-center gap-3"><div className="flex-1"><div className="font-semibold">{i.label}</div><div className="text-sm text-ink-3">{i.hint}</div></div><span className="text-ink-3">›</span></Link>)}
      </div>
      <WhatsAppButton />
      <button type="button" onClick={logout} className="btn-secondary">Sign out</button>
    </div>
  );
}
