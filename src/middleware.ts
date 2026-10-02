/**
 * Request middleware: refuse the Vercel adapter's path-override header, then
 * serve the Project Directory at projects.withclaude.in (see
 * `src/lib/directory-host.ts`).
 *
 * Runs for server-rendered routes. Prerendered pages are files on the CDN and
 * never reach this; on the directory host they are redirected at the edge by
 * the matching rule in `vercel.json`. Every other host passes straight
 * through, untouched.
 */
import { defineMiddleware } from 'astro:middleware';
import { routeDirectoryHost } from './lib/directory-host';

export const onRequest = defineMiddleware(async (context, next) => {
  // @astrojs/vercel <10.0.2 trusts this client header to pick the route (GHSA-mr6q-rp88-fx84).
  // The real fix, which also covers the ?x_astro_path= form, is the build-time
  // patch in scripts/vercel-path-guard.mjs; this refusal is a second line.
  if (context.request.headers.has('x-astro-path')) {
    return new Response(null, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  const route = routeDirectoryHost(context.url.hostname, context.url.pathname, context.url.search);
  if (route.kind === 'rewrite') return context.rewrite(route.to);
  if (route.kind === 'redirect') return context.redirect(route.to, 302);
  return next();
});
