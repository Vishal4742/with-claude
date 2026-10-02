/**
 * Import the TypeScript record into PostgreSQL.
 *
 * `npm run db:import`. Safe to run as many times as you like — every write is
 * keyed on a stable slug and upserts, so a second run updates rows rather than
 * duplicating them, and a run interrupted halfway is repaired by the next one.
 *
 * THREE RULES THIS SCRIPT KEEPS
 *
 *  1. IT DOES NOT TOUCH `src/data/*.ts`. Those files stay the public site's
 *     source of truth for the whole of Phase 1. This is a copy into a database
 *     that nothing public reads yet.
 *
 *  2. IT DOES NOT INVENT A TIMESTAMP. The record has no `createdAt` on
 *     anything, so almost every `created_at` here stays NULL. The two
 *     exceptions are evidenced: an event was created no later than the day it
 *     was held, and the Impact Lab projects and their builders came off a
 *     submission form on a date the repository states. Everything else is left
 *     null, because a guessed date would show up in the activity feed as
 *     activity that never happened.
 *
 *  3. IT FAILS LOUDLY. An unresolvable city, builder, ambassador or event
 *     reference throws and the import stops. It never writes a null in place
 *     of a relationship it could not resolve — a silently broken graph is
 *     worse than no import, because it looks like it worked.
 */
import { and, eq, notInArray, or, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import { curatedCredits } from '../../src/lib/credits';
import { ambassadors } from '../../src/data/ambassadors';
import { builders } from '../../src/data/builders';
import { cities } from '../../src/data/cities';
import { events } from '../../src/data/events';
import { guides } from '../../src/data/guides';
import { projects } from '../../src/data/projects';
import { stories } from '../../src/data/stories';
import { useCases } from '../../src/data/use-cases';
import type {
  Ambassador,
  Builder,
  City,
  CommunityEvent,
  Guide,
  ModerationStatus,
  Project,
  Story,
  UseCase,
} from '../../src/data/types';

import * as schema from '../schema';
import { collectOrganizations, organizationKey } from './organizations';

export type ImportDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Everything the import reads.
 *
 * Passed in rather than imported at the point of use so the importer is a
 * function of its input: the tests hand it a deliberately broken record set to
 * prove that an unresolvable reference throws instead of being written as a
 * null. In every real run this is exactly the contents of `src/data/`.
 */
export interface RecordSource {
  ambassadors: Ambassador[];
  builders: Builder[];
  cities: City[];
  events: CommunityEvent[];
  guides: Guide[];
  projects: Project[];
  stories: Story[];
  useCases: UseCase[];
}

/** The record as the repository holds it today. */
export const repositoryRecords: RecordSource = {
  ambassadors,
  builders,
  cities,
  events,
  guides,
  projects,
  stories,
  useCases,
};

/** IST is UTC+05:30, no DST. Same constant the site's date helpers use. */
const IST_OFFSET = '+05:30';

/**
 * The Impact Lab submission form ran on the day of the event, and both
 * `projects.ts` and `builders.ts` say so in prose. That makes it an evidenced
 * date rather than a guess, which is the only reason it is used at all.
 */
const IMPACT_LAB_EVENT_SLUG = 'claude-code-impact-lab';

export interface ImportSummary {
  organizations: number;
  media: number;
  cities: number;
  builders: number;
  ambassadors: number;
  events: number;
  projects: number;
  stories: number;
  useCases: number;
  guides: number;
  /** Images in the record with no authored alt text, which are not imported. */
  mediaSkippedForMissingAlt: number;
}

/**
 * Fail loudly.
 *
 * Every cross-reference in the record goes through this. The message names the
 * record and the reference so the fix is obvious from the failure alone.
 */
function resolve<T>(map: Map<string, T>, key: string | undefined, context: string): T {
  if (key === undefined) {
    throw new Error(`${context}: expected a reference, found none.`);
  }
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(
      `${context}: "${key}" does not resolve. Known: ${[...map.keys()].slice(0, 8).join(', ')}` +
        `${map.size > 8 ? `, … (${map.size} total)` : ''}.`,
    );
  }
  return value;
}

/**
 * The four-value TypeScript moderation state, mapped onto the audited eight.
 *
 * `featured` is not a review state, so it becomes `published` plus a flag.
 * That is a widening, not a loss: the original value is recoverable from the
 * pair.
 */
