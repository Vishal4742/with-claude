// @ts-check
/**
 * `.env` into `process.env`, before anything reads it.
 *
 * Astro exposes only `PUBLIC_`-prefixed variables through `import.meta.env`,
 * which is the right default — it is what stops `DATABASE_URL` being inlined
 * into a browser bundle. The consequence is that the server-only variables
 * `/api/submit` needs (`DATABASE_URL`, `SUBMISSION_IP_SALT`) are invisible to
 * it in dev unless something loads them, so this does, here, once, in the Node
 * process that runs the dev server and the build. The admin's config does the
 * same thing for the same reason.
 *
 * On Vercel the platform has already populated `process.env` and there is no
 * `.env` file to find, so this is a no-op in production.
 */
import 'dotenv/config';
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import vercel from '@astrojs/vercel';
import { vercelPathGuard } from './scripts/vercel-path-guard.mjs';



export default defineConfig({
  site: 'https://www.withclaude.in',
  trailingSlash: 'always',

  /**
   * STATIC FIRST, AND STAYING THAT WAY.
   *
   * `output: 'static'` with an adapter means every page is prerendered at
   * build time exactly as before; only a route that opts out with
   * `export const prerender = false` becomes a serverless function. Today that
   * is `/api/submit` and the nightly rebuild hook, and nothing else — the 71
   * public pages are still files on a CDN.
   *
   * The adapter is here because a submission has to land somewhere, not
   * because the site became an application.
   */
  output: 'static',
  adapter: vercel({ maxDuration: 15 }),

  /**
   * WHICH FORWARDED HOSTS ASTRO MAY BELIEVE.
   *
   * Behind Vercel, TLS terminates at the edge and the real hostname reaches
   * the function only in `X-Forwarded-Host`. Astro refuses to trust that
   * header unless the host is named here: `NodeApp.createRequest()` resolves
   * the hostname as `validatedForwardedHost ?? validatedHost ?? 'localhost'`,
   * and both validators return undefined when `allowedDomains` is empty.
   *
   * With no allowlist, `Astro.url.origin` inside a deployed function is
   * therefore `http://localhost` — not the site's real origin. That did not
   * matter while the only server route was `/api/submit`, which takes JSON and
   * checks nothing about its origin. It matters now: Phase A's member
   * endpoints compare the browser's `Origin` against the origin they were
   * served on, and that comparison is worthless if the served origin is
   * always `localhost`.
   *
   * `admin/astro.config.mjs` carries the long-form version of this argument,
   * which it earned by answering 403 to its own sign-in form.
   *
   * NOTE ON `checkOrigin`: left at its default rather than set here. It only
   * guards form-encoded bodies, every Phase A mutation takes JSON, and so the
   * real protection is `src/server/http/origin.ts`, called explicitly by each
   * route. This block exists to make that check able to see the truth.
   */
  security: {
    allowedDomains: [
      // Production. Exact hosts, so the real origins never depend on a wildcard.
      { protocol: 'https', hostname: 'www.withclaude.in' },
      { protocol: 'https', hostname: 'withclaude.in' },
      // The Project Directory's own host (src/lib/directory-host.ts).
      { protocol: 'https', hostname: 'projects.withclaude.in' },

      /**
       * Vercel preview and deployment URLs.
       *
       * `**.vercel.app` is deliberately this shape and not narrower: Astro's
       * matcher only honours a wildcard as a LEADING `*.` or `**.` label, so a
       * mid-string pattern like `with-claude-*.vercel.app` is not a wildcard to
       * it at all — it degrades to an exact string compare and silently never
       * matches. The residual breadth is narrowed again by
       * `isTrustedOrigin()`, which does anchor on the project name.
       */
      { protocol: 'https', hostname: '**.vercel.app' },
    ],
  },
  integrations: [
    /**
     * React is here for exactly one component: Privy's login UI, which is a
     * React component and has no vanilla equivalent.
     *
     * Adding the integration does NOT put React on the site. Astro ships a
     * framework only to pages that actually mount an island, and there is
     * exactly one island on the whole site: `PrivyRoot`, mounted once from
     * `AccountNav.astro` (itself included once by `Masthead.astro`). It
     * portals both the masthead account control and, on `/join`, `/practice`,
     * `/city` and `/submit`, that page's own sign-in CTA into their own DOM
     * nodes — one `PrivyProvider`, several visual slots. A second provider
     * instance on the same page is not a lighter-weight alternative to this;
     * it is the exact bug this island exists to avoid (see `PrivyRoot.tsx`).
     */
    react(),
  ],
  build: { inlineStylesheets: 'auto' },
  image: { service: { entrypoint: 'astro/assets/services/sharp' } },
  vite: {
    plugins: [vercelPathGuard()],
    build: {
      // The site is static-first; a handful of tiny islands beats one bundle.
      assetsInlineLimit: 2048,
    },
  },
});
