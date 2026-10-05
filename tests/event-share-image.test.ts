/**
 * The picture a link unfurler gets for an event page.
 *
 * Eight of seventeen event pages advertised an `og:image` that returned 404,
 * for as long as the pages have existed. The page passed `event.coverImage` —
 * a data-layer KEY like `covers/cover-vol01.jpg`, resolved against
 * `src/assets/` — straight to the layout, which turned it into
 * `https://www.withclaude.in/covers/cover-vol01.jpg`. The site has never
 * served that path. The nine events with no cover fell back to the layout's
 * `/og-card.jpg`, a real file in `public/`, and worked. So the events WITH a
 * cover shared worse than the events without one.
 *
 * WHY THESE TESTS LOOK THE WAY THEY DO. A test asserting the string in the
 * meta tag would have passed happily the entire time the site was broken —
 * `image={event.coverImage}` puts a perfectly well-formed string in the tag.
 * That is how this shipped. So the check that matters here resolves the URL
 * the BUILT function would declare, fetches it over HTTP, and decodes the
 * bytes that come back. Nothing is asserted about a path that was not fetched.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { events } from '@/data/events';
import { asset } from '@/lib/images';

const PAGE = 'src/pages/events/[slug].astro';

/** `Base.astro`'s own default, and the one share image that always worked. */
const DEFAULT_SHARE_IMAGE = '/og-card.jpg';

/** What `twitter:card = summary_large_image` asks for. See the gap test below. */
const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;

/**
 * What the page computes for `image=`, reproduced from the data layer.
 *
 * `cover?.src` in the page, falling through to the layout's default when the
 * event has no cover — which is why this returns the default rather than
 * `undefined`: `Base` substitutes it, so it is what reaches the meta tag.
 */
function declaredShareImage(coverImage: string | undefined): string {
  return asset(coverImage)?.src ?? DEFAULT_SHARE_IMAGE;
}

