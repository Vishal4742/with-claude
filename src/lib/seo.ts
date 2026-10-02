/**
 * SEO — titles, breadcrumbs and structured data.
 *
 * One rule governs this file, and it is the same rule as the rest of the site:
 * **structured data must match visible content.** Nothing here marks up a fact
 * the page does not show, and nothing here asserts a relationship the record
 * does not contain. Marking up an invented author or a hidden keyword is the
 * fastest way to lose the trust this site is trying to accumulate.
 *
 * The second rule is about titles. Every page gets a distinct one built from
 * its own record, and it has to read like a sentence a person would write. A
 * title that lists keywords separated by pipes wins nothing and costs the
 * click, so the templates below stop at two segments plus the brand.
 */

import { site } from '@/data/site';

export interface Crumb {
  name: string;
  /** Root-relative. The last crumb is the current page and is not linked. */
  href: string;
}

/**
 * Home → Events → Bhopal → Claude Conversation.
 *
 * Always begins at the homepage, so the trail a crawler reads is the trail a
 * reader sees.
 */
export function trail(...crumbs: Crumb[]): Crumb[] {
  return [{ name: 'Home', href: '/' }, ...crumbs];
}

/** `BreadcrumbList`, absolute-URL'd against the canonical domain. */
export function breadcrumbSchema(crumbs: Crumb[]): Record<string, unknown> {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: crumb.name,
      item: `${site.url}${crumb.href === '/' ? '' : crumb.href}`,
    })),
  };
}

// =========================================================================
// TITLES
// =========================================================================

/**
 * Page titles, per entity.
 *
 * Each reads naturally and carries the terms a person would actually type,
 * in that order of priority. None of them stuff: `Claude events India meetup
 * workshop community 2026` is not a title, it is a bid, and it reads like one
 * in a result list.
 */
export const titles = {
  home: () => `${site.wordmark} | Claude community, builders and events in India`,
  events: () => `Claude Events in India | ${site.wordmark}`,
  event: (name: string, city: string) => `${name} in ${city} | ${site.wordmark}`,
  cities: () => `Claude Communities in India | ${site.wordmark}`,
  city: (name: string) => `Claude Community in ${name} | ${site.wordmark}`,
  builders: () => `Claude Builders in India | ${site.wordmark}`,
  /**
   * §41 — ambassador pages are indexable public profiles.
   *
   * "Community Ambassadors" and not "Official Anthropic Ambassadors": §54 is
   * explicit that the site must not claim official standing on somebody's
   * behalf, and a page title is the single most quoted string on a page.
   */
  ambassadors: () => `Claude Community Ambassadors in India | ${site.wordmark}`,
  ambassador: (name: string, city: string) =>
    `${name} | Claude Community Ambassador in ${city} | ${site.wordmark}`,
  builder: (name: string, _city: string) => `${name} | Claude Community Builder | ${site.wordmark}`,
  projects: () => `Projects Built With Claude | ${site.wordmark}`,
  project: (name: string, _city: string) => `${name} | Built With Claude | ${site.wordmark}`,
  useCases: () => `How India uses Claude | Real workflows from the community`,
  useCase: (name: string, category: string) => `${name} | ${category} Workflow | ${site.wordmark}`,
  guides: () => 'Claude guides, written by the people who did it',
  guide: (name: string) => `${name} | ${site.wordmark}`,
  stories: () => 'From the community | Recaps, photo essays and field reports',
  story: (name: string) => `${name} | ${site.wordmark}`,
  discover: () => 'Search the Claude community in India',
  about: () => 'How the record works | Verification, sources and corrections',
  record: () => 'The record | Everything that has happened, by month',
} as const;

// =========================================================================
// ENTITY SCHEMA
// =========================================================================

export interface PersonFacts {
  name: string;
  slug: string;
  city?: string;
  /** Rendered on the page. Do not pass a role the profile does not show. */
  role?: string;
  bio?: string;
  links?: { label: string; url: string }[];
  image?: string;
}

/**
 * `ProfilePage` wrapping a `Person`.
 *
 * `sameAs` only ever carries links the profile actually renders, because an
 * unrendered `sameAs` is a claim about someone's identity that the page does
 * not stand behind. `worksFor` is deliberately absent: being in this index is
 * not employment, and it is not membership of anything.
 */
