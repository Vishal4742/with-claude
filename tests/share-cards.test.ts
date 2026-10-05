import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { events } from '../src/data/events';
import { asset } from '../src/lib/images';
import {
  DEFAULT_SHARE_IMAGE,
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  shareCardFile,
  shareCardKey,
} from '../src/lib/share-card';
import {
  cardFailures,
  declaredImage,
  duplicateDigests,
  eventSlugs,
} from '../scripts/dev/share-cards-audit.mjs';

/**
 * THE SHARE CARDS — asserted as responses, not as strings.
 *
 * Eight of seventeen event pages published an `og:image` that returned 404 for
 * as long as the pages existed, and every test the project had was green
 * throughout. They were green because they asked what the meta tag SAID. The
 * tag said `https://www.withclaude.in/covers/cover-vol01.jpg`, which is
 * exactly what the code was written to produce; nothing was ever served there.
 *
 * So the rule this file is written to is: never assert a string where you can
 * assert the bytes it points at. The chain below is checked link by link.
 *
 *   1. THE RECORD IS COVERED. Every event has a generated card on disk.
 *   2. THE CARDS ARE CARDS. 1200×630, and no two events share one.
 *   3. THE REGISTRY RESOLVES THEM. `asset()` finds every card's key, which is
 *      what makes `shareCard()` return a real asset URL in a build instead of
 *      falling back to the generic site card.
 *   4. THE URL SERVES. The exact bytes of each card are fetched back OVER HTTP
 *      from the built output and re-measured from the response body.
 *   5. THE PAGE USES THE RESOLVER. A regression guard on the one line that was
 *      wrong, so nobody reintroduces a raw data-layer key.
 *
 * ── WHAT THIS FILE CANNOT DO, AND WHAT DOES IT INSTEAD ───────────────────
 *
 * It cannot fetch `/events/<slug>/` itself. That page is `prerender = false`
 * and reads its event from the database through `loadLiveRecords()`, so there
 * is no event page in `dist/` to serve and no event page without a live
 * connection. The true end-to-end — fetch the page, read the `og:image` it
 * declares, fetch that — needs a deployment, which is why it runs as a step in
 * `.github/workflows/preview-smoke.yml` against the Vercel deployment, where
 * it also gates production promotion. The rules that check runs on are the
 * ones unit-tested at the bottom of this file.
 */

/** The same search order as `tests/security.test.ts`. */
const CLIENT_DIRS = ['dist/client', 'dist', '.vercel/output/static'];

function builtClientDir(): string | undefined {
  for (const dir of CLIENT_DIRS) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    if (dir === 'dist' && existsSync('dist/client')) continue;
    if (!existsSync(join(dir, '_astro'))) continue;
    return dir;
  }
  return undefined;
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('every event in the record has a share card', () => {
  it.each(events.map((event) => event.slug))('%s', (slug) => {
    expect(
      existsSync(shareCardFile(slug)),
      `no share card for "${slug}" — run \`npm run og:events\``,
    ).toBe(true);
  });
});

describe('the cards are the size a large summary card needs', () => {
  it.each(events.map((event) => event.slug))('%s is 1200×630', async (slug) => {
    const meta = await sharp(readFileSync(shareCardFile(slug))).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual({
      width: SHARE_CARD_WIDTH,
      height: SHARE_CARD_HEIGHT,
    });
  });

  /**
   * The other half of the original defect. `cover-vol04.jpg`, `cover-vol05.jpg`
   * and `cover-vol08.jpg` were three filenames over one SHA-256 — a single
   * placeholder presented as three different events' own picture. Comparing
   * names would have seen nothing; this compares bytes.
   */
  it('gives no two events the same picture', () => {
    const byDigest = new Map<string, string[]>();
    for (const event of events) {
      const digest = sha256(readFileSync(shareCardFile(event.slug)));
      byDigest.set(digest, [...(byDigest.get(digest) ?? []), event.slug]);
    }
    const shared = [...byDigest.values()].filter((slugs) => slugs.length > 1);
    expect(shared, 'one image is doing more than one event’s job').toEqual([]);
  });
});

describe('the image registry resolves every card', () => {
  /**
   * `shareCard()` falls back to the generic site card for an unknown key, which
   * is the right behaviour for an event added to the database since the last
   * generation run — and would also silently hide a card that the build cannot
   * see at all. This is what tells the two cases apart.
   *
   * Under Vitest an asset import is a URL string rather than Astro's
   * `ImageMetadata`, so what is asserted here is that the key RESOLVES. That it
   * resolves to a servable URL is what the HTTP suite below measures.
   */
  it.each(events.map((event) => event.slug))('%s', (slug) => {
    expect(asset(shareCardKey(slug)), `${shareCardKey(slug)} is not in the registry`).toBeDefined();
  });

  it('still falls back to the site card for an event it has never seen', () => {
    expect(asset(shareCardKey('an-event-added-this-morning'))).toBeUndefined();
    expect(DEFAULT_SHARE_IMAGE).toBe('/og-card.jpg');
    expect(existsSync(join('public', DEFAULT_SHARE_IMAGE))).toBe(true);
  });
});