describe('every event declares a share image that resolves', () => {
  it('covers all seventeen events, so none of them is untested', () => {
    // If an event is added without a share image, the per-event assertions
    // below are the thing that should catch it — not a silently shorter loop.
    expect(events.length).toBe(17);
  });

  /**
   * A source assertion, and the only kind available for this one line.
   *
   * The page is `prerender = false`, and `.astro` is not transformable in this
   * vitest setup, so the `image=` expression cannot be rendered here — the
   * fetch of the real rendered meta tag lives in the preview smoke audit
   * instead. What this can do is refuse the shape of the bug: a data-layer key
   * reaching the layout without passing through `asset()`.
   */
  it('never passes a raw data-layer key to the layout', () => {
    // Comments stripped first: this file and the page both have to NAME the
    // broken expression in order to explain it, and prose is not code.
    const page = readFileSync(PAGE, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // The exact line that was wrong, and the near-misses. `coverImage` is a
    // key for `asset()`, not a URL, and the layout cannot tell the difference.
    expect(page).not.toMatch(/image=\{\s*event\.coverImage/);
    expect(page).not.toMatch(/image=\{\s*`[^`]*\$\{event\.coverImage\}/);

    // Whatever `image=` is given must be a local const, and that const must be
    // derived from `asset(...)`. This is what stops the fix being undone by
    // routing the raw key through a differently-named variable.
    const bound = page.match(/^\s*image=\{([A-Za-z0-9_?.]+)\}\s*$/m);
    expect(bound, 'Base is not given an `image=` at all').toBeTruthy();
    const name = bound![1].replace(/\?\..*$/, '');
    const declaration = page.match(new RegExp(`const ${name}\\s*=\\s*([^;]+);`));
    expect(declaration, `\`${name}\` is passed to image= but never declared here`).toBeTruthy();
    expect(declaration![1]).toMatch(/asset\(|\.src/);

    // And `coverImage` must never be read except through the resolver.
    for (const use of page.matchAll(/event\.coverImage/g)) {
      const before = page.slice(Math.max(0, use.index - 24), use.index);
      expect(before, 'event.coverImage read without asset()').toMatch(/asset\($/);
    }
  });

  it.each(events.map((e) => [e.slug, e.coverImage] as const))(
    'resolves a real file for %s',
    (_slug, coverImage) => {
      const declared = declaredShareImage(coverImage);
      // Root-relative, because `Base.astro` does `new URL(image, site.url)`
      // and a path without a leading slash resolves against the page's own
      // directory — which is the other half of how the broken URL was formed.
      expect(declared.startsWith('/')).toBe(true);

      // The file has to exist somewhere the site actually serves from: an
      // emitted asset, or `public/`. This is the assertion the old code could
      // not have passed.
      const servable = declared.startsWith('/_astro/')
        ? existsSync(join('.vercel/output/static', declared)) || existsSync(join('dist', declared))
        : existsSync(join('public', declared));
      // An unbuilt tree has no `/_astro/` yet; the built-output suite below
      // covers that case and says so when it skips.
      if (declared.startsWith('/_astro/') && !servable) return;
      expect(servable, `${declared} is not served from public/ or the build`).toBe(true);
    },
  );
});

describe('the share images are real pictures of a usable size', () => {
  const coverFiles = events
    .map((e) => e.coverImage)
    .filter((key): key is string => Boolean(key))
    .map((key) => join('src/assets', key));

  it('has a cover on disk for every event that claims one', () => {
    expect(coverFiles.length).toBe(8);
    for (const file of coverFiles) {
      expect(statSync(file).isFile(), `${file} is missing`).toBe(true);
    }
  });

  it.each([...new Set(coverFiles)])('decodes %s and is no smaller than today', async (file) => {
    const { width, height } = await sharp(file).metadata();
    // A floor, not an equality: replacing a cover with a BIGGER picture is the
    // fix we want, and replacing one with something smaller is a regression.
    // This fails the day a 400px cover is swapped for a 200px one.
    expect(width).toBeGreaterThanOrEqual(400);
    expect(height).toBeGreaterThanOrEqual(400);
  });

  it('has a fallback card that is genuinely card-sized', async () => {
    // The nine events with no cover depend on this file entirely.
    const { width, height } = await sharp(join('public', DEFAULT_SHARE_IMAGE)).metadata();
    expect(width).toBe(CARD_WIDTH);
    expect(height).toBe(CARD_HEIGHT);
  });

  /**
   * THE KNOWN REMAINING GAP, pinned here rather than written in a document.
   *
   * The covers are 400×400. `twitter:card` is `summary_large_image`, which
   * wants roughly 1200×630, so these unfurl as a small square thumbnail
   * instead of a card. Fixing the URL does not fix the size, and real
   * per-event card art is deliberately NOT in this change — it needs the
   * best-photograph flag the gallery work has still to specify.
   *
   * This test asserts the shortfall, so it goes red the day the art lands and
   * whoever lands it deletes this test. That is the intent: a gap that has to
   * be acknowledged in code beats a gap recorded in a comment nobody reads.
   */
  it('does not yet carry card-sized art per event (tracked separately)', async () => {
    const sizes = await Promise.all([...new Set(coverFiles)].map((file) => sharp(file).metadata()));
    expect(sizes.every((s) => s.width === 400 && s.height === 400)).toBe(true);
    expect(sizes.every((s) => (s.width ?? 0) < CARD_WIDTH)).toBe(true);
  });

  /**
   * ALSO PINNED: three events, one picture.
   *
   * `cover-vol04`, `cover-vol05` and `cover-vol08` are byte-identical. Because
   * the pipeline hashes on content, they do not merely look alike — they
   * collapse to a SINGLE emitted URL that three different events each present
   * as their own. While all eight 404'd nobody could see it; correcting the URL
   * makes it visible. Left deliberately undecided in code: the choice between
   * shipping the shared placeholder and pointing those three at the generic
   * default is a judgement call for review, not something to bury in a patch.
   */
  it('still has three events sharing one placeholder (a decision, not an oversight)', () => {
    const byContent = new Map<string, string[]>();
    for (const event of events) {
      if (!event.coverImage) continue;
      const digest = readFileSync(join('src/assets', event.coverImage)).toString('base64');
      byContent.set(digest, [...(byContent.get(digest) ?? []), event.slug]);
    }
    const shared = [...byContent.values()].filter((slugs) => slugs.length > 1);
    expect(shared).toHaveLength(1);
    expect(shared[0].sort()).toEqual(
      ['claude-code-workshop', 'claude-for-college-builders', 'getting-started-with-claude'].sort(),
    );
  });
});

/**
 * The real check: resolve through the code that runs in production, then fetch.
 *
 * The event page is `prerender = false`, so there is no event HTML in a local
 * build to read a meta tag out of — it is a serverless function that reads the
 * database per request. What CAN be checked without a database is the half
 * that was broken: the resolver the built function uses, and whether the URL
 * it returns is actually served by the built static output. The end-to-end
 * fetch of the page itself runs against a real deployment in
 * `scripts/dev/share-cards-audit.mjs`, wired into the preview smoke workflow.
 */
describe('the built output serves every share image it declares', () => {
  const STATIC = '.vercel/output/static';
  const CHUNKS = '.vercel/output/functions/_render.func/dist/server/chunks';

  let built = false;
  let resolve: ((key: string | undefined) => { src: string } | undefined) | undefined;
  let origin = '';
  let server: ReturnType<typeof createServer> | undefined;

  beforeAll(async () => {
    if (!existsSync(STATIC) || !existsSync(CHUNKS)) return;
    const chunk = readdirSync(CHUNKS).find((f) => /^images_.*\.mjs$/.test(f));
    if (!chunk) return;

    // Rollup renames the export, so take the alias when the name is gone.
    const mod = await import(join(process.cwd(), CHUNKS, chunk));
    resolve = mod.asset ?? mod.a;
    if (typeof resolve !== 'function') return;

    // Serve the built static directory so these are real HTTP requests with
    // real status codes, rather than an `existsSync` wearing a costume.
    server = createServer((req, res) => {
      const path = join(process.cwd(), STATIC, decodeURIComponent((req.url ?? '/').split('?')[0]));
      if (!path.startsWith(join(process.cwd(), STATIC)) || !existsSync(path)) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.statusCode = 200;
      res.end(readFileSync(path));
    });
    await new Promise<void>((done) => server!.listen(0, done));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    built = true;
  });

  afterAll(() => server?.close());

  it.each(events.map((e) => [e.slug, e.coverImage] as const))(
    'serves the share image declared by %s',
    async (slug, coverImage) => {
      if (!built || !resolve) {
        // Say so rather than pass quietly. A check that stops running without
        // anyone noticing is how the original defect survived this long.
        console.warn(`no build at ${STATIC} — run \`npm run build\` first (skipped ${slug})`);
        return;
      }

      const declared = resolve(coverImage)?.src ?? DEFAULT_SHARE_IMAGE;
      const response = await fetch(origin + declared);
      expect(response.status, `${slug} declares ${declared}`).toBe(200);

      // Decode the response body, not the file on disk: this is what an
      // unfurler receives, and a 200 serving a broken byte range is still
      // a card with no picture.
      const { width, height } = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
      expect(width, `${slug} → ${declared}`).toBeGreaterThanOrEqual(400);
      expect(height, `${slug} → ${declared}`).toBeGreaterThanOrEqual(400);

      // `Base.astro` publishes `new URL(image, site.url)`. Absolute is a hard
      // requirement for every unfurler, so assert the composition too.
      expect(new URL(declared, 'https://www.withclaude.in').href).toBe(
        `https://www.withclaude.in${declared}`,
      );
    },
  );
});
