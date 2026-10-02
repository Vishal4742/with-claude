/**
 * INGESTION. THE PART THAT IS ALLOWED TO WRITE.
 *
 * One function — `syncSource()` — is the only thing in this codebase that
 * turns an external calendar into public records. Everything above it
 * (`ics.ts`, `luma.ts`) only reads and normalises; everything beside it
 * (`india.ts`) only classifies. Keeping the writes here means the rules that
 * matter are enforced once rather than per source.
 *
 * ── THE FOUR RULES, AND WHERE EACH IS ENFORCED ───────────────────────────
 *
 * 1. IT IS IDEMPOTENT. `(source_id, external_id)` is a unique index, so
 *    running this twice — or twice concurrently — cannot produce two rows for
 *    one Luma event. The constraint does the work, not the control flow (§43).
 *
 * 2. IT NEVER PUBLISHES AN EVENT IT CANNOT PLACE. A record is promoted only
 *    when `classifyIndia()` clears the threshold AND the city resolves to a
 *    real `cities` row. Anything else goes to `review` with a reason and
 *    appears nowhere public (§21).
 *
 * 3. IT CANNOT TOUCH A CURATED EVENT. Every write to `events` is constrained
 *    by `sourceId = <this source>`, and the fourteen hand-authored events have
 *    `sourceId IS NULL`. A feed cannot rename, reschedule or cancel an event a
 *    person wrote (§38).
 *
 * 4. A FAILED FETCH CHANGES NOTHING. Withdrawal is driven by absence from the
 *    feed, which is only meaningful when the fetch succeeded AND returned the
 *    whole calendar. A timeout must not be read as "every event was cancelled"
 *    — see the `complete` guard below, which is the single most consequential
 *    condition in this file.
 *
 * ── WHY WITHDRAWAL IS BY ABSENCE ─────────────────────────────────────────
 *
 * Because for the calendar this actually runs against, absence is the ONLY
 * cancellation signal there is: the Luma ICS feed reports `STATUS:TENTATIVE`
 * on all 317 of its events, including ones that have already happened. So
 * `isCancelledStatus()` is checked first and would be believed — it simply
 * never fires on this feed. §23 still has to be satisfied, and absence is what
 * is left.
 */
import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { createHash } from 'node:crypto';
import * as schema from '../../../db/schema';
import { canonicalCityName, classifyIndia } from './india';
import { isCancelledStatus, type EventSource, type NormalizedEvent } from './source';
import { attributeIngestedEvent, loadAmbassadorIdentities } from './hosts';

export type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface SyncSummary {
  source: string;
  mode: string;
  ok: boolean;
  /** A fixed code when `ok` is false. Never an SDK message. */
  reason?: string;
  seen: number;
  created: number;
  updated: number;
  unchanged: number;
  promoted: number;
  /** Of `promoted`, how many were already in the curated archive. §17 dedup. */
  matchedCurated: number;
  review: number;
  rejected: number;
  withdrawn: number;

  /**
   * ── ATTRIBUTION, REPORTED SEPARATELY FROM INGESTION ────────────────────
   *
   * §35 asks the admin to show ambassador matches and unresolved hosts, and
   * these are deliberately three numbers rather than a success rate. On the
   * live feed `hostsUnresolved` is the large one and that is the correct
   * outcome, not a failure: the ICS organiser is a display name, and a name
   * earns attribution only once an admin has mapped it (see `hosts.ts`).
   *
   * A single "attribution: 4%" figure would invite somebody to improve it by
   * loosening the matcher, which is the one change this design exists to
   * prevent.
   */
  hostsMatched: number;
  /** Named an organiser no configured ambassador claims. §31 — still valid. */
  hostsUnresolved: number;
  /**
   * Already had a host, so the feed left it alone. §37.
   *
   * Counts both a curated credit and a moderator's correction — from this
   * side they are the same fact: somebody who is not a feed decided who ran
   * this event, and a sync does not get to revisit it.
   */
  hostsKept: number;
  note?: string;
}

/**
 * The field delimiter inside a fingerprint.
 *
 * A NUL, written as an escape rather than as a literal byte so the file stays
 * text that `grep` and `git diff` will read. It has to be a character that
 * CANNOT occur in any input field: event titles on this calendar are routinely
 * `Bhopal | Claude Code Build Day`, so a `|` separator would let a title
 * containing the delimiter shift the field boundaries and produce
 * the same fingerprint for two different events.
 */
const SEPARATOR = '\u0000';

/**
 * Prefix on `rawHash` while a row's phase-4 work (promotion, link or
 * withdrawal) has not been written. It never equals a bare fingerprint, so the
 * row is retried; it keeps the fingerprint, so a retry is not counted as an edit.
 * Migration 0017 gives the same marker to rows stuck before it existed.
 */
