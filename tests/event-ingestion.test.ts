import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../db/testing';
import * as schema from '../db/schema';
import { parseIcs, parseIcsDate, unescapeText, unfold } from '../src/server/events/ics';
import { classifyIndia, nearestIndianCity } from '../src/server/events/india';
import { normalizeLumaIcsEvent, lumaExternalId, parseGeo, lumaIcsUrl } from '../src/server/events/luma';
import { ManualEventSource } from '../src/server/events/registry';
import { fingerprint, inferFormat, syncSource } from '../src/server/events/sync';
import { withAttribution } from '../src/lib/attribution';
import type { NormalizedEvent } from '../src/server/events/source';

/**
 * EVENT INGESTION, TESTED AGAINST THE REAL FEED AND A REAL DATABASE.
 *
 * `luma-sample.ics` is a capture of the live Claude Community calendar (317
 * events, fetched 2026-09-13). It is committed deliberately: the parser's two
 * hard parts — line unfolding and the URL-only venue case — were both
 * discovered from real data and neither would be exercised by a hand-written
 * fixture, because a hand-written fixture is written by whoever also wrote the
 * parser and shares its assumptions.
 *
 * The database assertions run on PGlite, so the constraints doing the
 * idempotency work are the real PostgreSQL ones.
 */
const SAMPLE = new URL('../luma-sample.ics', import.meta.url);

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db?.$close();
});

/** The atlas cities the sync resolves against. */
async function seedCities(): Promise<void> {
  await db.insert(schema.cities).values([
    { slug: 'bhopal', name: 'Bhopal', region: 'Madhya Pradesh', lat: 23.2599, lon: 77.4126, blurb: 'Where it started.' },
    { slug: 'mumbai', name: 'Mumbai', region: 'Maharashtra', lat: 19.076, lon: 72.8777, blurb: 'On the coast.' },
    { slug: 'bengaluru', name: 'Bengaluru', region: 'Karnataka', lat: 12.9716, lon: 77.5946, blurb: 'On the plateau.' },
  ]);
}

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    externalId: 'evt-test-1',
    title: 'Bhopal | Claude Code Build Day',
    startsAt: new Date('2026-12-01T04:30:00Z'),
    location: 'Bhopal, Madhya Pradesh, India',
    latitude: 23.2599,
    longitude: 77.4126,
    registrationUrl: 'https://luma.com/example',
    ...overrides,
  };
}

describe('the ICS parser', () => {
  it('unfolds continuation lines before reading properties', () => {
    /**
     * The exact failure this guards: without unfolding, `LOCATION` is
     * invisible — it reads as an unknown property and the address is lost from
     * all 317 events in the live feed.
     *
     * Note that the leading space is CONSUMED, not preserved. Per RFC 5545
     * §3.1 the single space after the line break is part of the folding rather
     * than part of the value, so a producer that wants a space encodes it
     * before the break. Luma folds mid-token and relies on exactly this.
     */
    const folded = 'BEGIN:VEVENT\r\nLOCATION:Bahnhofstrasse 75, 80\r\n 01 Zürich\r\nEND:VEVENT';
    expect(unfold(folded)).toContain('LOCATION:Bahnhofstrasse 75, 8001 Zürich');
  });

  it('unescapes in one pass, so an escaped backslash is not re-read', () => {
    expect(unescapeText('a\\nb')).toBe('a\nb');
    expect(unescapeText('a\\,b')).toBe('a,b');
    // The ordering bug: chained replaces turn this into a newline.
    expect(unescapeText('a\\\\nb')).toBe('a\\nb');
  });

  it('does not split a parameter on a colon inside a quoted value', () => {
    const calendar = parseIcs(
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:evt-1\nSUMMARY:X\nDTSTART:20260101T000000Z\nORGANIZER;CN="A: B":MAILTO:a@b.c\nEND:VEVENT\nEND:VCALENDAR',
    );
    expect(calendar.events[0].ORGANIZER.params.CN).toBe('A: B');
    expect(calendar.events[0].ORGANIZER.value).toBe('MAILTO:a@b.c');
  });

  it('ignores properties belonging to a nested component', () => {
    const calendar = parseIcs(
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:evt-1\nDTSTART:20260101T000000Z\nSUMMARY:Real\nBEGIN:VALARM\nSUMMARY:Alarm\nEND:VALARM\nEND:VEVENT\nEND:VCALENDAR',
    );
    expect(calendar.events).toHaveLength(1);
    expect(calendar.events[0].SUMMARY.value).toBe('Real');
  });

  it('reads the three date forms and flags what it could not resolve', () => {
    expect(parseIcsDate({ value: '20251009T161500Z', params: {} })).toMatchObject({ utc: true, dateOnly: false });
    expect(parseIcsDate({ value: '20251009', params: {} })).toMatchObject({ dateOnly: true });
    expect(parseIcsDate({ value: '20251009T161500', params: { TZID: 'Asia/Kolkata' } })).toMatchObject({
      utc: false,
      zone: 'Asia/Kolkata',
    });
    expect(parseIcsDate({ value: 'nonsense', params: {} })).toBeNull();
  });

  it('parses the live 317-event feed without losing a location or a date', () => {
    const calendar = parseIcs(readFileSync(SAMPLE, 'utf8'));
    expect(calendar.name).toBe('Claude Community Events');
    expect(calendar.events.length).toBeGreaterThan(300);
    // Both were zero before unfolding was applied first.
    const withLocation = calendar.events.filter((e) => e.LOCATION).length;
    expect(withLocation).toBe(calendar.events.length);
    const normalized = calendar.events.map(normalizeLumaIcsEvent);
    expect(normalized.every(Boolean)).toBe(true);
  });
});