function moderation(status: ModerationStatus): {
  status: (typeof schema.contentStatus.enumValues)[number];
  featured: boolean;
} {
  switch (status) {
    case 'featured':
      return { status: 'published', featured: true };
    case 'published':
      return { status: 'published', featured: false };
    case 'archived':
      return { status: 'archived', featured: false };
    case 'pending':
      return { status: 'pending', featured: false };
  }
}

/** An IST calendar date and wall clock, as an absolute instant. */
function istInstant(date: string, time = '00:00'): Date {
  return new Date(`${date}T${time}:00${IST_OFFSET}`);
}

/**
 * `updated_at`, written only when something the record actually reflects has
 * changed — never unconditionally.
 *
 * `ON CONFLICT DO UPDATE` runs on every import whether or not a row's content
 * differs from what is already stored, and a naive `updatedAt: new Date()` in
 * its `set` clause stamps every single row on every single run. That is not a
 * cosmetic detail: `updatedAt` is a real field on `RecordBase` — the record
 * leaves it unset because it has no notion of one, but the reader surfaces
 * whatever the database holds, and two public pages already render it as a
 * "last modified" date. A column that updates itself on every re-import is
 * indistinguishable from a lie about when something last changed, which is
 * exactly what rule 2 in the file header exists to prevent for `created_at` —
 * the same argument applies here.
 *
 * `columns` is every column this upsert's `set` clause writes, EXCLUDING
 * `updatedAt` itself. The expression compares each one against Postgres's
 * `excluded` pseudo-table — the row that was proposed for insertion — and
 * only advances the timestamp if at least one of them is actually different
 * from what is currently stored.
 */
function touchedAt(table: { updatedAt: unknown }, columns: unknown[]) {
  const conditions = columns.map((column) => sql`${column} IS DISTINCT FROM excluded.${sql.raw(String((column as { name: string }).name))}`);
  const changed = sql.join(conditions, sql` OR `);
  return sql`CASE WHEN ${changed} THEN now() ELSE ${table.updatedAt} END`;
}

/**
 * The same, derived automatically from a `values` object's own keys.
 *
 * Several upserts below write `{ ...values, updatedAt: new Date() }`, where
 * `values` is a plain object built a few lines above with every column this
 * table actually receives. Hand-listing those columns again for `touchedAt()`
 * is the kind of duplication that silently rots the moment a new field is
 * added to `values` and not to the list — so this reads the columns straight
 * off the table schema, keyed by the same names `values` already uses, which
 * makes the two impossible to drift apart.
 *
 * `slug` and `createdAt` are excluded: `slug` is the identity the row is
 * matched on, never itself a change, and `createdAt` has its own considered
 * handling per table (see the comments at each call site) rather than being
 * folded into "did anything change".
 */
function touchedAtFor(table: object, values: Record<string, unknown>): ReturnType<typeof sql> {
  const columnsByName = table as Record<string, unknown>;
  const columns = Object.keys(values)
    .filter((key) => key !== 'slug' && key !== 'createdAt')
    .map((key) => columnsByName[key]);
  return touchedAt(table as { updatedAt: unknown }, columns);
}

/**
 * Replace a record's rows in a join table with exactly the given set.
 *
 * Insert-only would leave a removed co-host credit in the database forever, so
 * this deletes what is no longer claimed. Rows that are still claimed are left
 * alone rather than deleted and re-inserted, so ids stay stable across runs.
 */
async function syncJoin<T extends Record<string, unknown>>(
  db: ImportDatabase,
  table: any,
  parentColumn: any,
  parentId: string,
  childColumn: any,
  rows: T[],
  childOf: (row: T) => string,
): Promise<void> {
  const wanted = rows.map(childOf);

  if (wanted.length === 0) {
    await db.delete(table).where(eq(parentColumn, parentId));
    return;
  }

  await db.delete(table).where(and(eq(parentColumn, parentId), notInArray(childColumn, wanted)));

  for (const row of rows) {
    await db.insert(table).values(row).onConflictDoNothing();
  }
}

/** Replace an ordered child list wholesale. Order is the identity here. */
async function replaceOrdered(
  db: ImportDatabase,
  table: any,
  parentColumn: any,
  parentId: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  await db.delete(table).where(eq(parentColumn, parentId));
  if (rows.length > 0) await db.insert(table).values(rows);
}

// =========================================================================