export const PENDING = 'pending:';

/**
 * A stable fingerprint of everything we care about in an external event.
 *
 * Only the fields that would change what the site shows are included, and they
 * are serialised in a fixed order — a hash over `JSON.stringify(event)` would
 * change whenever a source reordered its keys, which would turn every sync
 * into a full rewrite and make `lastChangedAt` meaningless.
 *
 * `DTSTAMP` and `SEQUENCE` are deliberately NOT in here. Luma bumps them on
 * every export, so including them would mean nothing is ever unchanged.
 */
export function fingerprint(event: NormalizedEvent): string {
  const material = [
    event.externalId,
    event.title,
    event.description ?? '',
    event.startsAt.toISOString(),
    event.endsAt?.toISOString() ?? '',
    event.timezone ?? '',
    event.location ?? '',
    event.country ?? '',
    event.latitude?.toFixed(5) ?? '',
    event.longitude?.toFixed(5) ?? '',
    event.organizer ?? '',
    event.registrationUrl ?? '',
    event.coverUrl ?? '',
    event.status ?? '',
  ].join(SEPARATOR);
  return createHash('sha256').update(material).digest('hex');
}

/**
 * Guess the event format from its title.
 *
 * §21 bans deciding LOCATION from title text, and this is not that: format is
 * a display facet with a harmless default, not a trust or geography decision.
 * `other` is the fallback and is a perfectly good answer.
 */
export function inferFormat(title: string): typeof schema.eventFormat.enumValues[number] {
  const value = title.toLowerCase();
  if (value.includes('impact lab')) return 'impact-lab';
  if (value.includes('hackathon') || value.includes('build day')) return 'hackathon';
  if (value.includes('workshop')) return 'workshop';
  if (value.includes('meetup')) return 'meetup';
  if (value.includes('demo')) return 'demo';
  if (value.includes('campus') || value.includes('college') || value.includes('university')) return 'campus';
  if (value.includes('conversation')) return 'conversation';
  return 'other';
}

/** A URL-safe slug. Bounded, so a long title cannot produce an absurd path. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
    .replace(/-+$/g, '');
}

/**
 * A slug for an ingested event that is unique and STABLE.
 *
 * Stability matters more than prettiness: the slug is the public URL, and a
 * slug that changed whenever a title was edited would break every link that
 * had ever been shared. So it is derived once, on first promotion, and the
 * external id is the tiebreaker rather than a counter — a counter depends on
 * what else happened to be in the table at the time, which is not stable.
 */
export function eventSlug(event: NormalizedEvent, taken: Set<string>): string {
  const base = slugify(event.title) || 'event';
  if (!taken.has(base)) return base;
  // `evt-RPZwseE12orCSQ0` → `rpzwsee12orcsq0`, deterministic per event.
  const suffix = slugify(event.externalId.replace(/^evt-/i, '')).slice(0, 8);
  const candidate = `${base}-${suffix}`;
  if (!taken.has(candidate)) return candidate;
  // Only reachable if two events share a title AND an id prefix.
  let n = 2;
  while (taken.has(`${candidate}-${n}`)) n += 1;
  return `${candidate}-${n}`;
}

/**
 * A registration URL reduced to the thing that identifies the event.
 *
 * Host and path only: lower-cased, `www.` dropped, trailing slash dropped,
 * query string and fragment discarded. So all of these are one event:
 *
 *   https://luma.com/hphplrbx
 *   https://www.luma.com/hphplrbx/
 *   https://luma.com/hphplrbx?utm_source=withclaude.in
 *
 * That last one matters because our OWN outgoing links carry UTM parameters,
 * so a comparison that kept the query string would fail to match the very
 * links this site publishes.
 */
export function registrationKey(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    return `${host}${path}`;
  } catch {
    return null;
  }
}

/** Safe, structured, and carrying nothing secret. §41. */
function log(event: string, fields: Record<string, string | number | boolean>): void {
  console.log(`[events.${event}] ${JSON.stringify(fields)}`);
}

/**
 * Fetch one source and reconcile it into the database.
 *
 * Returns a summary rather than throwing, because the caller is a cron route
 * whose job is to report what happened, including when the answer is "nothing,
 * the feed was down".
 */