describe('the India filter', () => {
  it('accepts an explicit country', () => {
    const verdict = classifyIndia({ location: 'Koramangala, Bengaluru, Karnataka, India' });
    expect(verdict.inIndia).toBe(true);
    expect(verdict.city).toBe('Bengaluru');
  });

  it('rejects a foreign country even when an Indian city name appears', () => {
    // The real trap: `Hyderabad House` is a restaurant in Washington.
    const verdict = classifyIndia({ location: 'Hyderabad House, Washington, United States' });
    expect(verdict.inIndia).toBe(false);
    expect(verdict).toMatchObject({ reason: 'foreign-country' });
  });

  it('rejects coordinates outside India', () => {
    const verdict = classifyIndia({ location: 'Bahnhofstrasse 75, 8001 Zürich, Switzerland', latitude: 47.37, longitude: 8.53 });
    expect(verdict.inIndia).toBe(false);
  });

  it('accepts coordinates near a known Indian city when the address is a bare URL', () => {
    /**
     * THE REGRESSION THIS FILE EXISTS FOR.
     *
     * Eleven real Indian events — three in Bhopal — publish no address at all,
     * only `LOCATION: https://luma.com/event/evt-…`, because the venue goes to
     * registrants. Scored on a bounding box they sat below the publish
     * threshold and went to review, which silently emptied the most active
     * chapter out of the directory.
     */
    const verdict = classifyIndia({
      location: 'https://luma.com/event/evt-IcKOSAOGP6GAeEX',
      latitude: 23.266962370695772,
      longitude: 77.4572836601048,
    });
    expect(verdict.inIndia).toBe(true);
    expect(verdict.confidence).toBe(100);
    expect(verdict.city).toBe('Bhopal');
  });

  it('does not treat the bounding box alone as conclusive', () => {
    // Kathmandu: inside the box around India, not in India, not near a city
    // we know. Must corroborate, never decide.
    const verdict = classifyIndia({ location: 'Somewhere', latitude: 27.7172, longitude: 85.324 });
    expect(verdict.inIndia).toBe(false);
  });

  it('holds an online event for review rather than publishing or dropping it', () => {
    const verdict = classifyIndia({ location: undefined });
    expect(verdict).toMatchObject({ inIndia: false, reason: 'no-location-signal' });
  });

  it('finds every Indian event in the live feed, and nothing else', () => {
    const calendar = parseIcs(readFileSync(SAMPLE, 'utf8'));
    const accepted = calendar.events
      .map(normalizeLumaIcsEvent)
      .filter((e): e is NormalizedEvent => Boolean(e))
      .filter((e) =>
        classifyIndia({
          location: e.location, country: e.country,
          latitude: e.latitude, longitude: e.longitude, timezone: e.timezone,
        }).inIndia,
      );

    // 13 established by inspecting all 317 by hand. Bhopal appears 3 times.
    expect(accepted).toHaveLength(13);
    expect(accepted.filter((e) => /bhopal/i.test(e.title))).toHaveLength(3);
    // No foreign event may slip in.
    expect(accepted.some((e) => /zurich|tokyo|austin|sydney/i.test(e.title))).toBe(false);
  });

  it('places a point outside every known city as not-near', () => {
    expect(nearestIndianCity(23.2599, 77.4126)?.name).toBe('Bhopal');
    expect(nearestIndianCity(47.37, 8.53)).toBeUndefined();
  });
});