describe('the built site serves every card', () => {
  const dir = builtClientDir();
  let server: Server;
  let origin: string;

  /** Every emitted asset, indexed by the bytes in it. */
  const emitted = new Map<string, string>();

  beforeAll(async () => {
    if (!dir) return;
    for (const name of readdirSync(join(dir, '_astro'))) {
      if (!/\.(jpe?g|png|webp|avif)$/i.test(name)) continue;
      emitted.set(sha256(readFileSync(join(dir, '_astro', name))), `/_astro/${name}`);
    }

    const types: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.avif': 'image/avif',
    };
    server = createServer((request, response) => {
      const path = join(dir, decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname));
      if (!path.startsWith(dir) || !existsSync(path) || statSync(path).isDirectory()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'content-type': types[extname(path)] ?? 'application/octet-stream',
      });
      createReadStream(path).pipe(response);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((done) => server.close(() => done()));
  });

  it('was built at all', () => {
    expect(dir, `run \`npm run build\` first — looked in ${CLIENT_DIRS.join(', ')}`).toBeDefined();
  });

  /**
   * The assertion the old tests never made.
   *
   * Each card is located in the build BY ITS CONTENT, which is also how Vite
   * names it, then fetched over a real socket and re-measured from the response
   * body. A card that is missing from the build, served as the wrong type, or
   * quietly re-encoded to another size fails here.
   */
  it.each(events.map((event) => event.slug))('serves %s at 1200×630', async (slug) => {
    expect(dir).toBeDefined();
    const digest = sha256(readFileSync(shareCardFile(slug)));
    const url = emitted.get(digest);
    expect(url, `${shareCardFile(slug)} was not emitted into the build`).toBeDefined();

    const response = await fetch(`${origin}${url}`);
    expect(response.status, `${url} did not serve`).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');

    const body = Buffer.from(await response.arrayBuffer());
    const meta = await sharp(body).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual({
      width: SHARE_CARD_WIDTH,
      height: SHARE_CARD_HEIGHT,
    });
  });

  /**
   * The fallback has to be reachable too. It is the card every event added
   * since the last generation run will declare, and it is the only reason the
   * nine events without a cover were not also broken.
   */
  it('serves the site card the fallback names', async () => {
    expect(dir).toBeDefined();
    const response = await fetch(`${origin}${DEFAULT_SHARE_IMAGE}`);
    expect(response.status).toBe(200);
    const meta = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual({
      width: SHARE_CARD_WIDTH,
      height: SHARE_CARD_HEIGHT,
    });
  });
});

describe('the event page asks for the card and not for the data', () => {
  const page = readFileSync('src/pages/events/[slug].astro', 'utf8');

  /**
   * Every `image=` the page hands `<Base>`, read as code rather than as prose —
   * the comments in that file quote the broken line on purpose, and a plain
   * substring search would match the quotation.
   *
   * THE LINE THAT WAS WRONG: `image={event.coverImage}` handed the layout
   * `covers/cover-vol01.jpg`, a key for the image registry and not a URL, and
   * `new URL(image, site.url)` turned it into a 404 without complaint. So the
   * assertion is an equality, not an absence: there is one `image=` on this
   * page and it is the resolver's.
   */
  it('passes the resolved share image to the layout, and nothing else', () => {
    const passed = page.split('\n').filter((line) => /^\s*image=\{/.test(line));
    expect(passed.map((line) => line.trim())).toEqual(['image={shareImage}']);
    expect(page).toMatch(/^const shareImage = shareCard\(event\.slug\);$/m);
  });
});

describe('the rules the deployment audit fails on', () => {
  const page = (image: string) =>
    `<meta property="og:title" content="x" /><meta property="og:image" content="${image}" />`;

  it('finds every event the index links to, once each', () => {
    expect(
      eventSlugs(
        '<a href="/events/claude-meetup">a</a><a href="/events/claude-meetup/">b</a>' +
          '<a href="https://www.withclaude.in/events/claude-code-workshop/">c</a>' +
          '<a href="/events">all</a><a href="/cities/bhopal/">d</a>',
      ),
    ).toEqual(['claude-code-workshop', 'claude-meetup']);
  });

  it('reads the og:image a page declares', () => {
    expect(declaredImage(page('https://www.withclaude.in/og-card.jpg'))).toBe(
      'https://www.withclaude.in/og-card.jpg',
    );
    expect(declaredImage('<meta name="description" content="x" />')).toBeUndefined();
  });

  const healthy = {
    slug: 'claude-meetup',
    pageStatus: 200,
    declared: 'https://www.withclaude.in/og/x.jpg',
    imageStatus: 200,
    contentType: 'image/jpeg',
    width: SHARE_CARD_WIDTH,
    height: SHARE_CARD_HEIGHT,
  };

  it('passes a card that is actually there, at the right size', () => {
    expect(cardFailures(healthy)).toEqual([]);
  });

  /**
   * THE LIVE DEFECT, AS THE AUDIT SAW IT ON 2026-10-05. Before the fix this is
   * what eight of the seventeen events returned, and it is the case any test
   * that only read the meta tag would have passed.
   */
  it('fails the og:image that 404s', () => {
    expect(cardFailures({ ...healthy, imageStatus: 404 })).toEqual(['og:image returned 404']);
  });

  it('fails a 400px square dressed up as a large summary card', () => {
    expect(cardFailures({ ...healthy, width: 400, height: 400 })).toEqual([
      'og:image is 400×400, not 1200×630',
    ]);
  });

  it('fails a page that declares no card, and one that does not load', () => {
    expect(cardFailures({ ...healthy, declared: undefined })).toEqual([
      'page declares no og:image',
    ]);
    expect(cardFailures({ ...healthy, pageStatus: 500 })).toEqual(['page returned 500']);
  });

  it('fails an og:image that is not an image', () => {
    expect(cardFailures({ ...healthy, contentType: 'text/html' })).toEqual([
      'og:image is text/html, not an image',
    ]);
  });

  it('names the events that are sharing one picture', () => {
    expect(
      duplicateDigests([
        { slug: 'a', digest: '52bbfb82b418' },
        { slug: 'b', digest: '52bbfb82b418' },
        { slug: 'c', digest: '52bbfb82b418' },
        { slug: 'd', digest: '4c156d21faba' },
        { slug: 'e' },
      ]),
    ).toEqual([['a', 'b', 'c']]);
  });
});