export function profileSchema(person: PersonFacts, url: string): Record<string, unknown>[] {
  const node: Record<string, unknown> = {
    '@type': 'Person',
    '@id': `${url}#person`,
    name: person.name,
    ...(person.role ? { jobTitle: person.role } : {}),
    ...(person.bio ? { description: person.bio } : {}),
    ...(person.city
      ? {
          homeLocation: {
            '@type': 'Place',
            name: person.city,
            address: {
              '@type': 'PostalAddress',
              addressLocality: person.city,
              addressCountry: 'IN',
            },
          },
        }
      : {}),
    ...(person.image ? { image: person.image } : {}),
    ...(person.links?.length ? { sameAs: person.links.map((link) => link.url) } : {}),
    url,
  };

  return [
    node,
    {
      '@type': 'ProfilePage',
      '@id': `${url}#profile`,
      url,
      name: person.name,
      mainEntity: { '@id': `${url}#person` },
      isPartOf: { '@id': `${site.url}/#website` },
    },
  ];
}

export interface ArticleFacts {
  headline: string;
  description: string;
  published: string;
  modified?: string;
  /** The byline as printed. Omitted entirely when the page has no byline. */
  authorName?: string;
  authorUrl?: string;
  image?: string;
  /** Only cited sources the page renders. */
  sources?: { label: string; url?: string }[];
}

/**
 * `Article` for stories, guides and use cases.
 *
 * `author` is omitted rather than defaulted to the organisation when a piece
 * has no byline. A fabricated author is the single most damaging thing that
 * can be put in this graph, and "the site wrote it" is not an author.
 */
export function articleSchema(article: ArticleFacts, url: string): Record<string, unknown> {
  const citations = (article.sources ?? []).filter((source) => source.url);

  return {
    '@type': 'Article',
    '@id': `${url}#article`,
    headline: article.headline,
    description: article.description,
    datePublished: article.published,
    dateModified: article.modified ?? article.published,
    ...(article.authorName
      ? {
          author: {
            '@type': 'Person',
            name: article.authorName,
            ...(article.authorUrl ? { url: article.authorUrl } : {}),
          },
        }
      : {}),
    ...(article.image ? { image: article.image } : {}),
    ...(citations.length ? { citation: citations.map((source) => source.url) } : {}),
    publisher: { '@id': `${site.url}/#organization` },
    mainEntityOfPage: url,
    isPartOf: { '@id': `${site.url}/#website` },
  };
}

/**
 * The `WebSite` node, with the internal search endpoint.
 *
 * `/discover` is a real page that really answers `?q=`, which is the only
 * condition under which this markup should ever be emitted.
 */
export function websiteSchema(): Record<string, unknown> {
  return {
    '@type': 'WebSite',
    '@id': `${site.url}/#website`,
    url: site.url,
    name: site.wordmark,
    description: site.positioning,
    inLanguage: 'en-IN',
    publisher: { '@id': `${site.url}/#organization` },
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${site.url}/discover?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  };
}

/**
 * A plain `ItemList` for index pages.
 *
 * Used only where the page renders the list it describes, in the order it
 * describes — an ItemList that does not match what is on screen is noise.
 */
export function itemListSchema(
  items: { name: string; href: string }[],
  name: string,
): Record<string, unknown> {
  return {
    '@type': 'ItemList',
    name,
    numberOfItems: items.length,
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      url: `${site.url}${item.href}`,
    })),
  };
}

/**
 * JSON for any inline `<script>` payload: `application/ld+json` structured
 * data and the `application/json` islands components read on the client.
 *
 * `JSON.stringify` does not escape `<`, so a member-written project title or a
 * feed-supplied event title containing `</script>` would close the script
 * element and run whatever followed: stored XSS. Escaping `<`, `>` and `&` as
 * JSON unicode escapes keeps the JSON identical to a parser and inert to the
 * HTML tokenizer. U+2028/U+2029 are escaped for old JS engines.
 */
const INLINE_JSON_ESCAPES: [string, string][] = [
  ['<', '003c'],
  ['>', '003e'],
  ['&', '0026'],
  [String.fromCharCode(0x2028), '2028'],
  [String.fromCharCode(0x2029), '2029'],
];

export function safeInlineJson(value: unknown): string {
  let json = JSON.stringify(value);
  for (const [char, code] of INLINE_JSON_ESCAPES) {
    // A JSON unicode escape: backslash, `u`, four hex digits.
    json = json.split(char).join(`\\u${code}`);
  }
  return json;
}