describe('Luma specifics', () => {
  it('strips the UID domain so ICS and API ids agree', () => {
    expect(lumaExternalId('evt-RPZwseE12orCSQ0@events.lu.ma')).toBe('evt-RPZwseE12orCSQ0');
    expect(lumaExternalId('evt-plain')).toBe('evt-plain');
  });

  it('builds the ICS URL on api.lu.ma with the calendar api_id', () => {
    // Both halves are load-bearing: the slug 404s and lu.ma returns HTML.
    expect(lumaIcsUrl('cal-X')).toBe('https://api.lu.ma/ics/get?entity=calendar&id=cal-X');
  });

  it('treats a 0;0 GEO as absent', () => {
    expect(parseGeo('23.2;77.4')).toEqual({ lat: 23.2, lon: 77.4 });
    expect(parseGeo('0;0')).toBeUndefined();
    expect(parseGeo(undefined)).toBeUndefined();
  });

  it('prefers the description address when LOCATION is a URL', () => {
    const calendar = parseIcs(
      [
        'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:evt-a@events.lu.ma',
        'SUMMARY:Bhopal | Claude', 'DTSTART:20260101T043000Z',
        'LOCATION:https://luma.com/event/evt-a',
        'DESCRIPTION:Get up-to-date information at: https://luma.com/abc\\n\\nAddress:\\nMP Nagar\\nBhopal, Madhya Pradesh\\nIndia\\n\\nHosted by Aniket Sahu',
        'END:VEVENT', 'END:VCALENDAR',
      ].join('\n'),
    );
    const normalized = normalizeLumaIcsEvent(calendar.events[0]);
    expect(normalized?.location).toBe('MP Nagar, Bhopal, Madhya Pradesh, India');
    expect(normalized?.registrationUrl).toBe('https://luma.com/abc');
    expect(normalized?.organizer).toBe('Aniket Sahu');
  });
});

describe('UTM attribution', () => {
  it('adds the convention', () => {
    expect(withAttribution('https://luma.com/x')).toBe(
      'https://luma.com/x?utm_source=withclaude.in&utm_medium=event&utm_campaign=india-community',
    );
  });

  it('never overwrites a parameter the source already set', () => {
    const result = withAttribution('https://luma.com/x?utm_source=whatsapp');
    expect(result).toContain('utm_source=whatsapp');
    expect(result).not.toContain('withclaude');
    expect(result).toContain('utm_medium=event');
  });

  it('refuses a non-http scheme', () => {
    expect(withAttribution('javascript:alert(1)')).toBeNull();
    expect(withAttribution(null)).toBeNull();
  });
});

