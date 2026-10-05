/**
 * THE SHARE CARD AUDIT — what a link unfurler actually gets.
 *
 *     node scripts/dev/share-cards-audit.mjs                      # production
 *     node scripts/dev/share-cards-audit.mjs http://localhost:4321
 *
 * For every event listed on `/events/`, this fetches the event page, reads the
 * `og:image` that page DECLARES, and then fetches that URL and measures the
 * bytes that come back. A share card is only as good as the last of those
 * steps: `og:image` is a promise made to WhatsApp, X, LinkedIn and Slack, and
 * the only way to know the promise is kept is to go and collect on it.
 *
 * This exists because the failure it catches is invisible from inside the
 * codebase. `src/pages/events/[slug].astro` passed `event.coverImage` — the
 * data-layer key `covers/cover-vol01.jpg` — straight to the layout, which
 * resolved it against the site origin and published
 * `https://www.withclaude.in/covers/cover-vol01.jpg`. Nothing has ever been
 * served there; the covers reach the browser through Astro's image pipeline
 * as hashed `/_astro/…` URLs. Eight of seventeen events therefore advertised
 * a 404, and every unit test that asserted the meta tag's STRING was green
 * the whole time. So this one asserts the RESPONSE.
 *
 * Exits non-zero on the first event that fails, so it can be a gate.
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { parseHeaders } from './visual-review.mjs';

/** What `twitter:card = summary_large_image` asks for. */
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

const DEFAULT_ORIGIN = 'https://www.withclaude.in';
const TIMEOUT_MS = 20_000;

/**
 * Every event slug the public index links to.
 *
 * Deliberately read off `/events/` rather than imported from `src/data`: the
 * live site serves events from the database, so the only list that can be
 * trusted to match what is published is the one the published page prints.
 */
export function eventSlugs(html) {
  const found = new Set();
  for (const [, slug] of html.matchAll(
    /href="(?:https?:\/\/[^"/]+)?\/events\/([a-z0-9][a-z0-9-]*)\/?"/g,
  )) {
    found.add(slug);
  }
  return [...found].sort();
}

/** The `og:image` a page declares, or undefined if it declares none. */
export function declaredImage(html) {
  const match =
    html.match(/<meta\s+property="og:image"\s+content="([^"]*)"/i) ??
    html.match(/<meta\s+content="([^"]*)"\s+property="og:image"/i);
  return match?.[1];
}

/**
 * What is wrong with one event's card, as a list of plain sentences.
 *
 * Empty means the card is good. Kept pure and exported so the failure rules
 * themselves are unit-testable without a network — the same split
 * `scripts/dev/visual-review.mjs` uses for `strictFailures`.
 */
export function cardFailures(result) {
  const problems = [];
  if (result.pageStatus !== 200) problems.push(`page returned ${result.pageStatus}`);
  if (!result.declared) problems.push('page declares no og:image');
  else {
    if (result.imageStatus !== 200) problems.push(`og:image returned ${result.imageStatus}`);
    else {
      if (!result.contentType?.startsWith('image/')) {
        problems.push(`og:image is ${result.contentType ?? 'untyped'}, not an image`);
      }
      if (result.width !== CARD_WIDTH || result.height !== CARD_HEIGHT) {
        problems.push(
          `og:image is ${result.width}×${result.height}, not ${CARD_WIDTH}×${CARD_HEIGHT}`,
        );
      }
    }
  }
  return problems;
}

/**
 * Two cards that are the same bytes are one card doing two jobs.
 *
 * `cover-vol04.jpg`, `cover-vol05.jpg` and `cover-vol08.jpg` were byte-identical
 * — one placeholder standing in as three different events' own picture — and
 * nothing in the build would ever have said so.
 */
export function duplicateDigests(results) {
  const bySum = new Map();
  for (const r of results) {
    if (!r.digest) continue;
    bySum.set(r.digest, [...(bySum.get(r.digest) ?? []), r.slug]);
  }
  return [...bySum.values()].filter((slugs) => slugs.length > 1);
}

/**
 * One request, with the deployment-protection headers sent to the audited
 * origin AND NOWHERE ELSE.
 *
 * `EXTRA_HEADERS` carries `VERCEL_AUTOMATION_BYPASS_SECRET` on a protected
 * preview. A redirect off the origin — or an `og:image` pointing at a CDN —
 * must not take that secret with it, so the origin is checked per request.
 * Same rule, and the same `parseHeaders`, as `scripts/dev/visual-review.mjs`.
 */
async function get(url, origin, extra) {
  const sameOrigin = new URL(url).origin === new URL(origin).origin;
  return fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'user-agent': 'with-claude share-card audit',
      ...(sameOrigin ? extra : {}),
    },
  });
}

async function auditEvent(origin, slug, extra) {
  const pageUrl = new URL(`/events/${slug}/`, origin).href;
  const page = await get(pageUrl, origin, extra);
  const html = await page.text();
  const declared = page.status === 200 ? declaredImage(html) : undefined;

  const result = { slug, pageUrl, pageStatus: page.status, declared };
  if (!declared) return result;

  result.imageUrl = new URL(declared, origin).href;
  const image = await get(result.imageUrl, origin, extra);
  result.imageStatus = image.status;
  if (image.status !== 200) return result;

  result.contentType = image.headers.get('content-type') ?? undefined;
  const bytes = Buffer.from(await image.arrayBuffer());
  result.bytes = bytes.byteLength;
  result.digest = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const meta = await sharp(bytes).metadata();
  result.width = meta.width;
  result.height = meta.height;
  return result;
}

export async function audit(origin, extra = parseHeaders(process.env.EXTRA_HEADERS)) {
  const index = await get(new URL('/events/', origin).href, origin, extra);
  if (index.status !== 200) throw new Error(`${origin}/events/ returned ${index.status}`);
  const slugs = eventSlugs(await index.text());
  if (slugs.length === 0) throw new Error(`${origin}/events/ listed no events`);

  const results = [];
  for (const slug of slugs) results.push(await auditEvent(origin, slug, extra));
  return results;
}

/* c8 ignore start — the CLI wrapper; the rules above are what the tests drive. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const origin = process.argv[2] ?? process.env.BASE ?? DEFAULT_ORIGIN;
  const results = await audit(origin);

  let bad = 0;
  for (const result of results) {
    const problems = cardFailures(result);
    if (problems.length) bad += 1;
    const size = result.width ? `${result.width}×${result.height}` : '—';
    console.log(
      `${problems.length ? 'FAIL' : ' ok '}  ${result.slug.padEnd(34)} ` +
        `${String(result.imageStatus ?? result.pageStatus).padEnd(4)} ${size.padEnd(10)} ` +
        `${result.declared ?? '(none)'}${problems.length ? `\n        ${problems.join('; ')}` : ''}`,
    );
  }

  const shared = duplicateDigests(results);
  for (const group of shared) {
    console.log(`FAIL  one image is serving ${group.length} events: ${group.join(', ')}`);
  }

  console.log(`\n${results.length - bad}/${results.length} events share correctly — ${origin}`);
  if (bad || shared.length) process.exit(1);
}
/* c8 ignore stop */