export async function syncSource(source: EventSource, db: AnyDatabase): Promise<SyncSummary> {
  const summary: SyncSummary = {
    source: source.key,
    mode: source.syncMode,
    ok: false,
    seen: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    promoted: 0,
    matchedCurated: 0,
    hostsMatched: 0,
    hostsUnresolved: 0,
    hostsKept: 0,
    review: 0,
    rejected: 0,
    withdrawn: 0,
  };

  // ── The source row. Upserted by key, so a new source needs no migration ──
  const [sourceRow] = await db
    .insert(schema.eventSources)
    .values({
      key: source.key,
      provider: source.provider,
      label: source.label,
      syncMode: source.syncMode,
      calendarId: source.calendarId ?? null,
      feedUrl: source.feedUrl ?? null,
    })
    .onConflictDoUpdate({
      target: schema.eventSources.key,
      set: {
        provider: source.provider,
        label: source.label,
        syncMode: source.syncMode,
        calendarId: source.calendarId ?? null,
        feedUrl: source.feedUrl ?? null,
        updatedAt: new Date(),
      },
    })
    .returning({ id: schema.eventSources.id, enabled: schema.eventSources.enabled });

  if (!sourceRow.enabled) {
    summary.reason = 'SOURCE_DISABLED';
    summary.note = 'disabled';
    return summary;
  }

  const result = await source.fetch();

  if (!result.ok) {
    /**
     * NOTHING IS CHANGED. See rule 4 in the file header — this early return is
     * what stops an unreachable feed from cancelling the whole directory.
     */
    await db
      .update(schema.eventSources)
      .set({
        lastSyncedAt: new Date(),
        lastSyncStatus: 'failed',
        lastSyncMessage: result.reason,
        updatedAt: new Date(),
      })
      .where(eq(schema.eventSources.id, sourceRow.id));
    summary.reason = result.reason;
    log('sync.failed', { source: source.key, reason: result.reason });
    return summary;
  }

  summary.seen = result.events.length;
  summary.note = result.note;

  // ── The atlas, once. Resolving a city per event would be an N+1 ──────────
  const cityRows = await db
    .select({ id: schema.cities.id, name: schema.cities.name, slug: schema.cities.slug })
    .from(schema.cities);
  const cityByName = new Map(cityRows.map((row) => [row.name.trim().toLowerCase(), row.id]));

  // Existing staging rows for this source, by external id.
  const existingRows = await db
    .select({
      id: schema.eventSourceRecords.id,
      externalId: schema.eventSourceRecords.externalId,
      rawHash: schema.eventSourceRecords.rawHash,
      state: schema.eventSourceRecords.state,
      eventId: schema.eventSourceRecords.eventId,
    })
    .from(schema.eventSourceRecords)
    .where(eq(schema.eventSourceRecords.sourceId, sourceRow.id));
  const existingByExternalId = new Map(existingRows.map((row) => [row.externalId, row]));

  /**
   * Every event already in the table, once.
   *
   * Two jobs, one query. `takenSlugs` lets `eventSlug()` avoid a collision
   * without a query per candidate, and `curatedByRegistration` is what stops
   * the feed duplicating the curated archive.
   *
   * ── THE DUPLICATE THIS PREVENTS ──────────────────────────────────────
   *
   * The curated events were authored from the same Luma calendar this feed
   * comes from, so some of them ARE events in the feed — measured against the
   * live data, two of them: `claude-code-for-builders` is
   * `luma.com/hphplrbx`, and `claude-impact-lab-september` is
   * `luma.com/claude-r61u`, both of which the feed also carries. Without this
   * map, the first sync would create a second copy of each and the events
   * directory would list both Bhopal events twice.
   *
   * §17 asks for deduplication and §38 says not to alter existing records, so
   * a match LINKS the staging row to the curated event and writes nothing to
   * it. The authored version stays authoritative — it has a real venue, a real
   * summary and an ambassador credit, all of which the feed lacks.
   */
  const existingEventRows = await db
    .select({
      id: schema.events.id,
      slug: schema.events.slug,
      sourceId: schema.events.sourceId,
      registrationUrl: schema.events.registrationUrl,
    })
    .from(schema.events);

  const takenSlugs = new Set(existingEventRows.map((row) => row.slug));
  const curatedByRegistration = new Map<string, string>();
  for (const row of existingEventRows) {
    // Curated only. An event this source already owns is matched by
    // `(source_id, external_id)`, which is exact.
    if (row.sourceId !== null) continue;
    const key = registrationKey(row.registrationUrl);
    if (key && !curatedByRegistration.has(key)) curatedByRegistration.set(key, row.id);
  }

  const seenExternalIds: string[] = [];
  const now = new Date();

  /**
   * ── WHY THIS IS PHASED AND NOT ONE LOOP ──────────────────────────────────
   *
   * It used to be one loop doing one round trip per event. Against the live
   * feed that is 317 sequential round trips to Neon, which measured at 35
   * SECONDS — and `astro.config.mjs` caps every function at
   * `maxDuration: 15`. So the correct-looking version was one that could never
   * finish in production: it would be killed part-way through, leaving the
   * feed half-ingested and `event_sources.last_synced_at` never written.
   *
   * The fix is not a longer timeout. Almost none of those round trips carried
   * any information — on a normal night every one of the 317 events is
   * unchanged, and the work is 317 identical `lastSeenAt` touches. So:
   *
   *   PHASE 1  classify everything in memory. No database at all.
   *   PHASE 2  one UPDATE for every unchanged row.
   *   PHASE 3  chunked multi-row upserts for the rows that actually changed.
   *   PHASE 4  per-event writes for promotions only — about a dozen, not 317.
   *
   * Same semantics, and the same constraints doing the same idempotency work,
   * with two orders of magnitude fewer round trips.
   */

  // ── PHASE 1: classify, in memory ─────────────────────────────────────────

  interface Planned {
    event: NormalizedEvent;
    hash: string;
    values: typeof schema.eventSourceRecords.$inferInsert;
    state: (typeof schema.eventRecordState.enumValues)[number];
    cityId: string | null;
    curatedEventId: string | null;
    existing: (typeof existingRows)[number] | undefined;
  }

  const planned: Planned[] = [];

  for (const event of result.events) {
    seenExternalIds.push(event.externalId);
    const hash = fingerprint(event);
    const existing = existingByExternalId.get(event.externalId);

    const verdict = classifyIndia({
      location: event.location,
      country: event.country,
      latitude: event.latitude,
      longitude: event.longitude,
      timezone: event.timezone,
    });

    const cityName = verdict.city ?? canonicalCityName(event.location);
    const cityId = cityName ? (cityByName.get(cityName.toLowerCase()) ?? null) : null;
    const cancelled = isCancelledStatus(event.status);

    /**
     * Does the curated archive already have this event?
     *
     * Checked before the state machine so a matched event is recorded as
     * promoted — it IS on the site, as the authored version — rather than
     * being promoted again into a duplicate row.
     */
    const curatedEventId =
      curatedByRegistration.get(registrationKey(event.registrationUrl) ?? '') ?? null;

    /**
     * The state machine, in one expression so it can be read as one.
     *
     * Note the `city-not-in-atlas` case: confidently in India, but not one of
     * the curated cities. That is NOT a rejection — it is a real Indian event
     * with nowhere to live yet, so it waits for a human rather than being
     * dropped. Puducherry is the live example.
     */
    let state: (typeof schema.eventRecordState.enumValues)[number];
    let reason: string | null = null;
    if (cancelled) {
      state = 'withdrawn';
      reason = 'source-cancelled';
    } else if (!verdict.inIndia) {
      state =
        verdict.reason === 'foreign-country' || verdict.reason === 'foreign-coordinates'
          ? 'rejected'
          : 'review';
      reason = verdict.reason;
    } else if (curatedEventId) {
      state = 'promoted';
      reason = 'matched-curated-event';
    } else if (!cityId) {
      state = 'review';
      reason = 'city-not-in-atlas';
    } else {
      state = 'promoted';
    }

    planned.push({
      event,
      hash,
      state,
      cityId,
      curatedEventId,
      existing,
      values: {
        sourceId: sourceRow.id,
        externalId: event.externalId,
        title: event.title,
        description: event.description ?? null,
        startsAt: event.startsAt,
        endsAt: event.endsAt ?? null,
        timezone: event.timezone ?? null,
        locationRaw: event.location ?? null,
        country: event.country ?? null,
        cityName: cityName ?? null,
        latitude: event.latitude ?? null,
        longitude: event.longitude ?? null,
        organizer: event.organizer ?? null,
        registrationUrl: event.registrationUrl ?? null,
        coverUrl: event.coverUrl ?? null,
        sequence: event.sequence ?? null,
        sourceStatus: event.status ?? null,
        state,
        stateReason: reason,
        indiaConfidence: verdict.confidence,
        cityId,
        // Marked pending until phase 4 settles it; the hash is kept so a retry is not an edit.
        rawHash: state === 'promoted' || existing?.eventId ? `${PENDING}${hash}` : hash,
        lastSeenAt: now,
        firstSeenAt: now,
        lastChangedAt: now,
      },
    });
  }

  // Same content and state, but phase-4 work from an earlier run never landed: run only that work.
  const retry = planned.filter(
    (row) => row.existing?.rawHash === `${PENDING}${row.hash}` && row.existing.state === row.state,
  );
  const unchanged = planned.filter((row) => row.existing && row.existing.rawHash === row.hash);
  const changed = planned.filter(
    (row) => !row.existing || (row.existing.rawHash !== row.hash && !retry.includes(row)),
  );

  // ── PHASE 2: the unchanged majority, in ONE statement ────────────────────
  //
  // The whole point of `rawHash`. On a quiet night this is the only write the
  // sync performs, and it is a single UPDATE rather than 317.
  if (unchanged.length + retry.length > 0) {
    await db
      .update(schema.eventSourceRecords)
      .set({ lastSeenAt: now })
      .where(
        inArray(
          schema.eventSourceRecords.id,
          [...unchanged, ...retry].map((row) => row.existing!.id),
        ),
      );

    for (const row of unchanged) {
      summary.unchanged += 1;
      // Counted from the state already stored, since nothing was recomputed.
      const state = row.existing!.state;
      if (state === 'promoted') {
        summary.promoted += 1;
        if (row.curatedEventId) summary.matchedCurated += 1;
      } else if (state === 'review') summary.review += 1;
      else if (state === 'rejected') summary.rejected += 1;
    }
  }

  // ── PHASE 3: the rows that changed, upserted in chunks ───────────────────
  //
  // Still `onConflictDoUpdate` on the unique index, so the idempotency
  // guarantee is unchanged: two concurrent syncs are serialised by the
  // database and exactly one row per external event survives. Chunked because
  // one statement carrying several hundred rows of twenty-odd columns each
  // runs into the driver's parameter limit.
  const CHUNK = 50;
  const upserted = new Map<string, { id: string; eventId: string | null }>();

  for (let i = 0; i < changed.length; i += CHUNK) {
    const batch = changed.slice(i, i + CHUNK);
    const rows = await db
      .insert(schema.eventSourceRecords)
      .values(batch.map((row) => row.values))
      .onConflictDoUpdate({
        target: [schema.eventSourceRecords.sourceId, schema.eventSourceRecords.externalId],
        /**
         * `excluded` is the row the INSERT proposed, and it is what makes a
         * MULTI-row upsert apply per-row values in a single statement. Writing
         * literal values here instead would apply the last row of the batch to
         * every conflicting row in it — fifty events all ending up with the
         * fiftieth event's title.
         *
         * `firstSeenAt` is deliberately absent: it keeps its original value,
         * because when we first saw an event is not something a re-sync gets
         * to revise.
         */
        set: {
          title: sql`excluded.title`,
          description: sql`excluded.description`,
          startsAt: sql`excluded.starts_at`,
          endsAt: sql`excluded.ends_at`,
          timezone: sql`excluded.timezone`,
          locationRaw: sql`excluded.location_raw`,
          country: sql`excluded.country`,
          cityName: sql`excluded.city_name`,
          latitude: sql`excluded.latitude`,
          longitude: sql`excluded.longitude`,
          organizer: sql`excluded.organizer`,
          registrationUrl: sql`excluded.registration_url`,
          coverUrl: sql`excluded.cover_url`,
          sequence: sql`excluded.sequence`,
          sourceStatus: sql`excluded.source_status`,
          state: sql`excluded.state`,
          stateReason: sql`excluded.state_reason`,
          indiaConfidence: sql`excluded.india_confidence`,
          cityId: sql`excluded.city_id`,
          rawHash: sql`excluded.raw_hash`,
          lastSeenAt: now,
          lastChangedAt: now,
          updatedAt: now,
        },
      })
      .returning({
        id: schema.eventSourceRecords.id,
        externalId: schema.eventSourceRecords.externalId,
        eventId: schema.eventSourceRecords.eventId,
      });

    for (const row of rows) upserted.set(row.externalId, { id: row.id, eventId: row.eventId });
  }

  for (const row of changed) {
    if (row.existing) summary.updated += 1;
    else summary.created += 1;
  }
  // A retry skipped phase 3: the feed entry did not change, so it is not an edit.
  for (const row of retry) {
    upserted.set(row.event.externalId, { id: row.existing!.id, eventId: row.existing!.eventId });
    summary.unchanged += 1;
  }

  /**
   * The configured Luma identities, read ONCE for the whole run.
   *
   * §45's no-N+1 rule applied to attribution: 317 events must not mean 317
   * ambassador lookups. It is also read here rather than inside the loop so
   * that a mapping added mid-sync cannot make the first half of a run behave
   * differently from the second.
   */
  const identities = await loadAmbassadorIdentities(db);

  // ── PHASE 4: promotions and withdrawals, only where needed ───────────────
  //
  // A dozen of these, not 317 — every other row was settled by phase 2 or 3.
  const settled: { recordId: string; hash: string; eventId?: string }[] = [];

  for (const row of [...changed, ...retry]) {
    const record = upserted.get(row.event.externalId);
    if (!record) continue;
    const priorEventId = record.eventId ?? row.existing?.eventId ?? null;

    if (row.state === 'promoted' && row.curatedEventId) {
      /**
       * LINK, DO NOT WRITE.
       *
       * The authored event stays exactly as a person wrote it — real venue,
       * real summary, ambassador credit — and the staging row records only
       * that this feed entry corresponds to it. §38.
       */
      settled.push({ recordId: record.id, hash: row.hash, eventId: row.curatedEventId });
      summary.matchedCurated += 1;
      summary.promoted += 1;
      continue;
    }

    if (row.state === 'promoted' && row.cityId) {
      const eventId = await promote({
        db,
        sourceId: sourceRow.id,
        event: row.event,
        cityId: row.cityId,
        existingEventId: priorEventId,
        takenSlugs,
      });
      if (eventId) {
        settled.push({ recordId: record.id, hash: row.hash, eventId });
        summary.promoted += 1;
      } else {
        log('sync.promote-failed', { source: source.key, externalId: row.event.externalId });
      }
      continue;
    }

    if (row.state === 'review') summary.review += 1;
    if (row.state === 'rejected') summary.rejected += 1;

    /**
     * A record that USED to be promoted and no longer qualifies must stop
     * being public. The commonest cause is an organiser correcting a venue,
     * which can move an event out of India entirely.
     */
    if (priorEventId) {
      if (await withdrawEvent(db, sourceRow.id, priorEventId, now)) summary.withdrawn += 1;
      settled.push({ recordId: record.id, hash: row.hash });
    }
  }

  // A row with phase-4 work gets its real hash (and event link) only once that work is written.
  // One statement for all of them, not a round trip each.
  if (settled.length > 0) {
    const values = sql.join(
      settled.map((row) => sql`(${row.recordId}::uuid, ${row.hash}, ${row.eventId ?? null}::uuid)`),
      sql`, `,
    );
    await db.execute(sql`
      update event_source_records as r
         set raw_hash = v.hash, event_id = coalesce(v.event_id, r.event_id)
        from (values ${values}) as v(id, hash, event_id)
       where r.id = v.id`);
  }

  /**
   * ── PHASE 5: WHO RAN THEM ────────────────────────────────────────────────
   *
   * Attribution runs over every record this source has promoted, NOT only the
   * ones that changed in this fetch.
   *
   * ── THE BUG THIS SHAPE FIXES ─────────────────────────────────────────────
   *
   * It was originally done inside the promotion branch above, which only
   * executes for a record whose fingerprint moved. The consequence was quiet
   * and bad: an admin configures "Aniket Sahu" against an ambassador, runs the
   * sync, and NOTHING is attributed — because the three events in question had
   * not changed, so the code that would have looked at them never ran. The
   * mapping would only take effect the next time the organiser happened to
   * edit the event. Measured against the live capture, that was 0 attributed
   * instead of 3.
   *
   * Attribution depends on OUR configuration, not on the feed's revisions, so
   * it cannot be driven by the feed's change detection.
   *
   * It stays cheap because the work is bounded by what is missing rather than
   * by the size of the feed: one query for the promoted rows, one for the
   * events that already have a host, and then a call only for those that do
   * not. On a steady state where everything resolvable is resolved, that is
   * two queries and no writes.
   */
  const promoted = await db
    .select({
      eventId: schema.eventSourceRecords.eventId,
      organizer: schema.eventSourceRecords.organizer,
    })
    .from(schema.eventSourceRecords)
    .where(
      and(
        eq(schema.eventSourceRecords.sourceId, sourceRow.id),
        eq(schema.eventSourceRecords.state, 'promoted'),
        isNotNull(schema.eventSourceRecords.eventId),
      ),
    );

  if (promoted.length > 0) {
    const eventIds = promoted.map((row) => row.eventId!) as string[];
    const attributed = new Set(
      (
        await db
          .select({ eventId: schema.eventHosts.eventId })
          .from(schema.eventHosts)
          .where(
            and(
              inArray(schema.eventHosts.eventId, eventIds),
              eq(schema.eventHosts.role, 'primary_host'),
            ),
          )
      ).map((row) => row.eventId),
    );

    for (const row of promoted) {
      const eventId = row.eventId!;
      if (attributed.has(eventId)) {
        summary.hostsKept += 1;
        continue;
      }
      const outcome = await attributeIngestedEvent({
        db,
        eventId,
        identities,
        event: { organizer: row.organizer },
      });
      if (outcome === 'matched') summary.hostsMatched += 1;
      else if (outcome === 'unresolved') summary.hostsUnresolved += 1;
      else if (outcome === 'kept-existing') summary.hostsKept += 1;
    }
  }

  // ── Withdrawal by absence ────────────────────────────────────────────────
  //
  // ONLY when the fetch was complete. See rule 4: a partial view says nothing
  // about the events it did not mention, and acting on it would cancel them.
  if (result.complete) {
    const missing = existingRows.filter(
      (row) => !seenExternalIds.includes(row.externalId) && row.state !== 'withdrawn',
    );
    for (const row of missing) {
      await db
        .update(schema.eventSourceRecords)
        .set({ state: 'withdrawn', stateReason: 'absent-from-feed', lastChangedAt: now, updatedAt: now })
        .where(eq(schema.eventSourceRecords.id, row.id));
      /**
       * The count follows the EVENT, not the staging row.
       *
       * A staging row can point at a curated event (see
       * `curatedByRegistration`), and `withdrawEvent` is scoped by `sourceId`
       * so it will not touch one. Counting unconditionally would report a
       * cancellation that did not happen — and, worse, write an audit entry
       * saying an authored event was cancelled when it was not.
       */
      if (row.eventId && (await withdrawEvent(db, sourceRow.id, row.eventId, now))) {
        summary.withdrawn += 1;
      }
    }
  }

  await db
    .update(schema.eventSources)
    .set({
      lastSyncedAt: now,
      lastSyncStatus: summary.review > 0 ? 'partial' : 'ok',
      lastSyncMessage: result.note ?? null,
      lastSeenCount: summary.seen,
      lastPromotedCount: summary.promoted,
      updatedAt: now,
    })
    .where(eq(schema.eventSources.id, sourceRow.id));

  summary.ok = true;
  log('sync.ok', {
    source: source.key,
    mode: source.syncMode,
    seen: summary.seen,
    promoted: summary.promoted,
    review: summary.review,
    rejected: summary.rejected,
    withdrawn: summary.withdrawn,
  });

  // Append-only, and with no actor: a scheduled job is not a person. Both
  // actor columns stay null, which the table permits precisely for this.
  await db.insert(schema.auditLog).values({
    action: 'event.synced',
    entityType: 'event_source',
    entityId: sourceRow.id,
    toStatus: 'ok',
    after: {
      seen: summary.seen,
      created: summary.created,
      updated: summary.updated,
      promoted: summary.promoted,
      review: summary.review,
      withdrawn: summary.withdrawn,
    },
    note: `${source.key} (${source.syncMode})`,
  });

  return summary;
}

