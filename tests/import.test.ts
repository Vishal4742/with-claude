import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import { importRecords, repositoryRecords, type ImportSummary } from '../db/import';
import { collectOrganizations, organizationSlug } from '../db/import/organizations';
import * as schema from '../db/schema';

import { builders } from '../src/data/builders';
import { cities } from '../src/data/cities';
import { events } from '../src/data/events';
import { projects } from '../src/data/projects';

/**
 * The import, run for real.
 *
 * The claim that matters most is idempotency, and the only way to test it is
 * to actually run the thing twice against a real database and count rows — so
 * that is what happens below, once, in `beforeAll`, with every later test
 * inspecting the result.
 */
let db: TestDatabase;
let first: ImportSummary;
let second: ImportSummary;

async function countOf(table: string): Promise<number> {
  const result = await db.execute(sql.raw(`select count(*)::int as n from ${table}`));
  return (result.rows as { n: number }[])[0].n;
}

const TABLES = [
  'organizations',
  'media',
  'cities',
  'builders',
  'ambassadors',
  'events',
  'projects',
  'event_co_hosts',
  'event_speakers',
  'event_organizations',
  'event_agenda_items',
  'event_outcomes',
  'event_photos',
  'project_builders',
  'social_links',
];

let afterFirst: Record<string, number>;
let afterSecond: Record<string, number>;

beforeAll(async () => {
  db = await createTestDatabase();

  first = await importRecords(db);
  afterFirst = Object.fromEntries(
    await Promise.all(TABLES.map(async (t) => [t, await countOf(t)])),
  );

  second = await importRecords(db);
  afterSecond = Object.fromEntries(
    await Promise.all(TABLES.map(async (t) => [t, await countOf(t)])),
  );
}, 120_000);

afterAll(async () => {
  await db?.$close();
});

describe('the import runs', () => {
  it('brings in every record in the repository', () => {
    expect(first.cities).toBe(cities.length);
    expect(first.builders).toBe(builders.length);
    expect(first.events).toBe(events.length);
    expect(first.projects).toBe(projects.length);
  });

  it('leaves the TypeScript record untouched as the public source of truth', () => {
    // Not a filesystem assertion — the point is that the modules the site
    // renders from are still fully populated after an import has run.
    expect(events.length).toBeGreaterThan(0);
    expect(cities.length).toBeGreaterThan(0);
    expect(projects.length).toBeGreaterThan(0);
  });
});

describe('idempotency', () => {
  it('reports the same counts on a second run', () => {
    expect(second).toEqual(first);
  });

  it('does not duplicate a single row anywhere', () => {
    expect(afterSecond).toEqual(afterFirst);
  });

  it('leaves exactly one row per slug', async () => {
    for (const [table, column] of [
      ['cities', 'slug'],
      ['builders', 'slug'],
      ['events', 'slug'],
      ['projects', 'slug'],
      ['organizations', 'slug'],
      ['media', 'path'],
    ] as const) {
      const result = await db.execute(
        sql.raw(
          `select count(*)::int as n from (
             select ${column} from ${table} group by ${column} having count(*) > 1
           ) duplicated`,
        ),
      );
      expect((result.rows as { n: number }[])[0].n, `${table}.${column}`).toBe(0);
    }
  });
});

describe('organization normalization', () => {
  it('creates one row per real organisation, not one per mention', async () => {
    // "The Origin Guild" is named on nine events and is also the Bhopal city
    // organiser. That is one organisation.
    const mentions =
      events.flatMap((e) => e.host.organisations ?? []).length +
      cities.filter((c) => c.organiser).length;

    const rows = await countOf('organizations');
    expect(mentions).toBeGreaterThan(rows);
    expect(rows).toBe(collectOrganizations(repositoryRecords).length);
  });

  it('folds the city organiser and the event host into the same record', async () => {
    const [row] = await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, organizationSlug('The Origin Guild')));

    expect(row).toBeDefined();
    expect(row.name).toBe('The Origin Guild');
    // The URL only appears on the city organiser. Folding must not lose it.
    expect(row.url).toBe('https://t.me/tog_guild');

    const [city] = await db.select().from(schema.cities).where(eq(schema.cities.slug, 'bhopal'));
    expect(city.organiserId).toBe(row.id);

    const links = await db
      .select()
      .from(schema.eventOrganizations)
      .where(eq(schema.eventOrganizations.organizationId, row.id));
    expect(links.length).toBeGreaterThan(1);
  });

  it('invents no organisation that is not in the source data', async () => {
    const named = new Set(
      [
        ...events.flatMap((e) => e.host.organisations ?? []),
        ...cities.flatMap((c) => (c.organiser ? [c.organiser.name] : [])),
      ].map((name) => organizationSlug(name)),
    );

    const rows = await db.select({ slug: schema.organizations.slug }).from(schema.organizations);
    for (const row of rows) {
      expect(named, `organisation ${row.slug}`).toContain(row.slug);
    }
  });

  it('deduplicates case and spacing differences', () => {
    expect(organizationSlug('The Origin Guild')).toBe(organizationSlug('the  origin   guild'));
  });
});

