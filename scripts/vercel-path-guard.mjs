/**
 * Build-time fix for GHSA-mr6q-rp88-fx84 in @astrojs/vercel 9.x.
 *
 * The adapter's function entrypoint lets any client pick the route it renders,
 * through an `x-astro-path` header or an `x_astro_path` query parameter. It
 * replaces `req.url` before Astro sees the request, so app middleware cannot
 * catch the query-parameter form. The only patched adapter (10.0.2+) needs
 * Astro 6, so until both apps move there this plugin removes the override from
 * the bundled entrypoint. Neither app uses ISR or edge middleware, the only
 * features that send it legitimately.
 *
 * Delete this plugin once both apps run @astrojs/vercel >= 10.0.2. The build
 * fails if the line it patches is missing, so an adapter change cannot leave
 * the override silently back in place.
 */
const ENTRYPOINT = /@astrojs[\\/]vercel[\\/]dist[\\/]serverless[\\/]entrypoint\.js$/;
const OVERRIDE =
  'const realPath = req.headers[ASTRO_PATH_HEADER] ?? url.searchParams.get(ASTRO_PATH_PARAM);';

export function vercelPathGuard() {
  return {
    name: 'with-claude:vercel-path-guard',
    enforce: /** @type {'pre'} */ ('pre'),
    transform(code, id) {
      if (!ENTRYPOINT.test(id.split('?')[0])) return null;
      if (!code.includes(OVERRIDE)) {
        throw new Error(
          `vercel-path-guard: the @astrojs/vercel entrypoint changed (${id}). ` +
            'If the adapter is now >= 10.0.2, remove this plugin; otherwise update the patch.',
        );
      }
      return { code: code.replace(OVERRIDE, 'const realPath = undefined;'), map: null };
    },
  };
}