/**
 * Write an ingested event into the public `events` table.
 *
 * Returns the event id, or null if it could not be written. Every UPDATE here
 * carries `sourceId = <this source>`, which is rule 3: a curated event has a
 * null `sourceId` and therefore cannot match.
 */
async function promote(options: {
  db: AnyDatabase;
  sourceId: string;
  event: NormalizedEvent;
  cityId: string;
  existingEventId: string | null;
  takenSlugs: Set<string>;
}): Promise<string | null> {
  const { db, sourceId, event, cityId, existingEventId, takenSlugs } = options;

  /**
   * `date` and `startTime` are local wall-clock columns, and the feed gives an
   * absolute instant. The events in this feed are Indian events, so IST is the
   * right wall clock to render them in — and rendering an Indian event in UTC
   * would show a 09:00 workshop as 03:30.
   *
   * `Intl` rather than a fixed +05:30 offset, so this stays correct by
   * construction rather than by India not observing daylight saving.
   */
  const ist = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(event.startsAt);
  const part = (type: string) => ist.find((p) => p.type === type)?.value ?? '00';
  const date = `${part('year')}-${part('month')}-${part('day')}`;
  // `en-CA` renders midnight as `24`; Postgres `time` will not accept it.
  const hour = part('hour') === '24' ? '00' : part('hour');
  const startTime = `${hour}:${part('minute')}:${part('second')}`;

  const values = {
    sourceId,
    externalId: event.externalId,
    title: event.title,
    format: inferFormat(event.title),
    cityId,
    date,
    startTime,
    /**
     * `venueName` is NOT NULL and the feed frequently has no venue — the
     * registrant-only events say "Check event page for more details."
     * Inventing an address would be worse than admitting the gap, so the
     * honest placeholder is used and the registration link carries the
     * visitor to where the real answer is.
     */
    venueName: event.location?.slice(0, 200) || 'Venue shared with registrants',
    venueAddress: null,
    venuePrivate: !event.location,
    summary: (event.description?.split('\n').find((line) => line.trim())?.slice(0, 300)) || event.title,
    description: event.description ?? null,
    registrationUrl: event.registrationUrl ?? null,
    timezone: event.timezone ?? 'Asia/Kolkata',
    /**
     * PUBLISHED, WITHOUT AN EDITOR.
     *
     * The curated archive reaches `published` only through the admin's review
     * state machine, and that rule is untouched for hand-authored records. An
     * ingested event is different in kind: it is already public on Luma, and
     * holding a public event in a queue would make the directory wrong rather
     * than careful. The safeguard is upstream — only a confidently-placed
     * Indian event reaches this function at all.
     */
    status: 'published' as const,
    canceledAt: null,
    lastSyncedAt: new Date(),
    updatedAt: new Date(),
  };

  if (existingEventId) {
    const updated = await db
      .update(schema.events)
      .set(values)
      .where(
        and(
          eq(schema.events.id, existingEventId),
          eq(schema.events.sourceId, sourceId),
          // An event the organisers adopted into Baserow is theirs to edit;
          // the feed's copy stays in event_source_records for review.
          ne(schema.events.contentAuthority, 'baserow'),
        ),
      )
      .returning({ id: schema.events.id });
    if (updated.length > 0) return updated[0].id;
    if (await isAdopted(db, existingEventId)) return existingEventId;
    // The row is gone, or belongs to someone else. Fall through and insert.
  }

  // Already ingested under this source but not linked in staging — the
  // partial unique index makes this the authoritative check.
  const [linked] = await db
    .select({
      id: schema.events.id,
      slug: schema.events.slug,
      contentAuthority: schema.events.contentAuthority,
    })
    .from(schema.events)
    .where(and(eq(schema.events.sourceId, sourceId), eq(schema.events.externalId, event.externalId)));

  if (linked) {
    if (linked.contentAuthority !== 'baserow') {
      await db.update(schema.events).set(values).where(eq(schema.events.id, linked.id));
    }
    return linked.id;
  }

  const slug = eventSlug(event, takenSlugs);
  takenSlugs.add(slug);

  const [inserted] = await db
    .insert(schema.events)
    .values({ ...values, slug, createdAt: new Date() })
    .onConflictDoNothing()
    .returning({ id: schema.events.id });

  return inserted?.id ?? null;
}