describe('timestamps are evidenced or absent', () => {
  it('dates every event from the day it was held, not from the import', async () => {
    const rows = await db
      .select({
        slug: schema.events.slug,
        date: schema.events.date,
        createdAt: schema.events.createdAt,
      })
      .from(schema.events);

    expect(rows.length).toBe(events.length);
    for (const row of rows) {
      expect(row.createdAt, `event ${row.slug}`).not.toBeNull();
      // The instant must fall on the event's own calendar day in IST, which is
      // the evidence. Anything else would be a guess.
      const istDay = new Date(row.createdAt!.getTime() + 5.5 * 3_600_000)
        .toISOString()
        .slice(0, 10);
      expect(istDay, `event ${row.slug}`).toBe(row.date);
    }
  });

  it('leaves cities and ambassadors undated, because nothing evidences a date', async () => {
    const cityRows = await db.select({ createdAt: schema.cities.createdAt }).from(schema.cities);
    expect(cityRows.every((r) => r.createdAt === null)).toBe(true);

    const ambRows = await db
      .select({ createdAt: schema.ambassadors.createdAt })
      .from(schema.ambassadors);
    expect(ambRows.every((r) => r.createdAt === null)).toBe(true);
  });

  it('dates only the Impact Lab cohort of builders, and leaves the rest undated', async () => {
    const impactLabSlugs = new Set(
      projects
        .filter((p) => p.builtAtEventSlug === 'claude-code-impact-lab')
        .flatMap((p) => p.builderSlugs),
    );

    const rows = await db
      .select({ slug: schema.builders.slug, createdAt: schema.builders.createdAt })
      .from(schema.builders);

    for (const row of rows) {
      if (impactLabSlugs.has(row.slug)) {
        expect(row.createdAt, `Impact Lab builder ${row.slug}`).not.toBeNull();
      } else {
        expect(row.createdAt, `builder ${row.slug} has no evidenced date`).toBeNull();
      }
    }

    // And the two published community members are genuinely in the undated set.
    const undated = rows.filter((r) => r.createdAt === null).map((r) => r.slug);
    expect(undated).toContain('aniket-sahu');
    expect(undated).toContain('vishal-kumar');
  });
});

/**
 * `updated_at` moves only when something actually changed.
 *
 * Found the hard way: a real Neon verification of the equivalence suite
 * (Phase 3, real-database step) surfaced `updatedAt` differing between the TS
 * record (which never sets it) and the database — because every re-import
 * was stamping `now()` on every row regardless of whether its content had
 * moved. `beforeAll` above already imports twice, which is exactly the
 * scenario that exposed it: these assertions are the regression test for
 * that finding.
 *
 * The record itself has no notion of `updatedAt` at all, so there is nothing
 * to compare a database value AGAINST for equivalence — the only thing that
 * can be asserted here is the database's own internal honesty: unchanged
 * content must not produce a new timestamp, and changed content must.
 */
