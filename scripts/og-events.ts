/**
 * Renders one 1200×630 share card per event into `src/assets/og/events/`.
 *
 *     npm run og:events            # every event
 *     npm run og:events -- vol01   # only slugs containing "vol01"
 *
 * The sibling of `scripts/og.mjs`, which renders the one evergreen site card.
 * Same typography, same paper, same browser — a card per room instead of a
 * card for the whole site.
 *
 * ── WHY THESE ARE COMMITTED AND NOT BUILT ────────────────────────────────
 *
 * Because the alternative is putting Chromium in the Vercel build. The cards
 * change when an event is added or a picture is replaced, which is a handful
 * of times a year; the site builds every night on a cron. Generating them on
 * every build would pay a browser download and seventeen screenshots, every
 * time, for an output that is almost always identical — and would make a
 * broken build out of a browser that failed to launch. `public/og-card.jpg`
 * has been a committed artefact for the same reason since it existed.
 *
 * `tests/share-cards.test.ts` is what stops "committed" becoming "stale": it
 * fails if an event in the record has no card, and it fails if a card is the
 * wrong size.
 *
 * ── WHY THE PICTURE IS THE COVER, AND ONLY SOMETIMES ─────────────────────
 *
 * An event's cover is the only picture the record currently names as being
 * ABOUT that event. `event.photos` holds the real photographs, but nothing in
 * the data says which of them is the good one, and a share card wants the good
 * one. That flag is the Photo Gallery work's to design — see VIS-7 — and when
 * it lands, `pictureFor()` below is the single place that should start reading
 * it. Do not invent a second best-photo rule here.
 *
 * Until then: a cover is used when it is that event's OWN picture, and skipped
 * when it is not. `cover-vol04.jpg`, `cover-vol05.jpg` and `cover-vol08.jpg`
 * are byte-identical — one placeholder standing in for three different rooms —
 * so those three get the typographic card instead. A card with no photograph
 * is honest about having none. A card showing another event's picture is not.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { cities } from '../src/data/cities';
import { events } from '../src/data/events';
import { dateParts } from '../src/lib/datetime';
import { formatName } from '../src/lib/status';
import { SHARE_CARD_HEIGHT, SHARE_CARD_WIDTH, shareCardFile } from '../src/lib/share-card';
import type { CommunityEvent } from '../src/data/types';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p: string) => pathToFileURL(resolve(root, p)).href;
const font = (p: string) => url(`node_modules/${p}`);

const FRAUNCES = font('@fontsource-variable/fraunces/files/fraunces-latin-wonk-normal.woff2');
const FRAUNCES_I = font('@fontsource-variable/fraunces/files/fraunces-latin-wonk-italic.woff2');
const MONO = font('@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2');
const MONO_500 = font('@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2');

const cityName = new Map(cities.map((c) => [c.slug, c.name]));

/**
 * Every cover that more than one event claims, by content.
 *
 * By CONTENT and not by filename, because the three placeholder covers have
 * three different names and one SHA-256. A filename comparison would have seen
 * nothing wrong.
 */
function sharedCovers(): Set<string> {
  const byDigest = new Map<string, number>();
  for (const event of events) {
    if (!event.coverImage) continue;
    const file = resolve(root, 'src/assets', event.coverImage);
    if (!existsSync(file)) continue;
    const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
    byDigest.set(digest, (byDigest.get(digest) ?? 0) + 1);
  }
  return new Set([...byDigest].filter(([, count]) => count > 1).map(([digest]) => digest));
}

/** This event's own picture as a `file://` URL, or undefined if it has none. */
function pictureFor(event: CommunityEvent, shared: Set<string>): string | undefined {
  if (!event.coverImage) return undefined;
  const path = `src/assets/${event.coverImage}`;
  const file = resolve(root, path);
  if (!existsSync(file)) {
    console.warn(
      `  ! ${event.slug}: coverImage "${event.coverImage}" does not exist — skipping it`,
    );
    return undefined;
  }
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (shared.has(digest)) {
    console.warn(
      `  ! ${event.slug}: cover is shared with another event — typographic card instead`,
    );
    return undefined;
  }
  return url(path);
}

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The headline size, chosen from the title's length.
 *
 * Browsers have no `font-size: fit`, and a card that silently clips the second
 * half of "Getting Started with Claude & Claude Code" is a worse bug than the
 * one this file exists to fix. Measured against the real titles in the record;
 * `tests/share-cards.test.ts` pins the longest of them.
 */
export function headlineSize(title: string, hasPicture: boolean): number {
  const budget = hasPicture ? 26 : 34;
  if (title.length <= budget) return hasPicture ? 76 : 96;
  if (title.length <= budget * 1.6) return hasPicture ? 60 : 76;
  return hasPicture ? 48 : 60;
}

/** `Sun, 1 Mar 2026` → the mono stamp under the brand rule. */
function stamp(event: CommunityEvent): string {
  const parts = dateParts(event.date);
  const city = cityName.get(event.citySlug) ?? event.citySlug;
  return `${city} · ${parts.day} ${parts.monthShort} ${parts.year}`;
}

/** `Meetup · vol. 01`, or just the format when the event has no volume. */
function kicker(event: CommunityEvent): string {
  const format = formatName(event.format);
  return event.volume ? `${format} · vol. ${String(event.volume).padStart(2, '0')}` : format;
}