/** Has the organisers' Baserow taken over this event's details? */
async function isAdopted(db: AnyDatabase, eventId: string): Promise<boolean> {
  const [row] = await db
    .select({ authority: schema.events.contentAuthority })
    .from(schema.events)
    .where(eq(schema.events.id, eventId));
  return row?.authority === 'baserow';
}

/**
 * Take an ingested event out of public view.
 *
 * `canceledAt` is set rather than the row deleted, and `status` moves to
 * `archived` rather than being dropped: §30 forbids rewriting history to make
 * a dataset tidy, and an event that happened still happened. §23's requirement
 * is that it stop advertising registration, which `/events/[slug]` reads
 * `canceledAt` to honour.
 *
 * Scoped to `sourceId` — a curated event cannot be reached from here.
 */
async function withdrawEvent(
  db: AnyDatabase,
  sourceId: string,
  eventId: string,
  now: Date,
): Promise<boolean> {
  const updated = await db
    .update(schema.events)
    .set({ canceledAt: now, statusOverride: 'cancelled', status: 'archived', updatedAt: now })
    .where(
      and(
        eq(schema.events.id, eventId),
        eq(schema.events.sourceId, sourceId),
        // Disappearing from the feed does not withdraw an adopted event.
        ne(schema.events.contentAuthority, 'baserow'),
      ),
    )
    .returning({ id: schema.events.id });

  // Nothing matched: the event belongs to another source, or to no source at
  // all because a person authored it. Either way there is nothing to log.
  if (updated.length === 0) return false;

  await db.insert(schema.auditLog).values({
    action: 'event.cancelled',
    entityType: 'event',
    entityId: eventId,
    toStatus: 'archived',
    note: 'withdrawn by source sync',
  });
  return true;
}

