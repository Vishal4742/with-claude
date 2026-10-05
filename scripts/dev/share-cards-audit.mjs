/**
 * Every event page's share card, fetched rather than assumed.
 *
 *   BASE="https://www.withclaude.in" node scripts/dev/share-cards-audit.mjs
 *
 *   BASE … the deployment to audit (default: the production origin)
 *   STRICT=1 … exit 1 when any event fails — what the preview smoke check uses
 *   EXTRA_HEADERS="name: value" … one per line, sent to BASE's own origin only
 *
 * WHY THIS EXISTS AND A UNIT TEST DOES NOT REPLACE IT. Eight of seventeen
 * event pages declared an `og:image` that returned 404 for as long as the
 * pages existed, because the page handed the layout a data-layer key
 * (`covers/cover-vol01.jpg`) instead of a URL and the layout dutifully
 * published `https://www.withclaude.in/covers/cover-vol01.jpg`. Any test that
 * asserted the string in the meta tag would have passed throughout. So this
 * reads the tag and then FETCHES what it points at, and decodes the bytes.
 *
 * The event pages are `prerender = false` — serverless functions reading the
 * database per request — so there is no event HTML in a local build to read.
 * This has to run against something deployed, which is why it lives here and
 * in the preview smoke workflow rather than in `npm test`.
 *
 * ── ONE SUBTLETY WORTH THE PARAGRAPH ────────────────────────────────────
 *
 * `Base.astro` builds the tag with `new URL(image, site.url)`, and `site.url`
 * is the CANONICAL origin — so a preview deployment also advertises
 * `https://www.withclaude.in/...`, not its own host. That is correct for an
 * unfurler and wrong for an audit: fetching the absolute URL from a preview
 * would test production's assets, and a cover added in the pull request would
 * 404 because production has not got it yet. So the absolute URL is checked
 * for shape (absolute, and on the canonical host), and the PATH it names is
 * fetched from BASE — the deployment actually under test. On production the
 * two are the same request.
 */
import { pathToFileURL } from 'node:url';
import { parseHeaders } from './visual-review.mjs';
import sharp from 'sharp';

/** Where `astro.config.mjs` says the site lives, and what `og:image` must name. */
const CANONICAL = 'https://www.withclaude.in';

/** Below this an unfurler renders a thumbnail or nothing. Not the card target. */
const MIN_EDGE = 200;

/** Give a slow cold function room, but never hang the workflow. */
const TIMEOUT_MS = 20_000;