describe('updated_at reflects a real change, not a real import', () => {
  it('does not advance on a second import that changed nothing', async () => {
    // `beforeAll` has already imported the unmodified record twice. If a
    // no-op upsert bumped the timestamp, every row would show two distinct
    // instants; a correct upsert leaves every row showing one.
    const tables: [string, string][] = [
      ['cities', 'bhopal'],
      ['builders', 'aniket-sahu'],
      ['ambassadors', 'aniket-sahu'],
      ['events', 'claude-code-for-builders'],
      ['projects', 'navdisha'],
      ['organizations', null as never],
    ];

    for (const [table, slug] of tables) {
      if (table === 'organizations') continue; // covered by its own test below
      const rows = await db.execute(
        sql.raw(`select updated_at from ${table} where slug = '${slug}'`),
      );
      expect(rows.rows.length, `${table}/${slug} exists`).toBe(1);
    }

    // The direct claim: re-running the identical import a third time produces
    // NO change in any `updated_at` across the whole record.
    const before = await db.execute(sql`
      select 'cities' as t, slug, updated_at from cities
      union all select 'builders', slug, updated_at from builders
      union all select 'ambassadors', slug, updated_at from ambassadors
      union all select 'events', slug, updated_at from events
      union all select 'projects', slug, updated_at from projects
      union all select 'stories', slug, updated_at from stories
      union all select 'use_cases', slug, updated_at from use_cases
      union all select 'guides', slug, updated_at from guides
      order by t, slug
    `);

    await importRecords(db, repositoryRecords);

    const after = await db.execute(sql`
      select 'cities' as t, slug, updated_at from cities
      union all select 'builders', slug, updated_at from builders
      union all select 'ambassadors', slug, updated_at from ambassadors
      union all select 'events', slug, updated_at from events
      union all select 'projects', slug, updated_at from projects
      union all select 'stories', slug, updated_at from stories
      union all select 'use_cases', slug, updated_at from use_cases
      union all select 'guides', slug, updated_at from guides
      order by t, slug
    `);

    expect(after.rows).toEqual(before.rows);
  });

  it('advances only the row whose content actually changed', async () => {
    const [beforeRow] = await db
      .select({ updatedAt: schema.cities.updatedAt })
      .from(schema.cities)
      .where(eq(schema.cities.slug, 'bhopal'));

    // Every OTHER city's timestamp, to prove they are untouched by a change
    // to one row.
    const othersBefore = await db
      .select({ slug: schema.cities.slug, updatedAt: schema.cities.updatedAt })
      .from(schema.cities);

    // A real content change: a new blurb for exactly one city.
    const mutated = repositoryRecords.cities.map((city) =>
      city.slug === 'bhopal' ? { ...city, blurb: `${city.blurb} (edited for this test)` } : city,
    );

    await importRecords(db, { ...repositoryRecords, cities: mutated });

    const [afterRow] = await db
      .select({ updatedAt: schema.cities.updatedAt, blurb: schema.cities.blurb })
      .from(schema.cities)
      .where(eq(schema.cities.slug, 'bhopal'));

    expect(afterRow.blurb).toContain('(edited for this test)');
    expect(afterRow.updatedAt).not.toBeNull();
    expect(afterRow.updatedAt!.getTime()).toBeGreaterThan(beforeRow.updatedAt?.getTime() ?? 0);

    const othersAfter = await db
      .select({ slug: schema.cities.slug, updatedAt: schema.cities.updatedAt })
      .from(schema.cities);

    for (const before of othersBefore) {
      if (before.slug === 'bhopal') continue;
      const after = othersAfter.find((r) => r.slug === before.slug);
      expect(after?.updatedAt, `${before.slug} should be untouched`).toEqual(before.updatedAt);
    }

    // Restore the record to what every other test in this file expects.
    await importRecords(db, repositoryRecords);
  });

  it("organizations' coalesced url does not falsely register as a change", async () => {
    // The one column with a coalesce fallback rather than a plain write —
    // regression-tested on its own because a naive comparison against
    // `excluded.url` would misfire on it. See the comment at the call site.
    const before = await db.execute(
      sql`select slug, updated_at from organizations order by slug`,
    );

    await importRecords(db, repositoryRecords);

    const after = await db.execute(
      sql`select slug, updated_at from organizations order by slug`,
    );
    expect(after.rows).toEqual(before.rows);
  });
});

describe('governance survives the import', () => {
  it("keeps a moderator's restriction on a project", async () => {
    const where = eq(schema.projects.slug, repositoryRecords.projects[0].slug);
    await db.update(schema.projects).set({ moderationState: 'restricted' }).where(where);
    try {
      await importRecords(db, repositoryRecords);
      const [row] = await db
        .select({ state: schema.projects.moderationState })
        .from(schema.projects)
        .where(where);
      expect(row.state).toBe('restricted');
    } finally {
      await db.update(schema.projects).set({ moderationState: 'clean' }).where(where);
    }
  }, 120_000);

  it('strips the ambassador role a builder record claims', async () => {
    const [row] = await db
      .select()
      .from(schema.builders)
      .where(eq(schema.builders.slug, 'aniket-sahu'));

    // The source record says `roles: ['ambassador', 'host', 'speaker']`.
    expect(builders.find((b) => b.slug === 'aniket-sahu')?.roles).toContain('ambassador');
    // The database does not, and would have refused it.
    expect(row.roles).not.toContain('ambassador');
    expect(row.roles).toEqual(['host', 'speaker']);
  });

  it('carries the ambassador record with its provenance instead', async () => {
    const rows = await db.select().from(schema.ambassadors);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.verifiedVia.trim().length).toBeGreaterThan(0);
      expect(row.title).toBe('Claude Community Ambassador');
    }
  });

  it('stores door states without inventing a lifecycle', async () => {
    const [soldOut] = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.slug, 'claude-code-impact-lab'));
    expect(soldOut.statusOverride).toBe('sold-out');

    const [plain] = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.slug, 'claude-meetup-delhi'));
    expect(plain.statusOverride).toBeNull();
  });

  it('preserves `featured` as a flag rather than losing it to the status enum', async () => {
    const featuredSlug = events.find((e) => e.status === 'featured')?.slug;
    expect(featuredSlug).toBeDefined();

    const [row] = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.slug, featuredSlug!));
    expect(row.status).toBe('published');
    expect(row.featured).toBe(true);
  });

  it('imports only media that carries alt text', async () => {
    const rows = await db.select().from(schema.media);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.alt.trim().length).toBeGreaterThan(0);
    }
    // The images with no authored alt text are reported, not quietly dropped.
    expect(first.mediaSkippedForMissingAlt).toBeGreaterThan(0);
  });
});