/**
 * Every configured source, in order, reported individually.
 *
 * One source failing does not stop the others: they are independent calendars
 * and a partial success is a real outcome that should be recorded as one.
 */
export async function syncAll(sources: EventSource[], db: AnyDatabase): Promise<SyncSummary[]> {
  const summaries: SyncSummary[] = [];
  for (const source of sources) {
    try {
      summaries.push(await syncSource(source, db));
    } catch (error) {
      // The message is not echoed: it can carry a URL or a driver detail.
      log('sync.threw', { source: source.key });
      summaries.push({
        source: source.key,
        mode: source.syncMode,
        ok: false,
        reason: 'UNHANDLED',
        seen: 0, created: 0, updated: 0, unchanged: 0,
        promoted: 0, matchedCurated: 0, review: 0, rejected: 0, withdrawn: 0,
        hostsMatched: 0, hostsUnresolved: 0, hostsKept: 0,
      });
    }
  }
  return summaries;
}

/** Sync state for the health endpoint. Safe to serve publicly. */
export async function sourceHealth(db: AnyDatabase) {
  return db
    .select({
      key: schema.eventSources.key,
      provider: schema.eventSources.provider,
      syncMode: schema.eventSources.syncMode,
      enabled: schema.eventSources.enabled,
      lastSyncedAt: schema.eventSources.lastSyncedAt,
      lastSyncStatus: schema.eventSources.lastSyncStatus,
      lastSeenCount: schema.eventSources.lastSeenCount,
      lastPromotedCount: schema.eventSources.lastPromotedCount,
    })
    .from(schema.eventSources);
}
