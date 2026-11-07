'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode } from 'react';
import { api } from '@/lib/api';
import { WHATSAPP_HELP } from '@/lib/labels';
import { ToastProvider, useLoad } from './ui';

const TABS = [
  { href: '/', label: 'Home', icon: 'M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z' },
  { href: '/orders', label: 'Orders', icon: 'M6 3h12l1 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7zM5 7h14M9 11a3 3 0 0 0 6 0' },
  { href: '/products', label: 'Products', icon: 'M4 7.5 12 3l8 4.5v9L12 21l-8-4.5zM4 7.5l8 4.5m0 0 8-4.5M12 12v9' },
  { href: '/more', label: 'More', icon: 'M5 12h.01M12 12h.01M19 12h.01' },
];
const SIDE = [...TABS.slice(0, 3), { href: '/customers', label: 'Customers' }, { href: '/coupons', label: 'Coupons' }, { href: '/pages', label: 'Pages' }, { href: '/import', label: 'Import products' }, { href: '/settings', label: 'Settings' }];

const WA_PATH = 'M12 2a10 10 0 0 0-8.6 15.1L2 22l5.1-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.6.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.3.1-.2 0-.3 0-.5l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.1.6 2.9.5a2.5 2.5 0 0 0 1.6-1.1 2 2 0 0 0 .1-1.1c0-.1-.2-.2-.4-.3z';

export function WhatsAppButton({ className = '' }: { className?: string }) {
  return (
    <a href={WHATSAPP_HELP} target="_blank" rel="noopener noreferrer" className={`btn bg-[#1f8f5a] text-white hover:bg-[#19744a] ${className}`}>
      <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden><path d={WA_PATH} /></svg>
      Get help on WhatsApp
    </a>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { data: profile } = useLoad(() => api('/store/profile'), []);
  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));
  const logout = async () => { await fetch('/api/auth/logout', { method: 'POST' }); router.replace('/login'); };
  return (
    <ToastProvider>
      <div className="min-h-dvh md:flex">
        <aside className="hidden md:flex md:w-64 md:flex-col md:border-r md:border-line md:bg-card md:p-5 md:sticky md:top-0 md:h-dvh">
          <div className="font-bold text-lg truncate">{profile?.name ?? 'Your store'}</div>
          <div className="text-xs text-ink-3 mb-6 truncate">{profile?.subdomain ? `${profile.subdomain} · store admin` : 'store admin'}</div>
          <nav className="flex flex-col gap-1">
            {SIDE.map((t) => (
              <Link key={t.href} href={t.href} className={`tap flex items-center rounded-xl px-3 font-medium ${active(t.href) ? 'bg-brand-soft text-brand' : 'text-ink-2 hover:bg-paper'}`}>{t.label}</Link>
            ))}
          </nav>
          <div className="mt-auto flex flex-col gap-2">
            <WhatsAppButton />
            <button type="button" onClick={logout} className="btn-ghost">Sign out</button>
          </div>
        </aside>
        <div className="flex-1 min-w-0">
          <header className="md:hidden sticky top-0 z-30 bg-paper/90 backdrop-blur border-b border-line px-4 h-14 flex items-center justify-between">
            <div className="font-bold truncate">{profile?.name ?? 'Your store'}</div>
            <a href={WHATSAPP_HELP} target="_blank" rel="noopener noreferrer" className="tap w-12 inline-flex items-center justify-center rounded-xl text-[#1f8f5a]" aria-label="Get help on WhatsApp">
              <svg viewBox="0 0 24 24" className="h-6 w-6 fill-current" aria-hidden><path d={WA_PATH} /></svg>
            </a>
          </header>
          <main className="mx-auto w-full max-w-3xl px-4 pt-4 pb-28 md:pb-10 md:px-8 md:pt-8">{children}</main>
        </div>
        <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 border-t border-line bg-card/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
          <div className="grid grid-cols-4">
            {TABS.map((t) => (
              <Link key={t.href} href={t.href} className={`flex flex-col items-center justify-center gap-1 h-16 text-xs font-medium ${active(t.href) ? 'text-brand' : 'text-ink-3'}`} aria-current={active(t.href) ? 'page' : undefined}>
                <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={active(t.href) ? 2.4 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={t.icon} /></svg>
                {t.label}
              </Link>
            ))}
          </div>
        </nav>
      </div>
    </ToastProvider>
  );
}