async function get(url, headers, origin) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // The protection secret goes to BASE's origin and nowhere else.
    const scoped = new URL(url).origin === origin ? headers : {};
    return await fetch(url, { headers: scoped, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Event URLs from the deployment's own sitemap.
 *
 * Discovered, not hardcoded: an event added to the database after this script
 * was written still gets audited, and the count below is then the truth about
 * the site rather than the truth about this file.
 */
async function eventSlugs(base, headers, origin) {
  const res = await get(`${base}/sitemap.xml`, headers, origin);
  if (!res.ok) throw new Error(`sitemap.xml returned ${res.status}`);
  const xml = await res.text();
  const slugs = [...xml.matchAll(/<loc>[^<]*\/events\/([^/<]+)\/?<\/loc>/g)].map((m) => m[1]);
  return [...new Set(slugs)];
}

/** The `og:image` a page declares, whatever attribute order it uses. */
function ogImage(html) {
  const tags = html.match(/<meta[^>]+>/g) ?? [];
  for (const tag of tags) {
    if (!/property=["']og:image["']/.test(tag)) continue;
    const content = tag.match(/content=["']([^"']+)["']/);
    if (content) return content[1];
  }
  return undefined;
}

async function auditEvent(base, slug, headers, origin) {
  const page = await get(`${base}/events/${slug}/`, headers, origin);
  // A page that does not exist has no share card to audit, and is a DIFFERENT
  // defect: the sitemap advertising URLs the site does not serve. Reported
  // under its own heading rather than mixed in with the share-card results,
  // and gated separately — see STRICT_PAGES in main().
  if (page.status !== 200) {
    return {
      slug,
      pageStatus: page.status,
      error: `page returned ${page.status}`,
      pageDefect: true,
    };
  }

  const declared = ogImage(await page.text());
  if (!declared) return { slug, error: 'page declares no og:image' };

  // An unfurler is given no base to resolve against, so a relative value here
  // is a defect on its own, whatever it resolves to for us.
  let url;
  try {
    url = new URL(declared);
  } catch {
    return { slug, declared, error: 'og:image is not an absolute URL' };
  }
  if (url.origin !== CANONICAL) {
    return { slug, declared, error: `og:image points at ${url.origin}, not ${CANONICAL}` };
  }

  // The path, fetched from the deployment under test. See the header note.
  const image = await get(base + url.pathname, headers, origin);
  if (image.status !== 200) {
    return { slug, declared, status: image.status, error: `share image returned ${image.status}` };
  }

  const body = Buffer.from(await image.arrayBuffer());
  let meta;
  try {
    meta = await sharp(body).metadata();
  } catch {
    return { slug, declared, status: 200, error: 'share image did not decode as an image' };
  }
  if (!meta.width || !meta.height) {
    return { slug, declared, status: 200, error: 'share image has no dimensions' };
  }
  if (meta.width < MIN_EDGE || meta.height < MIN_EDGE) {
    return {
      slug,
      declared,
      status: 200,
      size: `${meta.width}x${meta.height}`,
      error: `share image is only ${meta.width}x${meta.height}`,
    };
  }

  return {
    slug,
    declared,
    status: 200,
    size: `${meta.width}x${meta.height}`,
    // Content identity, so "nine events, one picture" shows up as a fact.
    digest: `${meta.width}x${meta.height}:${body.length}`,
    path: url.pathname,
  };
}

async function main() {
  const BASE = (process.env.BASE ?? CANONICAL).replace(/\/$/, '');
  const STRICT = process.env.STRICT === '1';
  const headers = parseHeaders(process.env.EXTRA_HEADERS);
  const origin = new URL(BASE).origin;

  const slugs = await eventSlugs(BASE, headers, origin);
  if (slugs.length === 0) throw new Error('no event pages found in sitemap.xml');

  /**
   * Whether a sitemap URL that 404s fails the run.
   *
   * Off by default, and deliberately: as of this writing production's
   * sitemap.xml lists nine event pages that return 404, which is a real defect
   * but not this script's subject and not fixed by the change that added it.
   * Turning it on by default would wire a gate that is red on arrival for an
   * unrelated reason, which is how a gate gets ignored. Flip it on once the
   * sitemap and the event route agree.
   */
  const STRICT_PAGES = process.env.STRICT_PAGES === '1';

  const results = [];
  for (const slug of slugs) {
    const result = await auditEvent(BASE, slug, headers, origin);
    results.push(result);
    const label = result.pageDefect ? 'page ' : result.error ? 'FAIL ' : ' ok  ';
    const detail = result.error ?? `${result.status}  ${result.size.padEnd(9)} ${result.path}`;
    console.log(`${label} ${slug.padEnd(32)} ${detail}`);
  }

  const missing = results.filter((r) => r.pageDefect);
  const audited = results.filter((r) => !r.pageDefect);
  const failed = audited.filter((r) => r.error);
  const passed = audited.filter((r) => !r.error);
  console.log(`\n${passed.length}/${audited.length} event share images: HTTP 200 and decodable`);

  // Not a failure, and worth printing every run: a picture standing in for
  // several events is a content decision, and this is where it becomes
  // visible rather than staying an unremarked default.
  const byImage = new Map();
  for (const r of passed) byImage.set(r.digest, [...(byImage.get(r.digest) ?? []), r.slug]);
  for (const [, shared] of [...byImage].filter(([, s]) => s.length > 1)) {
    console.log(`note: one image serves ${shared.length} events — ${shared.join(', ')}`);
  }

  if (missing.length > 0) {
    console.log(
      `\nseparately: ${missing.length} of ${results.length} URLs in sitemap.xml return 404 and ` +
        `have no page to share — ${missing.map((r) => r.slug).join(', ')}`,
    );
  }

  console.log(`\naudited ${BASE}`);

  const fatal = [
    failed.length > 0 && `${failed.length} of ${audited.length} event share images are broken`,
    STRICT_PAGES && missing.length > 0 && `${missing.length} sitemap URLs return 404`,
  ].filter(Boolean);

  if (fatal.length > 0) {
    console.error(`\n${fatal.join('; ')}.`);
    if (STRICT) process.exit(1);
  }
}

// Importable for its helpers without running the audit.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}
