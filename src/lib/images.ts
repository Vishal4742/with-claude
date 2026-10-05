import type { ImageMetadata } from 'astro';
import { DEFAULT_SHARE_IMAGE, shareCardKey } from './share-card';

/**
 * Image registry.
 *
 * Data files reference images by a path relative to `src/assets` (a plain
 * string), so the data layer stays free of build-tool imports and can be
 * unit-tested. This module resolves those strings to real `ImageMetadata`
 * that `<Image>` can optimise.
 */
const modules = import.meta.glob<{ default: ImageMetadata }>(
  '/src/assets/**/*.{jpg,jpeg,png,webp,avif}',
  { eager: true },
);

const registry = new Map<string, ImageMetadata>(
  Object.entries(modules).map(([path, mod]) => [path.replace('/src/assets/', ''), mod.default]),
);

/** Resolve a data-layer image key. Returns undefined for a missing asset. */
export function asset(key: string | undefined): ImageMetadata | undefined {
  if (!key) return undefined;
  return registry.get(key);
}

/**
 * Resolve, or throw. Use where a missing image is a build error rather than a
 * gracefully-empty slot.
 */
export function requireAsset(key: string): ImageMetadata {
  const found = registry.get(key);
  if (!found) {
    throw new Error(
      `Unknown image "${key}". Expected a file at src/assets/${key}. Known: ${[...registry.keys()].join(', ')}`,
    );
  }
  return found;
}

/**
 * The URL to publish as an event's `og:image`.
 *
 * Returns the hashed, pipeline-emitted URL of that event's generated card, or
 * the site-wide card when the event has none — a generic card, never a 404.
 * See `src/lib/share-card.ts` for why the cards are assets rather than files
 * in `public/`, and `scripts/og-events.ts` for what writes them.
 *
 * This is deliberately the ONLY way a page should name a share image. The
 * defect it replaces was a page passing a raw data-layer key straight to the
 * layout, where `new URL(image, site.url)` turned a string that was never a
 * URL into one that resolved to nothing.
 */
export function shareCard(slug: string): string {
  return asset(shareCardKey(slug))?.src ?? DEFAULT_SHARE_IMAGE;
}