export function cardHtml(event: CommunityEvent, picture: string | undefined): string {
  const size = headlineSize(event.title, Boolean(picture));
  return `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:'F';src:url('${FRAUNCES}') format('woff2-variations');font-weight:100 900;font-style:normal}
@font-face{font-family:'F';src:url('${FRAUNCES_I}') format('woff2-variations');font-weight:100 900;font-style:italic}
@font-face{font-family:'M';src:url('${MONO}') format('woff2');font-weight:400}
@font-face{font-family:'M';src:url('${MONO_500}') format('woff2');font-weight:500}
*{margin:0;box-sizing:border-box}
body{width:${SHARE_CARD_WIDTH}px;height:${SHARE_CARD_HEIGHT}px;background:#F3EFE7;color:#16140E;font-family:'F',serif;
  display:flex;flex-direction:column;justify-content:space-between;padding:54px 62px;position:relative;overflow:hidden}
.grid{position:absolute;inset:0;
  background-image:linear-gradient(to right,rgba(23,21,15,.07) 1px,transparent 1px),
                   linear-gradient(to bottom,rgba(23,21,15,.07) 1px,transparent 1px);
  background-size:96px 96px}
.slug{position:relative;display:flex;justify-content:space-between;align-items:center;
  font-family:'M',monospace;font-size:16px;letter-spacing:.18em;text-transform:uppercase;color:#69635A;
  padding-bottom:18px;border-bottom:1px solid #D8D1C4}
.brand{display:flex;align-items:baseline;gap:10px;color:#16140E;font-family:'F',serif;font-size:24px;letter-spacing:-.01em;text-transform:uppercase;font-variation-settings:'WONK' 1}
.brand .with{font-style:italic;font-weight:400;color:#9E4526}
.brand .claude{font-weight:700}
.mark{color:#D97757;align-self:center}
.body{position:relative;flex:1;display:flex;align-items:center;gap:54px;padding:34px 0}
.words{flex:1;min-width:0}
.kicker{font-family:'M',monospace;font-size:15px;font-weight:500;letter-spacing:.16em;text-transform:uppercase;color:#9E4526;margin-bottom:20px}
h1{font-size:${size}px;line-height:1.02;letter-spacing:-.035em;font-weight:600;font-variation-settings:'WONK' 1}
h1 .stop{color:#D97757}
.shot{flex:0 0 ${SHARE_CARD_HEIGHT - 300}px;height:${SHARE_CARD_HEIGHT - 300}px;border-radius:10px;overflow:hidden;
  border:1px solid #D8D1C4;box-shadow:0 18px 42px -24px rgba(23,21,15,.45)}
.shot img{width:100%;height:100%;object-fit:cover;display:block}
.foot{position:relative;display:flex;justify-content:space-between;align-items:baseline;
  padding-top:20px;border-top:1px solid #D8D1C4;font-family:'M',monospace;font-size:16px;letter-spacing:.16em;text-transform:uppercase}
.foot .where{color:#16140E;font-weight:500}
.foot .dom{color:#9E4526}
</style>
<div class="grid"></div>
<div class="slug">
  <span class="brand">
    <svg class="mark" width="22" height="22" viewBox="0 0 24 24" fill="none">
      <g stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
        <path d="M12 1.5v5.2M12 17.3v5.2M1.5 12h5.2M17.3 12h5.2"/>
        <path d="M4.9 4.9l2.6 2.6M16.5 16.5l2.6 2.6M19.1 4.9l-2.6 2.6M7.5 16.5l-2.6 2.6" opacity=".55"/>
      </g><circle cx="12" cy="12" r="3.4" fill="currentColor"/>
    </svg>
    <span class="with">With</span><span class="claude">Claude</span>
  </span>
  <span>Claude Community · India</span>
</div>
<div class="body">
  <div class="words">
    <div class="kicker">${escape(kicker(event))}</div>
    <h1>${escape(event.title)}<span class="stop">.</span></h1>
  </div>
  ${picture ? `<div class="shot"><img src="${picture}" alt=""></div>` : ''}
</div>
<div class="foot">
  <span class="where">${escape(stamp(event))}</span>
  <span class="dom">withclaude.in</span>
</div>`;
}

async function main() {
  const filter = process.argv.slice(2);
  const wanted = filter.length
    ? events.filter((e) => filter.some((f) => e.slug.includes(f)))
    : events;
  if (wanted.length === 0) {
    console.error(`No event slug matched ${filter.join(', ')}`);
    process.exit(1);
  }

  const shared = sharedCovers();
  const scratch = resolve(root, 'scripts/.og-events.html');
  await mkdir(resolve(root, 'src/assets/og/events'), { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: SHARE_CARD_WIDTH, height: SHARE_CARD_HEIGHT },
    deviceScaleFactor: 1,
  });

  try {
    for (const event of wanted) {
      const picture = pictureFor(event, shared);
      await writeFile(scratch, cardHtml(event, picture), 'utf8');
      await page.goto(pathToFileURL(scratch).href, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      const out = resolve(root, shareCardFile(event.slug));
      await page.screenshot({ path: out, type: 'jpeg', quality: 86 });
      console.log(`  ${picture ? '▣' : '▢'} ${shareCardFile(event.slug)}`);
    }
  } finally {
    await browser.close();
    await rm(scratch, { force: true });
  }

  console.log(`\nwrote ${wanted.length} share card(s)`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