export async function importRecords(
  db: ImportDatabase,
  source: RecordSource = repositoryRecords,
): Promise<ImportSummary> {
  const {
    ambassadors: ambassadorRecords,
    builders: builderRecords,
    cities: cityRecords,
    events: eventRecords,
    guides: guideRecords,
    projects: projectRecords,
    stories: storyRecords,
    useCases: useCaseRecords,
  } = source;

  // ── Organisations ────────────────────────────────────────────────────
  const orgSeeds = collectOrganizations(source);
  const orgIdBySlug = new Map<string, string>();

  for (const seed of orgSeeds) {
    const [row] = await db
      .insert(schema.organizations)
      .values({ slug: seed.slug, name: seed.name, url: seed.url ?? null })
      .onConflictDoUpdate({
        target: schema.organizations.slug,
        set: {
          name: seed.name,
          // A URL is never unset by a later import that happens not to know it.
          url: sql`coalesce(excluded.url, ${schema.organizations.url})`,
          /**
           * `url`'s written value is `coalesce(excluded.url, <current url>)`,
           * not `excluded.url` itself, so `touchedAt()`'s plain
           * `IS DISTINCT FROM excluded.<col>` comparison would misfire here —
           * a seed with no URL always looks "unchanged" against its own
           * coalesce, which happens to be correct, but a seed that supplies
           * the SAME url the row already has would also read as "changed"
           * under a naive comparison against `excluded.url` when the two
           * happen to differ only because one is null. Compared directly
           * against the coalesced expression instead, so only a URL that
           * actually feeds the record moves the timestamp.
           */
          updatedAt: sql`CASE
            WHEN ${schema.organizations.name} IS DISTINCT FROM excluded.name
              OR coalesce(excluded.url, ${schema.organizations.url}) IS DISTINCT FROM ${schema.organizations.url}
            THEN now() ELSE ${schema.organizations.updatedAt} END`,
        },
      })
      .returning({ id: schema.organizations.id, slug: schema.organizations.slug });
    orgIdBySlug.set(row.slug, row.id);
  }

  // ── Media ────────────────────────────────────────────────────────────
  //
  // Only images the record actually describes get a `media` row. Event photos
  // carry authored alt text; cover images, portraits and city photographs do
  // not, and writing "Cover image for X" would be inventing a description of a
  // picture nobody looked at — the same failure as inventing a date. `media.alt`
  // stays NOT NULL and those images stay out of it.
  //
  // Phase 3 note: undescribed images are no longer dropped entirely. Their
  // asset path is written to the owning row's `image_path`, which is an asset
  // reference carrying no alt text and claiming none — see migration 0003. The
  // count below still reports them as lacking a description, because they do.
  const mediaIdByPath = new Map<string, string>();
  let mediaSkippedForMissingAlt = 0;

  for (const event of eventRecords) {
    for (const photo of event.photos ?? []) {
      const [row] = await db
        .insert(schema.media)
        .values({ path: photo.src, alt: photo.alt, kind: 'photo' })
        .onConflictDoUpdate({
          target: schema.media.path,
          set: { alt: photo.alt, kind: 'photo' },
        })
        .returning({ id: schema.media.id, path: schema.media.path });
      mediaIdByPath.set(row.path as string, row.id);
    }
    if (event.coverImage) mediaSkippedForMissingAlt += 1;
  }
  for (const city of cityRecords) if (city.image) mediaSkippedForMissingAlt += 1;
  for (const builder of builderRecords) if (builder.image) mediaSkippedForMissingAlt += 1;
  for (const project of projectRecords) if (project.image) mediaSkippedForMissingAlt += 1;

  // ── Cities ───────────────────────────────────────────────────────────
  //
  // Note what is not written: no state, no status beyond moderation, nothing
  // that could make a city look like a chapter. `region` is geography.
  const cityIdBySlug = new Map<string, string>();

  for (const city of cityRecords) {
    const { status, featured } = moderation(city.status);
    const organiserId = city.organiser
      ? resolve(orgIdBySlug, organizationKey(city.organiser.name), `city ${city.slug} organiser`)
      : null;

    const [row] = await db
      .insert(schema.cities)
      .values({
        slug: city.slug,
        name: city.name,
        region: city.state,
        lat: city.lat,
        lon: city.lon,
        blurb: city.blurb,
        interestCount: city.interest?.count ?? null,
        interestSource: city.interest?.source ?? null,
        reportedMembers: city.reported?.members ?? null,
        reportedPrototypes: city.reported?.prototypes ?? null,
        reportedSource: city.reported?.source ?? null,
        organiserId,
        imagePath: city.image ?? null,
        status,
        featured,
        // No evidenced creation date for a city. Left null on purpose.
        createdAt: null,
      })
      .onConflictDoUpdate({
        target: schema.cities.slug,
        set: {
          name: city.name,
          region: city.state,
          lat: city.lat,
          lon: city.lon,
          blurb: city.blurb,
          interestCount: city.interest?.count ?? null,
          interestSource: city.interest?.source ?? null,
          reportedMembers: city.reported?.members ?? null,
          reportedPrototypes: city.reported?.prototypes ?? null,
          reportedSource: city.reported?.source ?? null,
          organiserId,
          imagePath: city.image ?? null,
          status,
          featured,
          updatedAt: touchedAt(schema.cities, [
            schema.cities.name,
            schema.cities.region,
            schema.cities.lat,
            schema.cities.lon,
            schema.cities.blurb,
            schema.cities.interestCount,
            schema.cities.interestSource,
            schema.cities.reportedMembers,
            schema.cities.reportedPrototypes,
            schema.cities.reportedSource,
            schema.cities.organiserId,
            schema.cities.imagePath,
            schema.cities.status,
            schema.cities.featured,
          ]),
        },
      })
      .returning({ id: schema.cities.id, slug: schema.cities.slug });
    cityIdBySlug.set(row.slug, row.id);

    await replaceOrdered(
      db,
      schema.socialLinks,
      schema.socialLinks.ownerId,
      row.id,
      (city.links ?? []).map((link, i) => ({
        ownerType: 'city' as const,
        ownerId: row.id,
        position: i,
        label: link.label,
        url: link.url,
      })),
    );
  }

  // ── Builders ─────────────────────────────────────────────────────────
  //
  // The Impact Lab cohort is identified by evidence rather than by a list:
  // a builder credited on a project built at the Impact Lab came off that
  // event's submission form, on the day the record says the form ran.
  const impactLabEvent = eventRecords.find((e) => e.slug === IMPACT_LAB_EVENT_SLUG);
  const impactLabBuilderSlugs = new Set(
    projectRecords
      .filter((p) => p.builtAtEventSlug === IMPACT_LAB_EVENT_SLUG)
      .flatMap((p) => p.builderSlugs),
  );
  const impactLabSubmittedAt = impactLabEvent ? istInstant(impactLabEvent.date) : null;

  const builderIdBySlug = new Map<string, string>();

  for (const builder of builderRecords) {
    const { status, featured } = moderation(builder.status);
    const cityId = resolve(cityIdBySlug, builder.citySlug, `builder ${builder.slug} city`);

    /**
     * A builder does not get to declare themselves an Ambassador. The role is
     * stripped on the way in and the database would reject it anyway — see
     * the CHECK on `builders.roles`. Ambassador status is read from the
     * `ambassadors` table, with its provenance, or it is not read at all.
     */
    const roles = builder.roles.filter((role) => role !== 'ambassador');

    const createdAt =
      impactLabSubmittedAt && impactLabBuilderSlugs.has(builder.slug) ? impactLabSubmittedAt : null;

    const [row] = await db
      .insert(schema.builders)
      .values({
        slug: builder.slug,
        name: builder.name,
        cityId,
        role: builder.role,
        roles,
        bio: builder.bio ?? null,
        building: builder.building ?? null,
        claudeTools: builder.claudeTools ?? [],
        imagePath: builder.image ?? null,
        status,
        featured,
        createdAt,
      })
      .onConflictDoUpdate({
        target: schema.builders.slug,
        set: {
          name: builder.name,
          cityId,
          role: builder.role,
          roles,
          bio: builder.bio ?? null,
          building: builder.building ?? null,
          claudeTools: builder.claudeTools ?? [],
          imagePath: builder.image ?? null,
          status,
          featured,
          createdAt,
          updatedAt: touchedAt(schema.builders, [
            schema.builders.name,
            schema.builders.cityId,
            schema.builders.role,
            schema.builders.roles,
            schema.builders.bio,
            schema.builders.building,
            schema.builders.claudeTools,
            schema.builders.imagePath,
            schema.builders.status,
            schema.builders.featured,
            schema.builders.createdAt,
          ]),
        },
      })
      .returning({ id: schema.builders.id, slug: schema.builders.slug });
    builderIdBySlug.set(row.slug, row.id);

    await replaceOrdered(
      db,
      schema.socialLinks,
      schema.socialLinks.ownerId,
      row.id,
      (builder.links ?? []).map((link, i) => ({
        ownerType: 'builder' as const,
        ownerId: row.id,
        position: i,
        label: link.label,
        url: link.url,
      })),
    );
  }

  // ── Ambassadors ──────────────────────────────────────────────────────
  const ambassadorIdBySlug = new Map<string, string>();

  for (const ambassador of ambassadorRecords) {
    const { status } = moderation(ambassador.status);
    const cityId = resolve(cityIdBySlug, ambassador.citySlug, `ambassador ${ambassador.slug} city`);
    const builderId = ambassador.builderSlug
      ? resolve(builderIdBySlug, ambassador.builderSlug, `ambassador ${ambassador.slug} builder`)
      : null;

    const [row] = await db
      .insert(schema.ambassadors)
      .values({
        slug: ambassador.slug,
        name: ambassador.name,
        cityId,
        title: ambassador.title,
        // Required by the schema. The record cannot express an ambassador
        // without provenance and neither can the database.
        verifiedVia: ambassador.verifiedVia,
        builderId,
        since: ambassador.since ?? null,
        bio: ambassador.bio ?? null,
        imagePath: ambassador.image ?? null,
        status,
        createdAt: null,
      })
      .onConflictDoUpdate({
        target: schema.ambassadors.slug,
        set: {
          name: ambassador.name,
          cityId,
          title: ambassador.title,
          verifiedVia: ambassador.verifiedVia,
          builderId,
          since: ambassador.since ?? null,
          bio: ambassador.bio ?? null,
          imagePath: ambassador.image ?? null,
          status,
          updatedAt: touchedAt(schema.ambassadors, [
            schema.ambassadors.name,
            schema.ambassadors.cityId,
            schema.ambassadors.title,
            schema.ambassadors.verifiedVia,
            schema.ambassadors.builderId,
            schema.ambassadors.since,
            schema.ambassadors.bio,
            schema.ambassadors.imagePath,
            schema.ambassadors.status,
          ]),
        },
      })
      .returning({ id: schema.ambassadors.id, slug: schema.ambassadors.slug });
    ambassadorIdBySlug.set(row.slug, row.id);

    await replaceOrdered(
      db,
      schema.socialLinks,
      schema.socialLinks.ownerId,
      row.id,
      (ambassador.links ?? []).map((link, i) => ({
        ownerType: 'ambassador' as const,
        ownerId: row.id,
        position: i,
        label: link.label,
        url: link.url,
      })),
    );
  }

  // ── Events ───────────────────────────────────────────────────────────
  const eventIdBySlug = new Map<string, string>();

  for (const event of eventRecords) {
    const { status, featured } = moderation(event.status);
    const cityId = resolve(cityIdBySlug, event.citySlug, `event ${event.slug} city`);
    const ambassadorId = event.host.ambassadorSlug
      ? resolve(ambassadorIdBySlug, event.host.ambassadorSlug, `event ${event.slug} host`)
      : null;

    /**
     * The one evidenced timestamp on an event: it existed no later than the
     * day it happened. Not a guess, and not the moment the import ran.
     */
    const createdAt = istInstant(event.date, event.startTime);

    const values = {
      slug: event.slug,
      title: event.title,
      format: event.format,
      volume: event.volume ?? null,
      cityId,
      ambassadorId,
      date: event.date,
      startTime: event.startTime,
      endTime: event.endTime ?? null,
      rescheduledFrom: event.rescheduledFrom ?? null,
      shortTitle: event.shortTitle ?? null,
      venueName: event.venue.name,
      venueAddress: event.venue.address ?? null,
      venuePrivate: event.venue.private ?? false,
      summary: event.summary,
      description: event.description ?? null,
      registrationUrl: event.registrationUrl ?? null,
      // Door states only. There is no lifecycle column to write to.
      statusOverride: event.statusOverride ?? null,
      free: event.free,
      coverImagePath: event.coverImage ?? null,
      status,
      featured,
      createdAt,
    };

    const [row] = await db
      .insert(schema.events)
      .values(values)
      .onConflictDoUpdate({
        target: schema.events.slug,
        set: { ...values, updatedAt: touchedAtFor(schema.events, values) },
      })
      .returning({ id: schema.events.id, slug: schema.events.slug });
    eventIdBySlug.set(row.slug, row.id);

    // Co-hosts — builders who ran the room. Must resolve.
    await syncJoin(
      db,
      schema.eventCoHosts,
      schema.eventCoHosts.eventId,
      row.id,
      schema.eventCoHosts.builderId,
      (event.host.builderSlugs ?? []).map((slug) => ({
        eventId: row.id,
        builderId: resolve(builderIdBySlug, slug, `event ${event.slug} co-host`),
      })),
      (r) => r.builderId,
    );

    /**
     * ── CANONICAL HOST ATTRIBUTION ─────────────────────────────────────
     *
     * `event_hosts` written from the same rule that migration 0012 backfilled
     * with and that `source-ts.ts` synthesises from — `curatedCredits()`, so
     * all three agree by construction and `tests/equivalence.test.ts` can
     * compare the two sources at all.
     *
     * ── WHAT GETS DELETED, AND WHAT SURVIVES ───────────────────────────
     *
     * The repository record is authoritative for a curated event's HEADLINE
     * host: `values.ambassadorId` above is written from it unconditionally, so
     * the matching `primary_host` row has to be rewritten with it or the
     * invariant in `src/server/events/hosts.ts` breaks on the next import.
     *
     * A moderator's non-primary credit does NOT get deleted. Someone adding a
     * co-host or partner in the admin is recording something the repository
     * record has no way to express (§37), and an import that reverted it every
     * time would make the admin's own UI look broken. So: this import owns
     * `curated` rows and the primary role; `manual` co-host, organiser and
     * partner credits are left exactly where the moderator put them.
     *
     * Note that an INGESTED event never reaches this loop — it is not in the
     * repository record — so nothing here can touch a Luma attribution.
     */
    await db
      .delete(schema.eventHosts)
      .where(
        and(
          eq(schema.eventHosts.eventId, row.id),
          or(eq(schema.eventHosts.source, 'curated'), eq(schema.eventHosts.role, 'primary_host')),
        ),
      );

    for (const credit of curatedCredits(event.host)) {
      await db
        .insert(schema.eventHosts)
        .values({
          eventId: row.id,
          ambassadorId: resolve(
            ambassadorIdBySlug,
            credit.ambassadorSlug,
            `event ${event.slug} ${credit.role}`,
          ),
          role: credit.role,
          source: credit.source,
          confidence: credit.confidence.toFixed(2),
        })
        .onConflictDoNothing();
    }

    // Speakers — who talked. A separate credit from hosting.
    await syncJoin(
      db,
      schema.eventSpeakers,
      schema.eventSpeakers.eventId,
      row.id,
      schema.eventSpeakers.builderId,
      (event.speakerSlugs ?? []).map((slug) => ({
        eventId: row.id,
        builderId: resolve(builderIdBySlug, slug, `event ${event.slug} speaker`),
      })),
      (r) => r.builderId,
    );

    // Organisations — the normalised half of the point of this import.
    await syncJoin(
      db,
      schema.eventOrganizations,
      schema.eventOrganizations.eventId,
      row.id,
      schema.eventOrganizations.organizationId,
      (event.host.organisations ?? []).map((name) => ({
        eventId: row.id,
        organizationId: resolve(
          orgIdBySlug,
          organizationKey(name),
          `event ${event.slug} organisation`,
        ),
      })),
      (r) => r.organizationId,
    );

    await replaceOrdered(
      db,
      schema.eventAgendaItems,
      schema.eventAgendaItems.eventId,
      row.id,
      (event.agenda ?? []).map((item, i) => ({
        eventId: row.id,
        position: i,
        time: item.time ?? null,
        title: item.title,
        detail: item.detail ?? null,
      })),
    );

    await replaceOrdered(
      db,
      schema.eventOutcomes,
      schema.eventOutcomes.eventId,
      row.id,
      (event.outcomes ?? []).map((text, i) => ({ eventId: row.id, position: i, text })),
    );

    await replaceOrdered(
      db,
      schema.eventPhotos,
      schema.eventPhotos.eventId,
      row.id,
      (event.photos ?? []).map((photo, i) => ({
        eventId: row.id,
        mediaId: resolve(mediaIdByPath, photo.src, `event ${event.slug} photo`),
        position: i,
      })),
    );
  }

  // ── Attendance ───────────────────────────────────────────────────────
  //
  // Declared on the builder (`eventSlugs`) rather than on the event, so it is
  // synced here, once every event id is known.
  //
  // Only rooms the builder is not ALREADY credited in are written. Somebody
  // who hosted or spoke is on the record for that room through the credit that
  // says what they actually did, and adding a bare attendance row alongside it
  // would make `eventsOf()` count them twice and make the stronger credit
  // indistinguishable from having turned up.
  for (const builder of builderRecords) {
    const builderId = resolve(builderIdBySlug, builder.slug, `builder ${builder.slug}`);

    const attended = (builder.eventSlugs ?? []).filter((slug) => {
      const event = eventRecords.find((e) => e.slug === slug);
      const credited =
        event?.host.builderSlugs?.includes(builder.slug) ||
        event?.speakerSlugs?.includes(builder.slug);
      return !credited;
    });

    await syncJoin(
      db,
      schema.eventAttendees,
      schema.eventAttendees.builderId,
      builderId,
      schema.eventAttendees.eventId,
      attended.map((slug) => ({
        builderId,
        eventId: resolve(eventIdBySlug, slug, `builder ${builder.slug} attended event`),
      })),
      (r) => r.eventId,
    );
  }

  // ── Projects ─────────────────────────────────────────────────────────
  const projectIdBySlug = new Map<string, string>();

  for (const [index, project] of projectRecords.entries()) {
    const { status, featured } = moderation(project.status);
    const cityId = resolve(cityIdBySlug, project.citySlug, `project ${project.slug} city`);
    const builtAtEventId = project.builtAtEventSlug
      ? resolve(eventIdBySlug, project.builtAtEventSlug, `project ${project.slug} event`)
      : null;

    /**
     * An Impact Lab project was submitted on the day of the lab — the record
     * says so on every one of these entries ("Submitted at Bhopal Impact Lab ·
     * 23 Aug 2026"). Anything built elsewhere has no evidenced date and gets
     * none.
     */
    const createdAt =
      project.builtAtEventSlug === IMPACT_LAB_EVENT_SLUG ? impactLabSubmittedAt : null;

    const values = {
      slug: project.slug,
      title: project.title,
      cityId,
      summary: project.summary,
      description: project.description ?? null,
      category: project.category,
      url: project.url ?? null,
      repoUrl: project.repoUrl ?? null,
      videoUrl: project.videoUrl ?? null,
      tags: project.tags ?? [],
      imagePath: project.image ?? null,
      claudeUsage: project.claudeUsage ?? null,
      builtAtEventId,
      position: index,
      publicationStatus: (status === 'published' || featured) ? 'published' : 'draft',
      // No moderationState: it defaults to 'clean', and a re-import must not undo a moderator.
      status,
      featured,
      createdAt,
    } as const;

    const [row] = await db
      .insert(schema.projects)
      .values(values)
      .onConflictDoUpdate({
        target: schema.projects.slug,
        set: { ...values, updatedAt: touchedAtFor(schema.projects, values) },
      })
      .returning({ id: schema.projects.id, slug: schema.projects.slug });
    projectIdBySlug.set(row.slug, row.id);

    /**
     * Every credited builder must resolve. Impact Lab builders are `pending`
     * and have no public profile, but they exist as records — a project
     * crediting somebody who is not in `builders.ts` is a broken attribution
     * and stops the import.
     */
    await syncJoin(
      db,
      schema.projectBuilders,
      schema.projectBuilders.projectId,
      row.id,
      schema.projectBuilders.builderId,
      project.builderSlugs.map((slug, i) => ({
        projectId: row.id,
        builderId: resolve(builderIdBySlug, slug, `project ${project.slug} builder`),
        position: i,
      })),
      (r) => r.builderId,
    );
  }

  // ── Stories ──────────────────────────────────────────────────────────
  for (const story of storyRecords) {
    const { status, featured } = moderation(story.status);
    const cityId = story.citySlug
      ? resolve(cityIdBySlug, story.citySlug, `story ${story.slug} city`)
      : null;
    const eventId = story.eventSlug
      ? resolve(eventIdBySlug, story.eventSlug, `story ${story.slug} event`)
      : null;

    const values = {
      slug: story.slug,
      title: story.title,
      standfirst: story.standfirst,
      kind: story.kind,
      date: story.date,
      cityId,
      author: story.author ?? null,
      imagePath: story.image ?? null,
      eventId,
      readingMinutes: story.readingMinutes ?? null,
      body: story.body ?? [],
      status,
      featured,
      createdAt: null,
    };

    const [row] = await db
      .insert(schema.stories)
      .values(values)
      .onConflictDoUpdate({
        target: schema.stories.slug,
        set: { ...values, updatedAt: touchedAtFor(schema.stories, values) },
      })
      .returning({ id: schema.stories.id });

    await syncJoin(
      db,
      schema.storyBuilders,
      schema.storyBuilders.storyId,
      row.id,
      schema.storyBuilders.builderId,
      (story.builderSlugs ?? []).map((slug) => ({
        storyId: row.id,
        builderId: resolve(builderIdBySlug, slug, `story ${story.slug} builder`),
      })),
      (r) => r.builderId,
    );
  }

  // ── Use cases ────────────────────────────────────────────────────────
  for (const useCase of useCaseRecords) {
    const { status, featured } = moderation(useCase.status);
    const authorBuilderId = useCase.author.builderSlug
      ? resolve(builderIdBySlug, useCase.author.builderSlug, `use case ${useCase.slug} author`)
      : null;

    const values = {
      slug: useCase.slug,
      title: useCase.title,
      summary: useCase.summary,
      category: useCase.category,
      authorBuilderId,
      authorName: useCase.author.name ?? null,
      // NOT NULL by schema. No anonymous authority, at any layer.
      authorCredential: useCase.author.credential,
      cityId: useCase.citySlug
        ? resolve(cityIdBySlug, useCase.citySlug, `use case ${useCase.slug} city`)
        : null,
      date: useCase.date,
      problem: useCase.problem,
      context: useCase.context,
      claudeDid: useCase.claudeDid,
      humanDid: useCase.humanDid,
      tools: useCase.tools,
      result: useCase.result,
      imagePath: useCase.image ?? null,
      projectId: useCase.projectSlug
        ? resolve(projectIdBySlug, useCase.projectSlug, `use case ${useCase.slug} project`)
        : null,
      eventId: useCase.eventSlug
        ? resolve(eventIdBySlug, useCase.eventSlug, `use case ${useCase.slug} event`)
        : null,
      status,
      featured,
      createdAt: null,
    };

    const [row] = await db
      .insert(schema.useCases)
      .values(values)
      .onConflictDoUpdate({
        target: schema.useCases.slug,
        set: { ...values, updatedAt: touchedAtFor(schema.useCases, values) },
      })
      .returning({ id: schema.useCases.id });

    await replaceOrdered(
      db,
      schema.useCaseWorkflowSteps,
      schema.useCaseWorkflowSteps.useCaseId,
      row.id,
      useCase.workflow.map((step, i) => ({
        useCaseId: row.id,
        position: i,
        title: step.title,
        detail: step.detail,
        by: step.by,
      })),
    );

    await replaceOrdered(
      db,
      schema.useCaseArtifacts,
      schema.useCaseArtifacts.useCaseId,
      row.id,
      (useCase.artifacts ?? []).map((artifact, i) => ({
        useCaseId: row.id,
        position: i,
        label: artifact.label,
        body: artifact.body,
      })),
    );

    await replaceOrdered(
      db,
      schema.sources,
      schema.sources.ownerId,
      row.id,
      (useCase.sources ?? []).map((source, i) => ({
        ownerType: 'use_case' as const,
        ownerId: row.id,
        position: i,
        label: source.label,
        url: source.url ?? null,
        retrieved: source.retrieved ?? null,
      })),
    );
  }

  // ── Guides ───────────────────────────────────────────────────────────
  for (const guide of guideRecords) {
    const { status, featured } = moderation(guide.status);

    const values = {
      slug: guide.slug,
      title: guide.title,
      question: guide.question,
      standfirst: guide.standfirst,
      authorBuilderId: guide.author.builderSlug
        ? resolve(builderIdBySlug, guide.author.builderSlug, `guide ${guide.slug} author`)
        : null,
      authorName: guide.author.name ?? null,
      authorCredential: guide.author.credential,
      published: guide.published,
      modified: guide.modified ?? null,
      readingMinutes: guide.readingMinutes ?? null,
      imagePath: guide.image ?? null,
      status,
      featured,
      createdAt: null,
    };

    const [row] = await db
      .insert(schema.guides)
      .values(values)
      .onConflictDoUpdate({
        target: schema.guides.slug,
        set: { ...values, updatedAt: touchedAtFor(schema.guides, values) },
      })
      .returning({ id: schema.guides.id });

    await replaceOrdered(
      db,
      schema.guideSections,
      schema.guideSections.guideId,
      row.id,
      (guide.body ?? []).map((section, i) => ({
        guideId: row.id,
        position: i,
        heading: section.heading ?? null,
        paragraphs: section.paragraphs,
      })),
    );

    await replaceOrdered(
      db,
      schema.sources,
      schema.sources.ownerId,
      row.id,
      (guide.sources ?? []).map((source, i) => ({
        ownerType: 'guide' as const,
        ownerId: row.id,
        position: i,
        label: source.label,
        url: source.url ?? null,
        retrieved: source.retrieved ?? null,
      })),
    );
  }

  return {
    organizations: orgSeeds.length,
    media: mediaIdByPath.size,
    cities: cityIdBySlug.size,
    builders: builderIdBySlug.size,
    ambassadors: ambassadorIdBySlug.size,
    events: eventIdBySlug.size,
    projects: projectIdBySlug.size,
    stories: storyRecords.length,
    useCases: useCaseRecords.length,
    guides: guideRecords.length,
    mediaSkippedForMissingAlt,
  };
}
