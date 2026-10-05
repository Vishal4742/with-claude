/**
 * WHERE AN EVENT'S SHARE CARD LIVES.
 *
 * The pure half of the share-card contract: the naming rule and the size, with
 * no build-tool features in it, so the generator (`scripts/og-events.ts`, run
 * by plain `tsx`) and the site (`src/lib/images.ts`, which needs Vite's
 * `import.meta.glob`) can agree about a filename without one of them being
 * unable to load the other.
 *
 * ── WHY THE CARDS ARE ASSETS AND NOT FILES IN `public/` ──────────────────
 *
 * The defect this fixes was a URL that resolved to nothing: the event page
 * passed the data-layer key `covers/cover-vol01.jpg` to the layout, which made
 * it `https://www.withclaude.in/covers/cover-vol01.jpg` — a path the site has
 * never served, because covers reach the browser through Astro's image
 * pipeline as hashed `/_astro/…` URLs. Eight of seventeen events advertised a
 * 404 to every link unfurler that asked.
 *
 * There were two ways to make the declared URL resolve. `git mv` the pictures
 * into `public/` and declare a root-relative path, or keep them as assets and
 * declare the URL the pipeline already emits. This is the second, for three
 * reasons:
 *
 *  1. CACHE CORRECTNESS, WHICH FOR A SHARE CARD IS THE WHOLE GAME. A card's
 *     URL is scraped once by WhatsApp, X, LinkedIn and Slack and then cached
 *     by them for a long time. A content-hashed URL changes when and only when
 *     the picture changes, so a corrected card is a NEW url and every scraper
 *     re-fetches it. A stable `/og/events/<slug>.jpg` would have to choose
 *     between `immutable` (fast, and stale forever after a fix) and short-lived
 *     (correct, and uncached). Hashing refuses the choice.
 *  2. `vercel.json` ALREADY SERVES `/_astro/*` AS `immutable`, so this route
 *     needs no new deploy configuration to get year-long caching right.
 *  3. ONE MECHANISM, NOT TWO. `src/lib/images.ts` is already how this codebase
 *     turns a key into a URL, and already how the event page resolves the
 *     picture it draws in the body. Resolving the share card the same way is
 *     what stops the page and its card ever disagreeing about which picture an
 *     event has — which is exactly how they came to disagree in the first
 *     place.
 */

/** What `twitter:card = summary_large_image` asks for, and what we emit. */
export const SHARE_CARD_WIDTH = 1200;
export const SHARE_CARD_HEIGHT = 630;

/** Under `src/assets/`, so the generated cards go through the image pipeline. */
export const SHARE_CARD_DIR = 'og/events';

/**
 * The card every page falls back to.
 *
 * Root-relative and a real file in `public/`, which is why it was the one
 * thing on the site that shared correctly the whole time. An event added to
 * the database after the last `npm run og:events` lands here rather than on a
 * 404 — a generic card is a worse card, never a broken one.
 */
export const DEFAULT_SHARE_IMAGE = '/og-card.jpg';

/** An event's card as an image-registry key (`src/lib/images.ts`). */
export function shareCardKey(slug: string): string {
  return `${SHARE_CARD_DIR}/${slug}.jpg`;
}

/** The same card as a repo-relative path. What the generator writes to. */
export function shareCardFile(slug: string): string {
  return `src/assets/${shareCardKey(slug)}`;
}
