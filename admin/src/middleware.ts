/**
 * The gate.
 *
 * Every request to this application passes through here, and everything is
 * private unless it appears in `PUBLIC_PATHS` below. That default is the whole
 * design: a new page added tomorrow is protected because somebody would have
 * to go out of their way to expose it, rather than protected because they
 * remembered to add a check at the top of it.
 *
 * The resolved user is put on `context.locals`, so a page never re-derives it
 * and can never disagree with the middleware about who is asking.
 */
import { defineMiddleware } from 'astro:middleware';
import { resolveSession } from './server/session';

/**
 * The only routes that answer without a session.
 *
 * `/api/auth/*` has to be open — it is where signing in happens. It is
 * better-auth's own handler, which does its own origin checking and rate
 * limiting.
 */
const PUBLIC_PATHS = ['/login', '/api/auth', '/api/login'];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export const onRequest = defineMiddleware(async (context, next) => {
  // @astrojs/vercel <10.0.2 trusts this client header to pick the route (GHSA-mr6q-rp88-fx84).
  // scripts/vercel-path-guard.mjs removes the override at build time; this refusal is a second line.
  if (context.request.headers.has('x-astro-path')) {
    return new Response(null, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  const { pathname } = context.url;

  // Static assets served by the adapter never reach here, but be explicit.
  if (pathname.startsWith('/_')) return next();

  const session = await resolveSession(context.request);
  context.locals.user = session.authenticated ? session.user : undefined;

  if (isPublic(pathname)) {
    // Somebody already signed in has no use for the login form.
    if (pathname === '/login' && session.authenticated) {
      return context.redirect('/submissions', 302);
    }
    return next();
  }

  if (!session.authenticated) {
    // An API route gets a status code; a page gets sent to the login form with
    // somewhere to come back to. Neither gets any data.
    if (pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'Not authenticated.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    const next_ = encodeURIComponent(pathname + context.url.search);
    const reason = session.reason === 'no-session' ? '' : `&reason=${session.reason}`;
    return context.redirect(`/login?next=${next_}${reason}`, 302);
  }

  const response = await next();

  /**
   * Nothing behind the gate is cacheable or indexable.
   *
   * A shared cache holding a page of somebody's submission queue, or a search
   * engine finding one, are both failures this header costs nothing to
   * prevent.
   */
  response.headers.set('Cache-Control', 'no-store, private');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return response;
});
