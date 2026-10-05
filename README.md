# WITH CLAUDE

**India is building.**

Where people across India meet, learn, experiment and build with Claude — a living discovery layer
for events, cities, builders, projects and stories in one place.

Target domain: **withclaude.in**

---

## What this is

Not a meetup landing page, and not a chapter directory. The product is a _discovery layer_ — an
editorial, cartographic index of a builder ecosystem, architected so that Bhopal is one node in a
network rather than the whole architecture.

It exists to answer seven questions: what is happening, where, who is building, what they made,
**how they actually use Claude**, what you can join, and how you contribute.

Three rules shape every decision in here:

1. **Nothing is invented.** Every event, date, venue, photograph and credit comes from the real
   community record. Where an archive is empty — projects, written stories — it renders an honest,
   designed empty state instead of filler. See [Content honesty](#content-honesty).
2. **One source of truth.** No page decides what "next" means, what state an event is in, or what
   is happening in a city. That lives in `src/lib/status.ts`, `src/lib/city.ts` and
   `src/data/index.ts`, and everything reads from it.
3. **It works without JavaScript.** Motion, the atlas readout, the archive filters, the join flow
   and the submission panels are all additive. With scripts blocked the page is complete, readable
   and navigable, and no control is dead.

## Run it

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # type-check, then build to dist/
npm run preview    # serve the built site
npm test           # vitest
npm run format     # prettier
```

The site runs with no configuration at all. `/api/submit` needs a database, so without one it
answers 503 and the forms fall back to the clipboard — which is exactly what a visitor would see
if the endpoint were down, and is worth seeing once.

To run the backend locally, copy `.env.example` to `.env`, fill it in, then:

```bash
npm run db:generate   # SQL from db/schema.ts, into db/migrations (only after a schema change)
npm run db:migrate    # apply migrations to DATABASE_URL
npm run db:import     # copy src/data/*.ts into the database — idempotent, run it as often as you like
npm run db:studio     # browse the data
```

`DATABASE_URL` can point at Neon or at a PostgreSQL on `localhost` — the driver is chosen from the
hostname. A local database is the easier way to work on the admin, which cannot do anything at all
without one:

```bash
createdb withclaude_dev
# DATABASE_URL="postgresql://postgres@127.0.0.1:5432/withclaude_dev"
npm run db:migrate
```

### The admin

```bash
cp admin/.env.example admin/.env
npm run db:create-user -- --email you@example.com --name "Your Name" --role admin
npm run dev:admin     # http://localhost:4322
npm run build:admin
```

`BETTER_AUTH_URL` must match how you actually reach it (`http://localhost:4322` locally), because
magic-link URLs are built from it and every state-changing request is checked against it.

**Signing in without a mail provider.** With no `RESEND_API_KEY`, the sign-in link is printed to
the admin's terminal and the log says so. Nothing pretends to have sent an email — copy the link
out of the terminal and open it. The two apps run side by side on different ports, which is the
same separation they have in production:

|             | Local                   | Production                    |
| ----------- | ----------------------- | ----------------------------- |
| Public site | `http://localhost:4321` | `https://www.withclaude.in`   |
| Admin       | `http://localhost:4322` | `https://admin.withclaude.in` |

`npm test` needs none of it: the database tests run against PGlite, which is PostgreSQL compiled
to WebAssembly and running in-process, so there is no server, no credential and no Docker.

Node 20+ (CI uses 24).

### Checks

CI (`.github/workflows/ci.yml`) runs on every pull request and every push to `main`:

1. `npm ci`
2. `npm run build`. It type-checks with `astro check` first and builds from the TypeScript record, so it needs no database and no secrets.
3. `npx vitest run --maxWorkers=2 --minWorkers=1`

`tests/equivalence-neon.test.ts` isn't part of CI, because it needs a live Neon credential. It runs only when you name it.

Preview smoke (`.github/workflows/preview-smoke.yml`) runs each time Vercel finishes a preview of
the `with-claude` project (not `with-claude-admin`), and on each production build that Vercel's
Deployment Checks hold before it goes live. It posts its result on the deployment's commit as
`Vercel - with-claude: smoke`. Chromium opens `/`,
`/events/`, `/cities/`, `/projects/` and `/about/` on the preview at three widths, and the run
fails on a non-200 status, a page that ends on another origin (Vercel's login, say), horizontal
overflow, a missing or repeated `<main>` or `<h1>`, or an uncaught script error. Console noise
alone does not fail it. The screenshots are attached to the run as the `preview-screenshots`
artifact. It runs on Vercel's `repository_dispatch` event, which GitHub reads from `main` only, so
it starts working once it is merged and no pull request can change what it runs.

What a maintainer has to set up for it:

1. **Vercel, `with-claude`:** under Settings → Git, check that `repository_dispatch` events are on.
2. **Vercel, `with-claude` and `with-claude-admin`:** under Settings → Git, turn off
   `deployment_status` events. GitHub runs a `deployment_status` workflow from the deployed
   commit, so once a fork's preview is authorized, any such workflow the fork adds would run with
   this repository's secrets. With the events off, it never runs.
3. **GitHub:** protect `main` (require a pull request and the `CI / check` status, no force
   pushes).
4. **Both:** previews are behind Vercel Authentication, so in Vercel create a secret under Settings
   → Deployment Protection → Protection Bypass for Automation, and in GitHub add it under Settings
   → Secrets and variables → Actions as `VERCEL_AUTOMATION_BYPASS_SECRET`. The check sends it to
   the preview's own origin only, never along a redirect. Vercel also hands this secret to every
   deployment as an environment variable, so authorizing a fork's preview gives it to the fork:
   read the diff first.
5. **GitHub, on the first run:** open the run's `payload` job and confirm it prints
   `environment: preview` and `project.name: with-claude` for a preview of the public site. The
   smoke job is filtered on those two values; if Vercel sends something else, it is skipped
   without an error, and the filter in `preview-smoke.yml` needs the printed values.
6. **Vercel, `with-claude`, to hold production on the checks:** under Settings → Build and
   Deployment → Deployment Checks, import `check` from GitHub. Once a production run of the smoke
   job has passed (its `payload` job prints `event: vercel.deployment.ready`), add `smoke` under
   "Send workflow updates to Vercel". A production build then goes live only after both pass on its
   commit, and a failed or missing result keeps the last good deployment live.

The same script runs locally against any URL:

```bash
BASE=http://localhost:4321 PAGES=/,/events/,/projects/ STRICT=1 node scripts/dev/visual-review.mjs
```

The smoke job also audits the event share cards — it reads the `og:image` off each rendered event
page and then fetches it, because eight of seventeen declared a 404 for the life of the pages and
nothing was checking. It runs against a deployment rather than in `ci.yml` because the event pages
are `prerender = false`: a local build has no event HTML to read a meta tag out of.

```bash
BASE=https://www.withclaude.in node scripts/dev/share-cards-audit.mjs
```

`STRICT=1` exits non-zero when a share card is broken. `STRICT_PAGES=1` additionally fails on
sitemap URLs that 404 — off by default, because production's `sitemap.xml` currently lists nine
event pages that do not exist, which is a separate defect this script only reports.

## The governance model

This is the part that is structural rather than cosmetic, and the part to not quietly undo.

There are three distinct kinds of thing on this site, and the data model keeps them apart:

| Kind                          | Who                          | How it is granted             | How it appears                         |
| ----------------------------- | ---------------------------- | ----------------------------- | -------------------------------------- |
| **Ambassador-led activity**   | Claude Community Ambassadors | Appointed by Anthropic        | The only filled chip on the site       |
| **Builders and contributors** | Anyone building with Claude  | Self-submitted, then reviewed | An outline chip in the builder index   |
| **City interest**             | People who live there        | Registered by anyone          | A signal on the atlas, never a chapter |

Three consequences are enforced by the types, not by editorial discipline:

- **An event is Ambassador-led because `host.ambassadorSlug` resolves to a published `Ambassador`
  record.** There is no `verified: true` flag to set. `src/data/ambassadors.ts` is the single most
  consequential file in the repo, and every entry must carry `verifiedVia` — if you cannot say how
  you know, there is no record to write.
- **A `City` record contains no community status at all.** There is no `active` field and no way to
  promote a city by editing `cities.ts`. `cityState()` in `src/lib/city.ts` derives one of four
  states from verified records: `ambassador-led`, `event-activity`, `community-interest`,
  `discovery`. A city with nothing verified derives to `discovery`, and the page says so plainly.
- **Submissions enter at `status: 'pending'`.** `isPublic()` gates everything the site renders, so
  nothing self-publishes. The `ambassador` role in `builders.ts` is ignored by the UI — it is read
  from `ambassadors.ts` — so writing it by hand achieves nothing, which is the point.

There is deliberately no "start a chapter" anywhere on this site. Hosting Claude Community events
means becoming a Claude Community Ambassador, which is Anthropic's programme; the HOST path routes
there and says so.

## Stack

- **Astro 5 + TypeScript**, static output. No React, no UI framework — the four interactive islands
  (atlas, archive filters, join flow, submission panels) are a few dozen lines of vanilla TS each,
  which is smaller and faster than shipping a runtime for them.
- **Self-hosted fonts** via Fontsource (no external requests): Fraunces Variable (WONK axis only —
  the expressive axis, at a third the file size of the full build), Inter Variable, IBM Plex Mono.
- **`astro:assets`** for responsive images (WebP, explicit dimensions, lazy below the fold).
- **PostgreSQL on Neon + Drizzle ORM**, server-side only, for submissions. Reached by exactly one
  route (`/api/submit`); nothing public reads it yet.
- **Zod** for server-side validation, **Resend** for the transactional email each app sends.
- **better-auth** for the admin's magic-link sign-in — declared in `admin/package.json` only, so
  the public site cannot even resolve it.
- The public site still ships zero runtime dependencies. None of the above reaches the browser —
  `tests/security.test.ts` and `tests/admin-isolation.test.ts` search the built bundle to prove it.

## Architecture

```
src/
  data/            the record — plain typed modules, no build-tool imports
    types.ts         the domain model, and the governance rules it encodes
    ambassadors.ts   verified Ambassadors. Every entry needs `verifiedVia`.
    events.ts        11 real events, each with a resolvable host
    cities.ts        14 cities — coordinates and context, no status
    builders.ts      the open index
    projects.ts      empty on purpose
    stories.ts       empty on purpose
    use-cases.ts     empty on purpose — the knowledge library
    guides.ts        empty on purpose
    forms.ts         the four submission forms and their fields
    site.ts          brand, affiliation, official links, participation paths, FAQ
    index.ts         every derived selector the pages read
  lib/
    status.ts        THE event lifecycle machine — computed, never authored
    city.ts          THE city state machine — derived from verified records
    search-core.ts   THE search matcher — pure, runs on the server AND in the browser
    search.ts        the data-bound half: builds the index and the vocabulary
    seo.ts           titles, breadcrumbs and per-entity structured data
    indexable.ts     what earns a place in search results (read by the sitemap too)
    datetime.ts      IST-pinned date and time formatting
    geo.ts           the map projection, scale bar and coordinate stamp
    atlas.ts         the shape the atlas serialises to its island
    images.ts        resolves data-layer image keys to optimised assets
  styles/
    tokens.css       every colour, size, duration. Nothing else holds a raw value
    base.css         reset, document typography, a11y primitives, the reveal system
    primitives.css   containers, meridian, buttons, chips, pips, plates, fields
  components/      one concern each, styles scoped alongside
  scripts/         the six islands — browser only
  server/          server only. Never imported by anything that reaches a browser.
    submissions/
      validate.ts    the rules, derived from forms.ts. Rejects unknown fields.
      handle.ts      the pipeline, with its database and mailer passed in
      rate-limit.ts  honeypot timing, per-address and per-email ceilings
      identity.ts    salted one-way IP hashing. The address is never stored.
    email/
      acknowledge.ts the one transactional email. Fails visibly, never silently.
  layouts/Base.astro   head, SEO, JSON-LD, masthead, meridian, footer
  pages/           routes
    api/submit.ts    the ONLY write path. prerender = false.
    api/cron/rebuild.ts  the nightly rebuild trigger. prerender = false.
db/                server only. Shared by both apps. One schema, one set of migrations.
  schema.ts        the governance rules, as constraints a database will enforce
  client.ts        Neon over HTTP — one insert per request, for /api/submit
  pool.ts          pooled and transactional, for the admin. Driver picked by URL.
  env.ts           refuses to start if a secret was exposed as PUBLIC_*
  migrations/      committed SQL. The only way production ever changes.
  import/          the idempotent copy of src/data into PostgreSQL
  create-user.ts   the ONLY way an editorial account is created
  testing.ts       an in-process PostgreSQL for the tests
admin/             a SEPARATE Astro app. output: 'server'. Its own Vercel project.
  src/middleware.ts  the gate. Private by default; four paths are not.
  src/server/
    auth.ts          better-auth: magic link, no sign-up, hashed tokens
    session.ts       who is asking, re-checked against the database every request
    login.ts         the allowlist gate. Tells nobody whether an address exists.
    transitions.ts   THE submission state machine. Audit + status, one transaction.
    submissions.ts   the queue and detail queries. The privacy line lives here.
    email.ts         the sign-in link. Fails loudly; never fakes a send.
  src/pages/         login, submissions, submissions/[id], audit, and two APIs
tests/             vitest — lifecycle logic, dates, governance, the schema, the
                   import, the endpoint, and the security boundary
scripts/           dev tooling (screenshots, audit, OG card). Not part of the build.
```

### Routes

| Route               | State                                                              |
| ------------------- | ------------------------------------------------------------------ |
| `/`                 | The homepage — twelve movements, five grounds                      |
| `/discover`         | Search the community — the whole index, ranked and grouped         |
| `/events`           | Next event + the filterable archive                                |
| `/events/[slug]`    | 11 pages, one per event                                            |
| `/cities`           | The atlas + the index + city registration                          |
| `/cities/[slug]`    | 14 pages; live and quiet cities get genuinely different treatments |
| `/builders`         | The open index + submission + the photographic record              |
| `/builders/[slug]`  | Profile, honest about what the entry is missing                    |
| `/projects`         | The archive (empty) + submission                                   |
| `/projects/[slug]`  | Generates nothing today; ready for the first real submission       |
| `/stories`          | The photographic record + what a written piece would be            |
| `/stories/[slug]`   | Generates nothing today; wired into the same graph                 |
| `/use-cases`        | Claude in practice — the knowledge library (empty)                 |
| `/use-cases/[slug]` | Generates nothing today; the workflow record is fully built        |
| `/guides`           | Practical writing, and the standard it is held to (empty)          |
| `/guides/[slug]`    | Generates nothing today                                            |
| `/record`           | Community memory — everything dated, by month                      |
| `/about`            | The trust layer: verification, numbers, corrections, stewardship   |
| `/join`             | Three questions, the ways in, and all four submission forms        |
| `/community`        | The governance model, Ambassadors, city states, FAQ, partners      |
| `/404`              | —                                                                  |

## The design system

Read `src/styles/tokens.css` first — it is the whole system, and the only file with raw values.

**Ground.** Warm paper (`--paper`) with ink type. Sections that flip dark add `.on-night` (or
`.on-deep` for the one darkest moment per page), which remaps the semantic tokens rather than
overriding colours one by one, so everything inside keeps working unchanged. The homepage's twelve
movements run light → sunk → light → raised → **dark** → light → **deepest** → light → image-led →
sunk → raised → **dark**, so the page has rhythm rather than twelve identically-weighted panels.

**Colour discipline.** Clay (`--clay`) is reserved for live/next state, the meridian, and the mark.
It is never decoration. There is a hard contrast rule written into the token file:

- `--clay` on paper is 2.7:1 — **fill only, never text**
- `--clay-deep` on paper is 5.6:1 — safe for text
- `--clay` on night is 5.9:1 — safe for text

**Type.** Fraunces (display, `WONK 1` — the axis that gives it a voice), Inter (body), IBM Plex
Mono (all metadata, labels and coordinates). The scale is deliberately gapped rather than modular.
It renders at true 100% zoom: an earlier build applied `zoom: 0.8` to the whole document to fake
density, which quietly made every rem value a lie and pushed metadata under 11px.

**Shape.** Hairlines and right angles. Nothing on this site is a pill; the largest radius is 3px.

**The wordmark.** Two words, two weights: WITH is the light italic and CLAUDE is the heavy roman, so
the relationship reads before the words do. `with` is the brand's recurring device — MADE WITH
CLAUDE, WITH YOUR CITY — and it earns that by being the first word of the name, which is also why
it is not sprayed across every heading.

### The meridian

One clay thread runs the left rail and fills as you travel down the page. It no longer carries
numbered section ticks: numbering every movement turned each one into an entry in the same
scientific report, which is the sameness this redesign had to lose. Sections now differ by ground,
width and air, and each writes its own eyebrow.

### The atlas

`src/lib/geo.ts`, `components/CityAtlas.astro`, `src/scripts/atlas.ts`.

The map is **a coordinate plot, not a traced outline**, with a real scale bar and a north mark to
say so. Deliberate for three reasons: every point is honest; it sidesteps depicting national
boundaries, which is a regulated matter in India and not something a community site should get
wrong; and it reads as cartography rather than a Google Maps clone.

What it communicates is community state, and the four states are separated by **form before
colour** — a filled station, an open ring, a solid dot, a hairline — so the plate still reads in
monochrome and for a colour-blind reader. The legend shows every state with its count, including
the zeros.

Interaction differs by input, on purpose:

- **Fine pointer** — hover or focus previews a city in the readout; clicking navigates.
- **Coarse pointer, phone width** — the plate becomes a drawing and the city list beside it is the
  control. Mumbai and Pune are 27 plate units apart, which at 390px is 14 real pixels: any target
  big enough for a fingertip swallows its neighbour and the wrong city opens. The list carries
  every city as a full-width row instead. Keyboard focus still drives the readout.

Arriving at a city also gives it an **activation form**, and the four community states answer with
four different ones rather than four different colours:

| State              | Form                                               |
| ------------------ | -------------------------------------------------- |
| Ambassador-led     | a short, firm ring thrown from the station, 720ms  |
| Event activity     | a wider ring, eased both ends, watched out, 1080ms |
| Community interest | a ring held at a fixed radius — it does not travel |
| Discovery          | four register ticks step outward and stop          |

Convert the plate to greyscale and the four are still separable, which is the rule the whole atlas
is built on. Each is a single pass — nothing loops. With motion reduced the ring is simply present
at a fixed opacity, so the state is never carried by the animation alone.

### The scout

`components/Scout.astro`, `src/scripts/scout.ts`.

A survey instrument standing in open water on the plate — a tripod, a hooded head with a brim, two
eyes — drawn in the same hairline language as the rest of the cartography. Its eyes follow the
pointer, it leans a few degrees toward whatever has its attention, and it puts out a bearing line
when it fixes on a city or on one of the handful of controls marked `data-scout-target`. Two
seconds after the pointer stops it settles back.

There is deliberately **no idle loop**. A figure that fidgets on an empty page is decoration; one
that is still until you arrive is an observer. The animation frame stops as soon as every channel
has arrived, so a page nobody is touching costs nothing.

It is `aria-hidden` and carries no information. On a coarse pointer it is removed entirely — there
is no cursor to follow, and a figure frozen mid-glance is worse than no figure. Under
`prefers-reduced-motion` the script never initialises and it renders at rest.

The atlas and the scout are separate islands that never import each other: the atlas publishes
`scout:look` and `scout:release` on the document, and neither has to exist for the other to work.

### WITH

`components/WithIndex.astro`.

The name of the site is a preposition, and this is where that is stated rather than implied. Five
strands — builders, projects, cities, events, stories — each reporting what is actually on the
other end of it. Arriving at one draws a clay thread from the word, through the count, and off the
end of the row toward the photograph and figures it reaches; the italic WITH lifts from 0.3 to full
opacity as the connection is made. Connection, drawn.

Every figure is counted from the record. A strand with nothing behind it shows `00` and says what
is true instead — an index of relationships is worthless the moment it starts implying ones that do
not exist.

All five previews are server-rendered and one is active, so with scripts blocked the first strand
stands and every row is still an ordinary link. Below the desktop split the preview column goes and
each row carries its own sentence, because there is no hover there to open one with.

### Search

`src/lib/search-core.ts`, `src/lib/search.ts`, `src/scripts/search.ts`, `components/CommunitySearch.astro`.

One index over the whole graph — people, projects, events, cities, use cases, stories, guides —
built at compile time from the same selectors every page reads. There is no second copy of the
record and no search-only content: if something is not published, it is not in the index.

**There is deliberately no model in it.** The obvious version of this feature ships an LLM and
calls the result "AI search". For a few hundred records that is slower, less predictable and less
honest than matching strings, and it fails in the one way a directory must not — by inventing a
plausible answer. So the work is split in two, and the seam is the point:

```
parseQuery(text, vocab)   →  SearchIntent      what is being asked for
runSearch(index, intent)  →  SearchResult[]    what the record contains
```

`runSearch` only ever reads real records, so it cannot return something that is not there.
`parseQuery` is a deterministic parser that reads city names, event formats and Claude surfaces
straight out of the data — `Claude Code builders in Bengaluru` resolves to
`{ kinds: ['person'], city: 'bengaluru', surface: 'claude code' }` by looking each part up. Nothing
is guessed: a city has to be a city in `cities.ts`. When a natural-language layer is worth adding,
it replaces `parseQuery` alone and everything downstream is unchanged. A model would get to
interpret the question; it would never get to answer it.

The vocabulary is derived rather than hard-coded, which is what stops the parser understanding a
city the atlas does not plot. Event formats are read as **formats, not kinds**: `workshops` returns
the four workshops rather than all eleven events, which is the difference between a search and a
table of contents.

`search-core.ts` imports nothing from `src/data`, because it runs twice — once at build time to
render `/discover`, and once in the browser as you type. The island reads the precomputed haystack
off each row's `data-terms` rather than fetching an index, so there is one scoring implementation
across two runtimes and no way for them to drift.

With scripts blocked, `/discover` is the entire index, ranked and grouped — a complete browsable
directory. The field and the type tabs are `js-only` and the page says so, because a dead control
is worse than an honest fallback.

### The record

`components/Timeline.astro`, `timeline()` in `src/data/index.ts`.

Community memory, by month, reading forward in time. It is the site's slowest-compounding asset and
the hardest for anyone else to copy: an events page can be rebuilt in a weekend, three years of
what actually happened cannot.

Nothing on it is authored. Every entry is generated from a record carrying a real date, which is
why a quiet month renders as a quiet month. The activity feed and the timeline read the same
assembler, so the two can never tell different stories about the same month. Held entries take a
filled mark and scheduled ones an open ring — form before colour, the same rule as the atlas.

### Archival plates

`.plate-archival` in `primitives.css`, driven from `scripts/enhance.ts`.

A photograph is treated as a print you could pick up: under a fine pointer it shifts a couple of
millimetres, tilts about a degree and a half, and drops its shadow the other way — the light source
stays put. The numbers are deliberately small. This is weight, not a card flip. Both displacement
values live in CSS custom properties that default to zero, so with scripts blocked the plate is a
plate.

## Content honesty

| Area                      | State                                                                         |
| ------------------------- | ----------------------------------------------------------------------------- |
| Events                    | 11 real events, real registration links, real venues                          |
| Ambassadors               | 1 — Aniket Sahu, Bhopal, with `verifiedVia` recorded                          |
| Cities                    | 14 plotted; 1 Ambassador-led, 13 `discovery` and explicitly labelled as such  |
| Builders                  | 2 — publicly credited workshop leads. No invented bios, portraits or links.   |
| Projects                  | **Empty.** No verified submissions exist yet.                                 |
| Stories                   | **Empty** of written pieces. Runs on the photographic record instead.         |
| Use cases                 | **Empty.** Nobody has written up how they actually work yet.                  |
| Guides                    | **Empty.** A guide is commissioned by a question, never by a keyword.         |
| Member / prototype counts | Community-reported, kept out of the derived counts, rendered with the source. |
| `createdAt` timestamps    | Omitted where unknown, so the activity feed can never show invented activity. |

`tests/data.test.ts` enforces this. A city cannot reach `ambassador-led` without a real Ambassador
record; a city with no events cannot claim an organiser or report figures; every Ambassador must
say how the status was verified; every record must carry a moderation status; and everything the
community writes must carry an author with a credential, because an unattributed workflow is
indistinguishable from a generated one.

The empty archives are designed, not broken. `/projects` states the fact, says what an entry holds
so a submitter knows what is being asked, and gives one action. Add one real project to
`src/data/projects.ts` and the grid takes over automatically.

`/use-cases` does something slightly different with its empty state, on purpose — the failure mode
there is not an empty page, it is a full one. It prints the **anatomy** of an entry and the standard
it is held to, so anyone arriving with a tips post can tell immediately that it does not qualify.
The bar is: a named author with a checkable credential, a real problem, what Claude did AND what
the person did kept separate, and a result that includes what did not work. "How a Bhopal builder
uses Claude Code to prototype products" passes; "10 best Claude Code tips" does not, and no amount
of search volume changes that.

### Submissions

There is no backend, and inventing one would be worse than not having one. `SubmitPanel` composes
what you typed into a clean, complete block of text and hands it to you to send through the channel
the community actually reads — you press send, so nothing leaves the browser without you doing it.
When a real endpoint exists, set `endpoint` on the form in `src/data/forms.ts` and the panel posts
to it instead. Nothing else changes.

### Relationship to Anthropic

This is an independent, non-commercial, volunteer-run community. It is **not** an Anthropic
property, programme or endorsement. That line lives in `site.affiliation` and renders in the
footer, the FAQ, `/community` and the JSON-LD — where there is deliberately no
`parentOrganization`, `sponsor` or `memberOf` pointing at Anthropic, because asserting a
relationship in structured data is still asserting it.

Every "Become a Claude Community Ambassador" CTA — in the participation paths, on `/community`, on
every quiet city page, and in the footer — reads `official.ambassadorProgramUrl` in
`src/data/site.ts` and goes to <https://claude.com/community/ambassadors>. That field is typed as a
required `string` rather than an optional one specifically so no fallback can exist: someone who
wants to host events should land on the programme page, not on a homepage to navigate from.

## Adding to the record

**A new event** — add one entry to `src/data/events.ts`. Nothing else: the hero, the masthead chip,
the meta description, the JSON-LD, the archive and every status badge derive from it. There is no
"featured" flag to move and no date to update in a second place.

**A new Ambassador** — add to `src/data/ambassadors.ts` with a real `verifiedVia`. That single edit
is what turns their city Ambassador-led and gives their events the verified treatment.

**A project, builder or story** — fill in the array with `status: 'published'`. The UI switches out
of its empty state on its own, and the relevant filters appear because facets are built from what
is actually there.

**A use case or a guide** — same, with one extra requirement the tests enforce: an `author` with a
`credential` you could check. A use case must also name what Claude did and what the person did
separately; a record that cannot say what the human contributed is a product demo, not a workflow.

Everything added this way lands in the search index, the activity feed, the timeline and the
relevant city, builder and event pages without another edit — that is what the graph in
`src/data/index.ts` is for.

## Submissions

Every form on the site posts to `POST /api/submit`, which is the only write path the public site
has. It does exactly this and nothing else:

```
validate → rate limit → write one submissions row → send an acknowledgement → 202
```

**A submission is an inbox item.** It publishes nothing, creates no builder and no project, and
changes no record's status. `id`, `slug`, `status`, `entity_type`, `reviewer_id` and their
relatives are not fields with strict validation — they are refused by name, because they belong to
the editorial side of the system and a submitter has no business naming one. Nothing becomes
public until a person decides it should, which is the same promise every form already made in
prose and is now enforced in code.

202 rather than 201 is the accurate status: the request was accepted, and no resource was created
that the caller can go and look at.

**The clipboard fallback still matters.** If the POST fails for any reason, the panel composes what
you typed into a clean block of text with a copy button and a link to the community channel. A form
that loses somebody's answers because a server is having a bad afternoon is worse than a form with
no server, so the path that never needed one is kept.

**Anti-abuse, without a CAPTCHA.** A hidden honeypot, a minimum time-to-submit, a request size
ceiling, and per-address and per-email rate limits counted straight out of the `submissions` table.
No Redis: this is a community site receiving single-digit submissions a week, and two indexed counts
cost less than the round trip to a second always-on service would. No CAPTCHA: it taxes every honest
visitor, hands a third party a record of them, and loses to the automation it claims to stop.

**Privacy.** A submitter's email is never rendered by the public site — there is no public read path
to the table at all, which is the only way to actually guarantee it. IP addresses are salted and
hashed before storage and the original is discarded; the stored value is good for counting and
useless for identifying anybody. `tests/security.test.ts` searches the built site for the private
column names and the browser bundle for connection strings.

**The email is honest.** If Resend is not configured, the endpoint still stores the submission and
still returns 202, but it does not pretend to have sent anything: the response says
`acknowledgementSent: false` and the panel says so too, rather than promising a message that is
never going to arrive.

## The database

`db/schema.ts` carries the governance rules that TypeScript can only describe. Read the absences:

- **No city state column.** No `chapter`, no `tier`, no `active`. A city becomes ambassador-led
  because a verified ambassador row points at it, and there is nothing an editor can set instead.
  `region` is the Indian state — geography, named so it can never be mistaken for a lifecycle.
- **No stored event lifecycle.** No `upcoming` / `today` / `live` / `past`. Only `status_override`,
  for the three door states a clock genuinely cannot know.
- **`builders.roles` cannot contain `ambassador`** — a CHECK rejects it. The role is read from
  `ambassadors`, which requires non-empty `verified_via`, or it is not read at all.
- **Credentials and alt text are NOT NULL.** No anonymous authority, no undescribed image.
- **A reported figure cannot be stored without its source.**
- **`audit_log` is append-only** — triggers reject UPDATE, DELETE and TRUNCATE. Created in Phase 1
  even though the dashboard that writes to it is Phase 2, because a log that starts the day the
  dashboard ships cannot answer questions about the day before.

`npm run db:import` copies `src/data/*.ts` in. It is idempotent, it deduplicates organisations
(`The Origin Guild` is one organisation whether it is named on an event or as a city's organiser),
and it **fails loudly** on any reference it cannot resolve rather than writing a null. It invents no
timestamps: `created_at` is backfilled only where the repository evidences a date — an event was
created no later than the day it was held, and the Impact Lab cohort came off a submission form on a
date the record states in prose. Everything else stays null.

**`src/data/*.ts` remains the public site's source of truth.** Every page still renders from those
files. The database is populated and tested, and nothing public reads it yet — that is Phase 3.

## The admin

`admin.withclaude.in` is a **separate Astro application** in `admin/`, deployed as its own Vercel
project. The two share `db/` and share nothing else — no cookie, no bundle, no build. That is what
makes "the public site has no authentication" a fact about the artifact rather than a claim about
the code, and `tests/admin-isolation.test.ts` checks the artifact.

|                   | `withclaude.in`              | `admin.withclaude.in`                          |
| ----------------- | ---------------------------- | ---------------------------------------------- |
| Output            | `static` — 71 files on a CDN | `server` — every response rendered per request |
| Session           | none                         | HttpOnly, Secure, SameSite=Lax, host-only      |
| Database          | one insert, over HTTP        | pooled, transactional                          |
| Prerendered pages | 71                           | 0                                              |

**Sign-in is an emailed link, and only for accounts that already exist.** There is no sign-up
anywhere. `npm run db:create-user` writes the row; the login form checks `users` and, if there is
no active row with an admin role, sends nothing at all. The confirmation it shows is identical
either way — a login form that says "no such user" is a way to enumerate who has editorial access
to this project, and the first step of every targeted phishing attempt that follows.

**Two roles: `admin` and `editor`.** Both can review. The architecture deliberately treats
Moderator as Editor rather than inventing a third tier that means almost the same thing. `role` and
`active` are read from the database on _every request_, never from the session token, so
deactivating an account or demoting a role takes effect on that person's next click rather than
whenever their session expires.

### The review workflow

```
draft → pending → in_review ─┬→ changes_requested → pending
                             ├→ approved
                             └→ rejected
```

Every status change goes through one function — `transitionSubmission()` in
`admin/src/server/transitions.ts` — and no route writes `submissions.status` itself. It checks the
actor's role, that the transition is on the map above, and that a note was written where refusing
somebody's work requires one, then writes the audit entry and the status change **in a single
transaction**. Both halves or neither: the log never records a move that did not happen, and no
move happens unaccounted for.

`request_changes` and `reject` require a non-empty note. A refusal with no reason is not a review.

**`approved` is not `published`.** Approving records that a person read something and it belongs in
the record. It puts nothing on the website. Publication is tied to a build and is Phase 3 — which
is exactly why they are different words.

### Privacy

The queue selects five columns: kind, name, status, received, age. `submitter_email`, `ip_hash` and
`user_agent` are not hidden from it — they are never fetched, so they are never in memory and
cannot leak through a template edit or a debug dump. The submitter's email appears on the
authenticated detail page and on no other screen, because a reviewer asking for changes has to be
able to reply. `ip_hash` and `user_agent` appear nowhere: they exist for abuse triage, which is not
editorial review.

### `/audit`

Read-only, and it could not be otherwise — the table rejects UPDATE, DELETE and TRUNCATE at the
database. Correcting an entry means appending a correcting one, which is the point: the history of
what was believed is itself part of the record.

### Storage, by phase

- **Neon PostgreSQL** — the database, from Phase 1. Records, submissions, users, audit log.
- **Vercel Blob** — the planned media store for **Phase 4**. Not installed, not configured, not
  referenced. A dependency added for a phase that has not started is how a phase boundary stops
  meaning anything.

## Search visibility

The strategy is topical authority through real entities, not keywords. Every record links to the
records around it — an event to its city, host, speakers and projects; a builder to their city,
projects, events and write-ups; a use case to its builder, project, city and event — so the
internal link graph is the community graph. That is the whole plan, and it is why there is no
`/claude-meetup-india-2026` page.

**Structured data must match visible content.** `src/lib/seo.ts` emits `Organization` and `WebSite`
site-wide, `BreadcrumbList` wherever a trail is rendered, `Event` on events, `ProfilePage` +
`Person` on builders, and `Article` on stories, guides and use cases. Two rules are load-bearing:
`sameAs` only carries links the page actually shows, and `author` is **omitted** rather than
defaulted to the organisation when a piece has no byline — a fabricated author is the single most
damaging thing that could go in this graph, and "the site wrote it" is not an author.

**Breadcrumbs are real links**, not just JSON-LD. A trail that exists only in structured data is a
claim about a hierarchy the page does not offer.

**Not everything navigable is indexable.** Every city on the atlas gets a real page — clicking a
dot must always land somewhere honest — but a city with no events, builders, projects or stories
is `noindex` and is left out of the sitemap. Thirteen of the fourteen city pages are in that state
today, which is exactly the point: generating them as landing pages would be the thin programmatic
SEO farm this project refuses to build. One real record of any kind flips a city over.

The rule lives in `src/lib/indexable.ts` and is read by both the page and `astro.config.mjs`, so
the sitemap can never advertise a page marked `noindex`. That module uses relative imports because
the Astro config is evaluated before the `@` alias exists — the alternative was two copies of the
same condition, free to drift.

`/discover` is indexable because it is a genuine ranked directory. `?q=` is not a separate page:
the site is static, the query is applied by the island, and the canonical tag points at the bare
path, so no result set can become its own thin URL.

## Accessibility

Semantic landmarks and a logical heading order; a skip link; visible 2px focus rings that are never
styled away; every atlas node reachable by keyboard with the readout responding to focus as well as
hover; the WITH strands switching on focus as well as hover; no control anywhere that only works on
hover; `prefers-reduced-motion` honoured throughout (the reveal system only displaces content once
JS confirms motion is wanted, so with it off the page is simply finished; the scout never
initialises and the atlas rings hold still); comfortable touch targets; AA contrast, with the clay
rule above enforcing the one place it would otherwise slip.

One thing is revealed by hover and should be named rather than glossed: the second caption line on
an archival plate. It is always in the DOM and so always announced, and it is always visible where
hover does not exist — on touch, and under reduced motion. A sighted keyboard-only user on a
desktop pointer is the one case that does not see it, which is why nothing unique to the site is
ever put there.

`node scripts/audit.mjs` checks heading order, landmarks, alt text, link names, overflow, focus,
touch targets and the no-JS render across every route.

## Deploying

**Vercel, and only Vercel.** The project is linked to one (`.vercel/project.json`), the headers and
the nightly cron live in `vercel.json`, analytics come from `@vercel/analytics`, and `/api/submit`
is built by `@astrojs/vercel`. A `netlify.toml` sat alongside all of that describing a pure-static
publish of `dist`; it was never used by the live site and, since the submission endpoint landed, it
described a deployment that would ship a broken form. It has been removed rather than left as a
second, wrong answer to "where does this run".

The site is still **static-first**: `output: 'static'` prerenders all 71 pages at build time, and
only routes that opt out with `export const prerender = false` become functions. Today that is
`/api/submit` and `/api/cron/rebuild`. Everything a visitor reads is a file on a CDN.

**The nightly rebuild.** Event lifecycle is derived from the clock, so a static build goes stale
without any commit: an event that finished last night keeps saying "Upcoming" until something
rebuilds. `vercel.json` schedules `/api/cron/rebuild` at `30 22 * * *` UTC — **04:00 IST** — which
POSTs to a Vercel deploy hook and triggers an ordinary production build. Nothing stays running.

To finish setting it up: create a deploy hook in _Project Settings → Git → Deploy Hooks_ against
the production branch, and set `VERCEL_DEPLOY_HOOK_URL` to its URL. `CRON_SECRET` is set by Vercel
and is checked by the route, so the trigger cannot be fired by anyone who finds the URL.

### The admin, as a second Vercel project

`admin/` deploys separately from the same repository. Two projects, one git remote:

| Setting                    | Value                                |
| -------------------------- | ------------------------------------ |
| Root Directory             | `admin`                              |
| Include files outside root | on — the app imports `../db`         |
| Build Command              | `npm run build` (run inside `admin`) |
| Output                     | detected from `.vercel/output`       |
| Domain                     | `admin.withclaude.in`                |

Environment variables, all server-side, none prefixed `PUBLIC_`:

| Variable             | Notes                                                                 |
| -------------------- | --------------------------------------------------------------------- |
| `DATABASE_URL`       | the **same** value as the public project. One database, one schema.   |
| `BETTER_AUTH_SECRET` | 32 random bytes. Rotating it signs everybody out.                     |
| `BETTER_AUTH_URL`    | `https://admin.withclaude.in`, no trailing slash. Must match exactly. |
| `RESEND_API_KEY`     | without it, production sign-in fails loudly rather than silently.     |
| `RESEND_FROM`        | an address on a domain verified in Resend.                            |
| `RESEND_REPLY_TO`    | optional.                                                             |

`SUBMISSION_IP_SALT` is _not_ set here — it belongs to the public site's `/api/submit`, and the
admin never stores an address.

Then create the first account, from a machine that has the production `DATABASE_URL`:

```bash
npm run db:create-user -- --email you@example.com --name "Your Name" --role admin
```

There is no other way to create one. The web interface cannot, deliberately: access to the admin is
this project's whole security boundary, and a form that grants it is a form reachable by a stolen
session or a bug in a role check.

Set `site` in `astro.config.mjs` if the domain changes — canonical URLs, Open Graph tags and the
sitemap all read from it. Regenerate the share card after a brand change: `node scripts/og.mjs`.

## Dev tooling

`scripts/shoot.mjs` and `scripts/shoot-pages.mjs` screenshot the site across the breakpoints the
design targets, using Playwright. `scripts/audit.mjs` runs the structural accessibility pass.
`scripts/slice.py` cuts a tall full-page capture into readable bands. None are part of the build.

## Credits

Community events in Bhopal are organised by [The Origin Guild](https://t.me/tog_guild). Event
photography and the event record come from that community. City photography carries its original
Wikimedia Commons and Unsplash attribution — see `src/assets/city/`.
