import { NextRequest, NextResponse } from 'next/server';

/** Signed-out visitors go to /login. The cookies are httpOnly; the API decides whether they are still valid. */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const signedIn = req.cookies.has('bm_access') || req.cookies.has('bm_refresh');
  if (!signedIn && pathname !== '/login') {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = pathname !== '/' ? `?next=${encodeURIComponent(pathname)}` : '';
    return NextResponse.redirect(url);
  }
  if (signedIn && pathname === '/login') return NextResponse.redirect(new URL('/', req.url));
  return NextResponse.next();
}

export const config = { matcher: ['/((?!api|_next|favicon.ico|icon.svg|manifest.webmanifest).*)'] };