describe('unresolved references fail loudly', () => {
  /**
   * The claim under test: a reference that does not resolve stops the import,
   * rather than being written as a null that looks like a record with nothing
   * attached to it. A silently broken graph is worse than no import, because
   * it looks like it worked.
   *
   * Each case hands the importer a record set with exactly one bad reference
   * and asserts it throws — and that the error names the record and the
   * reference, so the failure alone is enough to fix it.
   */
  async function expectImportToReject(
    mutate: (source: typeof repositoryRecords) => typeof repositoryRecords,
    naming: RegExp,
  ): Promise<void> {
    const fresh = await createTestDatabase();
    try {
      await expect(importRecords(fresh, mutate(repositoryRecords))).rejects.toThrow(naming);
    } finally {
      await fresh.$close();
    }
  }

  it('rejects a project crediting a builder who is not in the record', async () => {
    await expectImportToReject(
      (source) => ({
        ...source,
        projects: [
          { ...source.projects[0], slug: 'broken-credit', builderSlugs: ['nobody-at-all'] },
          ...source.projects.slice(1),
        ],
      }),
      /nobody-at-all/,
    );
  }, 120_000);

  it('rejects an event in a city that does not exist', async () => {
    await expectImportToReject(
      (source) => ({
        ...source,
        events: [
          { ...source.events[0], slug: 'broken-city', citySlug: 'atlantis' },
          ...source.events.slice(1),
        ],
      }),
      /atlantis/,
    );
  }, 120_000);

  it('rejects an event hosted by an ambassador who is not on the record', async () => {
    await expectImportToReject(
      (source) => ({
        ...source,
        events: [
          {
            ...source.events[0],
            slug: 'broken-host',
            host: { ambassadorSlug: 'not-an-ambassador' },
          },
          ...source.events.slice(1),
        ],
      }),
      /not-an-ambassador/,
    );
  }, 120_000);

  it('rejects a builder in a city that does not exist', async () => {
    await expectImportToReject(
      (source) => ({
        ...source,
        builders: [
          { ...source.builders[0], slug: 'broken-builder-city', citySlug: 'narnia' },
          ...source.builders.slice(1),
        ],
      }),
      /narnia/,
    );
  }, 120_000);

  it('writes nothing that would need the broken reference', async () => {
    const fresh = await createTestDatabase();
    try {
      const broken = {
        ...repositoryRecords,
        projects: [
          {
            ...repositoryRecords.projects[0],
            slug: 'broken-credit',
            builderSlugs: ['nobody-at-all'],
          },
          ...repositoryRecords.projects.slice(1),
        ],
      };
      await expect(importRecords(fresh, broken)).rejects.toThrow();

      // The project row itself may exist — the import stops at the credit, not
      // before it. What must NOT exist is a project_builders row with a null
      // or invented builder.
      const credits = await fresh.select().from(schema.projectBuilders);
      for (const credit of credits) {
        expect(credit.builderId).not.toBeNull();
      }
      const orphans = await fresh.execute(sql`
        select count(*)::int as n from project_builders pb
        left join builders b on b.id = pb.builder_id
        where b.id is null`);
      expect((orphans.rows as { n: number }[])[0].n).toBe(0);
    } finally {
      await fresh.$close();
    }
  }, 120_000);

  it('refuses to merge two organisations onto one slug', () => {
    expect(() => collectOrganizations(repositoryRecords)).not.toThrow();

    expect(() =>
      collectOrganizations({
        cities: [
          {
            ...repositoryRecords.cities[0],
            organiser: { name: 'Origin & Guild' },
          },
        ],
        events: [
          {
            ...repositoryRecords.events[0],
            host: { organisations: ['Origin and Guild'] },
          },
        ],
      }),
    ).toThrow(/claimed by both/);
  });
});