describe('the sync', () => {
  it('is idempotent: running twice creates one row and one event', async () => {
    await seedCities();
    const source = new ManualEventSource([event()], { key: 'test:idem', complete: true });

    const first = await syncSource(source, db);
    expect(first).toMatchObject({ ok: true, seen: 1, created: 1, promoted: 1 });

    const second = await syncSource(source, db);
    // The whole point: nothing changed, so nothing was written.
    expect(second).toMatchObject({ ok: true, seen: 1, created: 0, updated: 0, unchanged: 1 });

    const records = await db
      .select()
      .from(schema.eventSourceRecords)
      .where(eq(schema.eventSourceRecords.externalId, 'evt-test-1'));
    expect(records).toHaveLength(1);

    const events = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.externalId, 'evt-test-1'));
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('published');
  });

  it('renders an Indian event at its IST wall clock, not UTC', async () => {
    const events = await db
      .select({ date: schema.events.date, startTime: schema.events.startTime })
      .from(schema.events)
      .where(eq(schema.events.externalId, 'evt-test-1'));
    // 04:30 UTC is 10:00 IST on the same day.
    expect(events[0].date).toBe('2026-12-01');
    expect(events[0].startTime).toBe('10:00:00');
  });

  it('holds a confidently-Indian event with no atlas city for review', async () => {
    const source = new ManualEventSource(
      [event({ externalId: 'evt-pny', title: 'Puducherry | Claude', location: 'Puducherry, India', latitude: 11.9416, longitude: 79.8083 })],
      { key: 'test:atlas', complete: true },
    );
    const summary = await syncSource(source, db);
    // Not rejected — it is a real Indian event with nowhere to live yet.
    expect(summary).toMatchObject({ ok: true, review: 1, promoted: 0 });

    const [record] = await db
      .select()
      .from(schema.eventSourceRecords)
      .where(eq(schema.eventSourceRecords.externalId, 'evt-pny'));
    expect(record.state).toBe('review');
    expect(record.stateReason).toBe('city-not-in-atlas');
    expect(record.eventId).toBeNull();
  });

  it('never publishes a foreign event', async () => {
    const source = new ManualEventSource(
      [event({ externalId: 'evt-zrh', title: 'Zurich | Claude', location: 'Bahnhofstrasse 75, Zürich, Switzerland', latitude: 47.37, longitude: 8.53 })],
      { key: 'test:foreign', complete: true },
    );
    const summary = await syncSource(source, db);
    expect(summary).toMatchObject({ rejected: 1, promoted: 0 });
    const events = await db.select().from(schema.events).where(eq(schema.events.externalId, 'evt-zrh'));
    expect(events).toHaveLength(0);
  });

  it('cancels an event that disappears from a complete feed', async () => {
    const key = 'test:withdraw';
    await syncSource(new ManualEventSource([event({ externalId: 'evt-gone' })], { key, complete: true }), db);
    const [before] = await db.select().from(schema.events).where(eq(schema.events.externalId, 'evt-gone'));
    expect(before.canceledAt).toBeNull();

    // Same source, event no longer present.
    const summary = await syncSource(new ManualEventSource([], { key, complete: true }), db);
    expect(summary.withdrawn).toBe(1);

    const [after] = await db.select().from(schema.events).where(eq(schema.events.externalId, 'evt-gone'));
    expect(after.canceledAt).not.toBeNull();
    expect(after.statusOverride).toBe('cancelled');
    expect(after.status).toBe('archived');
  });

  it('does NOT cancel anything when the fetch was incomplete', async () => {
    /**
     * The most consequential branch in `sync.ts`. A paginated or webhook fetch
     * says nothing about the events it did not mention; acting on its silence
     * would cancel the entire calendar.
     */
    const key = 'test:partial';
    await syncSource(new ManualEventSource([event({ externalId: 'evt-keep' })], { key, complete: true }), db);
    const summary = await syncSource(new ManualEventSource([], { key, complete: false }), db);
    expect(summary.withdrawn).toBe(0);

    const [row] = await db.select().from(schema.events).where(eq(schema.events.externalId, 'evt-keep'));
    expect(row.canceledAt).toBeNull();
  });

  it('leaves a curated event untouched', async () => {
    /**
     * Rule 3. A hand-authored event has `sourceId IS NULL`, and every write in
     * `promote()`/`withdrawEvent()` is scoped by `sourceId`, so a feed cannot
     * reach it even if it claims the same external id.
     */
    const [city] = await db.select({ id: schema.cities.id }).from(schema.cities).limit(1);
    const [curated] = await db
      .insert(schema.events)
      .values({
        slug: 'curated-room', title: 'Curated Room', format: 'workshop', cityId: city.id,
        date: '2026-05-01', startTime: '10:00:00', venueName: 'A Real Venue',
        summary: 'Authored by a person.', status: 'published', externalId: 'evt-gone',
      } as never)
      .returning({ id: schema.events.id });

    await syncSource(new ManualEventSource([], { key: 'test:withdraw', complete: true }), db);

    const [after] = await db.select().from(schema.events).where(eq(schema.events.id, curated.id));
    expect(after.canceledAt).toBeNull();
    expect(after.status).toBe('published');
    expect(after.sourceId).toBeNull();
  });

  it('does not duplicate an event the curated archive already has', async () => {
    /**
     * THE DUPLICATE THIS PREVENTS, MEASURED ON LIVE DATA.
     *
     * The curated events were authored from the same Luma calendar the feed
     * comes from, so two of them ARE feed events:
     * `claude-code-for-builders` is `luma.com/hphplrbx` and
     * `claude-impact-lab-september` is `luma.com/claude-r61u`. Without
     * registration-URL matching, the first sync creates a second copy of each
     * and both Bhopal events appear twice in the directory.
     *
     * The authored row must win: it has a real venue, a real summary and an
     * ambassador credit, none of which the feed carries. §17 and §38.
     */
    const [city] = await db.select({ id: schema.cities.id }).from(schema.cities).limit(1);
    const [curated] = await db
      .insert(schema.events)
      .values({
        slug: 'claude-code-for-builders', title: 'Claude Code for Builders',
        format: 'workshop', cityId: city.id, date: '2026-03-01', startTime: '10:00:00',
        venueName: 'A Real Venue, Authored By Hand', summary: 'Written by a person.',
        registrationUrl: 'https://luma.com/hphplrbx', status: 'published',
      } as never)
      .returning({ id: schema.events.id });

    const source = new ManualEventSource(
      [
        event({
          externalId: 'evt-dupe',
          title: 'Bhopal | Claude Code for Builders',
          // Same event, and carrying OUR own UTM parameters — the comparison
          // has to ignore the query string or it will not match.
          registrationUrl: 'https://luma.com/hphplrbx?utm_source=withclaude.in',
        }),
      ],
      { key: 'test:dedupe', complete: true },
    );

    const summary = await syncSource(source, db);
    expect(summary).toMatchObject({ ok: true, promoted: 1, matchedCurated: 1 });

    // Exactly one event with that registration URL: the authored one.
    const rows = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.slug, 'claude-code-for-builders'));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(curated.id);
    // Untouched: the feed did not overwrite the authored venue or summary.
    expect(rows[0].venueName).toBe('A Real Venue, Authored By Hand');
    expect(rows[0].summary).toBe('Written by a person.');
    expect(rows[0].sourceId).toBeNull();

    // And the staging row points at it, so the link is traceable.
    const [record] = await db
      .select()
      .from(schema.eventSourceRecords)
      .where(eq(schema.eventSourceRecords.externalId, 'evt-dupe'));
    expect(record.eventId).toBe(curated.id);
    expect(record.stateReason).toBe('matched-curated-event');
  });

  it('records a failed fetch without changing any event', async () => {
    const key = 'test:failure';
    await syncSource(new ManualEventSource([event({ externalId: 'evt-survive' })], { key, complete: true }), db);

    const failing = {
      key, provider: 'test', label: 'Failing', syncMode: 'ics' as const,
      fetch: async () => ({ ok: false as const, reason: 'TIMEOUT' }),
    };
    const summary = await syncSource(failing, db);
    expect(summary).toMatchObject({ ok: false, reason: 'TIMEOUT', withdrawn: 0 });

    const [row] = await db.select().from(schema.events).where(eq(schema.events.externalId, 'evt-survive'));
    expect(row.canceledAt).toBeNull();

    const [sourceRow] = await db
      .select()
      .from(schema.eventSources)
      .where(eq(schema.eventSources.key, key));
    expect(sourceRow.lastSyncStatus).toBe('failed');
    expect(sourceRow.lastSyncMessage).toBe('TIMEOUT');
  });

  it('retries a promotion the database failed, instead of filing it as unchanged', async () => {
    const source = new ManualEventSource(
      [
        event({
          externalId: 'evt-retry',
          title: 'Bhopal | Retry Night',
          registrationUrl: 'https://luma.com/retry-test',
        }),
      ],
      { key: 'test:retry', complete: true },
    );

    // A database blip mid-run: every insert into `events` fails.
    try {
      await db.execute(sql`
        CREATE FUNCTION refuse_event() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN RAISE EXCEPTION 'blip'; END $$
      `);
      await db.execute(sql`
        CREATE TRIGGER refuse_event BEFORE INSERT ON events
        FOR EACH ROW EXECUTE FUNCTION refuse_event()
      `);
      await expect(syncSource(source, db)).rejects.toThrow();
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS refuse_event ON events`);
      await db.execute(sql`DROP FUNCTION IF EXISTS refuse_event()`);
    }

    // The feed has not changed since, so only a retry can publish the event,
    // and the retry is not an organiser edit.
    const retried = await syncSource(source, db);
    expect(retried).toMatchObject({ updated: 0, unchanged: 1, promoted: 1 });
    const [published] = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.externalId, 'evt-retry'));
    expect(published?.status).toBe('published');
    const [record] = await db
      .select()
      .from(schema.eventSourceRecords)
      .where(eq(schema.eventSourceRecords.externalId, 'evt-retry'));
    expect(record.eventId).toBe(published.id);
  });

  it('retries a promotion stuck before the retry existed, once migration 0017 marks it', async () => {
    const source = new ManualEventSource(
      [
        event({
          externalId: 'evt-stuck',
          title: 'Bhopal | Stuck Night',
          registrationUrl: 'https://luma.com/stuck-test',
        }),
      ],
      { key: 'test:stuck', complete: true },
    );
    await syncSource(source, db);
    const [first] = await db
      .select()
      .from(schema.eventSourceRecords)
      .where(eq(schema.eventSourceRecords.externalId, 'evt-stuck'));

    // The old bug's shape: promoted, no event, the real fingerprint stored.
    await db.delete(schema.events).where(eq(schema.events.id, first.eventId!));
    await db
      .update(schema.eventSourceRecords)
      .set({ eventId: null, rawHash: first.rawHash.replace(/^pending:/, '') })
      .where(eq(schema.eventSourceRecords.id, first.id));
    const before = await syncSource(source, db);
    expect(before.promoted).toBe(1);
    expect(
      (await db.select().from(schema.events).where(eq(schema.events.externalId, 'evt-stuck'))).length,
    ).toBe(0);

    await db.execute(
      sql.raw(readFileSync('db/migrations/0017_retry_stuck_promotions.sql', 'utf8')),
    );
    const after = await syncSource(source, db);
    expect(after).toMatchObject({ updated: 0, unchanged: 1, promoted: 1 });
    const [published] = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.externalId, 'evt-stuck'));
    expect(published?.status).toBe('published');
  });

  it('writes an append-only audit entry for each run', async () => {
    const entries = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'event.synced'));
    expect(entries.length).toBeGreaterThan(0);
    // A scheduled job is not a person, and the table allows that.
    expect(entries[0].actorId).toBeNull();
    expect(entries[0].actorMemberId).toBeNull();
  });
});

describe('fingerprinting', () => {
  it('ignores fields the source churns on every export', () => {
    // Luma bumps SEQUENCE and DTSTAMP every time; including them would mean
    // nothing is ever unchanged and every sync rewrites all 317 rows.
    expect(fingerprint(event({ sequence: 1 }))).toBe(fingerprint(event({ sequence: 999 })));
  });

  it('changes when something a visitor would see changes', () => {
    expect(fingerprint(event({ title: 'A' }))).not.toBe(fingerprint(event({ title: 'B' })));
    expect(fingerprint(event({ startsAt: new Date('2026-01-01T00:00:00Z') }))).not.toBe(
      fingerprint(event({ startsAt: new Date('2026-01-02T00:00:00Z') })),
    );
  });

  it('infers a format without deciding anything that matters', () => {
    expect(inferFormat('Bhopal | Claude Impact Lab')).toBe('impact-lab');
    expect(inferFormat('Claude Code Meetup Mumbai')).toBe('meetup');
    expect(inferFormat('Fable 5.1 Build Day')).toBe('hackathon');
    expect(inferFormat('Something Else Entirely')).toBe('other');
  });
});
