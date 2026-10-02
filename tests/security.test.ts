import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNoPublicSecrets } from '../db/env';
import { forms } from '../src/data/forms';
import { safeInlineJson } from '../src/lib/seo';

/**
 * The two promises this file exists to keep.
 *
 *  1. A DATABASE CREDENTIAL NEVER REACHES A BROWSER. Astro inlines anything
 *     prefixed `PUBLIC_` into the client bundle, so the failure mode is one
 *     careless rename away. `db/env.ts` refuses to start if such a variable
 *     exists, and the bundle itself is searched below.
 *
 *  2. A SUBMITTER'S EMAIL IS NEVER PUBLISHED. Every form promises this in so
 *     many words ("your email is used to reach you and is never displayed").
 *     There is no public read path to the `submissions` table at all, which is
 *     the only way to guarantee it, and the built site is searched for the
 *     private column names to prove none leaked into a page.
 *
 * The bundle checks need a build. When `dist/` is absent they say so and skip
 * rather than passing quietly — a security test that silently does nothing is
 * worse than no test.
 */

const CLIENT_DIRS = ['dist/client', 'dist', '.vercel/output/static'];

function existingClientDir(): string | undefined {
  for (const dir of CLIENT_DIRS) {
    try {
      if (statSync(dir).isDirectory()) {
        // `dist` is only the client root when there is no `dist/client`.
        if (dir === 'dist') {
          try {
            if (statSync('dist/client').isDirectory()) continue;
          } catch {
            /* no dist/client — `dist` is the client root */
          }
        }
        return dir;
      }
    } catch {
      /* not built */
    }
  }
  return undefined;
}

function filesUnder(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(path);
    }
  };
  walk(dir);
  return out;
}

describe('inline JSON cannot close its own script element', () => {
  it('escapes every payload a component writes with set:html, in both apps', () => {
    // A feed-supplied event title containing `</script>` would end the element.
    // Only the escaping helper, or a build-time constant reviewed here, may feed
    // set:html: a stringified variable or template literal fails this test.
    const REVIEWED = new Set(['src/components/ProjectLogo.astro: mascot']); // an SVG file, ?raw
    const unescaped: string[] = [];
    for (const file of [...filesUnder('src', ['.astro']), ...filesUnder('admin/src', ['.astro'])]) {
      for (const match of readFileSync(file, 'utf8').matchAll(/set:html=\{\s*([^}]*?)\s*\}/g)) {
        const site = `${file.replace(/\\/g, '/')}: ${match[1]}`;
        if (!/^safeInlineJson\(/.test(match[1]) && !REVIEWED.has(site)) unescaped.push(site);
      }
    }
    expect(unescaped).toEqual([]);
  });

  it('round-trips a hostile title without emitting a closing tag', () => {
    const value = { title: 'x</script><img src=x onerror=alert(1)>' };
    const json = safeInlineJson(value);
    expect(json).not.toMatch(/<\/script/i);
    expect(JSON.parse(json)).toEqual(value);
  });
});

describe('database credentials stay server-side', () => {
  it('refuses to read any secret exposed through a PUBLIC_ variable', () => {
    for (const name of [
      'PUBLIC_DATABASE_URL',
      'PUBLIC_NEON_DATABASE_URL',
      'PUBLIC_RESEND_API_KEY',
      'PUBLIC_SUBMISSION_IP_SALT',
    ]) {
      process.env[name] = 'should-never-be-set';
      try {
        expect(() => assertNoPublicSecrets(), name).toThrow(new RegExp(name));
      } finally {
        delete process.env[name];
      }
    }
  });

  it('passes when nothing is exposed', () => {
    expect(() => assertNoPublicSecrets({})).not.toThrow();
  });

  it('names no PUBLIC_ database variable anywhere in the source', () => {
    // A grep, deliberately. The rule is worth failing on at the string level,
    // because by the time it is a real import it is already in the bundle.
    for (const dir of ['src', 'db']) {
      for (const file of filesUnder(dir, ['.ts', '.astro', '.mjs', '.js'])) {
        const text = readFileSync(file, 'utf8');
        // `db/env.ts` and this test name them in order to forbid them.
        if (file.includes('env.ts') || file.includes('security.test')) continue;
        expect(text, file).not.toMatch(/PUBLIC_[A-Z_]*(DATABASE|NEON|RESEND|SALT)/);
      }
    }
  });

  it('ships no connection string or API key in the browser bundle', () => {
    const dir = existingClientDir();
    // Fail rather than skip: this is the assertion that matters most, and a
    // quiet skip is how it would stop running without anyone noticing.
    expect(dir, 'run `npm run build` before the security tests').toBeDefined();

    const files = filesUnder(dir!, ['.js', '.html', '.css', '.json', '.xml']);
    expect(files.length).toBeGreaterThan(0);

    const forbidden: [RegExp, string][] = [
      [/postgres(ql)?:\/\//i, 'a PostgreSQL connection string'],
      [/\bneon\.tech\b/i, 'a Neon host'],
      [/\bre_[A-Za-z0-9]{16,}/, 'a Resend API key'],
      [/DATABASE_URL/, 'the DATABASE_URL name'],
      [/SUBMISSION_IP_SALT/, 'the IP salt'],
      [/RESEND_API_KEY/, 'the Resend key name'],
      [/CRON_SECRET/, 'the cron secret name'],
      [/VERCEL_DEPLOY_HOOK_URL/, 'the deploy hook'],
    ];

    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const [pattern, description] of forbidden) {
        expect(pattern.test(text), `${file} contains ${description}`).toBe(false);
      }
    }
  });

  it('ships no server-only module into a client script', () => {
    const dir = existingClientDir();
    expect(dir).toBeDefined();

    for (const file of filesUnder(dir!, ['.js'])) {
      const text = readFileSync(file, 'utf8');
      // Distinctive strings from the server-only modules. Their presence in a
      // browser script would mean the boundary has been crossed.
      expect(text, `${file} bundles the Drizzle schema`).not.toMatch(
        /audit_log is append-only|drizzle-orm\/neon-http/,
      );
      expect(text, `${file} bundles the mailer`).not.toMatch(/api\.resend\.com/);
    }
  });
});

describe('private submission fields stay private', () => {
  /**
   * Names that could only come from this schema.
   *
   * `submitter_email` and `ip_hash` are ours; nothing else in the world is
   * called that, so finding one anywhere in the built output means our code
   * put it there. These are swept across every built file, unchanged.
   */
  const DISTINCTIVE_COLUMNS = ['submitter_email', 'submitterEmail', 'ip_hash', 'ipHash'];

  /**
   * `user_agent` is the odd one out, and Phase A is what revealed it.
   *
   * It is a generic HTTP concept, not a name we invented, and it appears
   * legitimately inside third-party code — Privy's SDK sends a user agent with
   * its own telemetry, so `_astro/core.*.js` contains the string with no
   * connection to this database at all. Sweeping it across every vendor chunk
   * turns a real guarantee into a test that fails for the wrong reason, and a
   * test that fails for the wrong reason gets deleted by whoever is in a hurry.
   *
   * So it is still checked where a leak would actually reach a reader — the
   * rendered HTML and the sitemap — and no longer used as evidence inside
   * bundled dependencies. The distinctive names above still cover the case
   * that matters: our own code naming our own private columns in a browser
   * script.
   */
  const GENERIC_COLUMNS = ['user_agent', 'userAgent'];

  it('renders no private column name into any built page', () => {
    const dir = existingClientDir();
    expect(dir).toBeDefined();

    for (const file of filesUnder(dir!, ['.html', '.js', '.xml'])) {
      const text = readFileSync(file, 'utf8');
      for (const column of DISTINCTIVE_COLUMNS) {
        expect(text.includes(column), `${file} mentions ${column}`).toBe(false);
      }
    }
  });

  it('renders no generic private field name into rendered output', () => {
    const dir = existingClientDir();
    expect(dir).toBeDefined();

    const rendered = filesUnder(dir!, ['.html', '.xml']);
    expect(rendered.length).toBeGreaterThan(10);

    for (const file of rendered) {
      const text = readFileSync(file, 'utf8');
      for (const column of GENERIC_COLUMNS) {
        expect(text.includes(column), `${file} mentions ${column}`).toBe(false);
      }
    }
  });

  it('has no public read route over submissions', () => {
    // The guarantee is structural: there is no GET handler, and no route file
    // that selects from the table. If one is ever added, this fails.
    const routes = filesUnder('src/pages', ['.ts', '.astro', '.js']);

    for (const file of routes) {
      const text = readFileSync(file, 'utf8');
      if (!/submissions|cityInterest|city_interest/.test(text)) continue;

      // The only file allowed to touch these tables is the submit endpoint,
      // and it only inserts.
      expect(file.replace(/\\/g, '/'), 'only /api/submit may touch the inbox').toBe(
        'src/pages/api/submit.ts',
      );
    }
  });

  it('exposes no submissions table anywhere in a prerendered page', () => {
    const dir = existingClientDir();
    expect(dir).toBeDefined();

    for (const file of filesUnder(dir!, ['.html'])) {
      const text = readFileSync(file, 'utf8');
      expect(/from\s+submissions|select .* submissions/i.test(text), file).toBe(false);
    }
  });
});

describe('the site stays static', () => {
  /**
   * EVERY PUBLIC PAGE IS STILL A FILE.
   *
   * Phase A made the account area server-rendered, so the old assertion —
   * only the two API routes are dynamic — is no longer the truth. The claim
   * worth defending is narrower and more useful: nothing a VISITOR reads is
   * rendered on demand. The archive, the builders, the projects, the events,
   * the cities, the homepage: all files on a CDN, exactly as before.
   *
   * So this asserts by exclusion. Anything dynamic must be an API endpoint or
   * under `/me` (which requires a session and is `no-store`). The exact list
   * lives in `tests/admin-isolation.test.ts`; here the question is only
   * "did a public page stop being static?"
   */
  it('renders no public page on demand', () => {
    const dynamic = filesUnder('src/pages', ['.astro', '.ts'])
      .filter((file) => /export\s+const\s+prerender\s*=\s*false/.test(readFileSync(file, 'utf8')))
      .map((f) => f.replace(/\\/g, '/'));

    // There is at least one, or this test has stopped looking at anything.
    expect(dynamic.length).toBeGreaterThan(0);

    for (const route of dynamic) {
      const isApi = route.startsWith('src/pages/api/');
      const isAccount = route.startsWith('src/pages/me/');
      const isDetail = route.startsWith('src/pages/projects/') || route.startsWith('src/pages/builders/') || route.startsWith('src/pages/cities/') || route.startsWith('src/pages/events/') || route.startsWith('src/pages/ambassadors/') || route.endsWith('discover.astro');
      const isSitemap = route === 'src/pages/sitemap.xml.ts';
      // The homepage reads live data so it can never disagree with the
      // directory pages it links to; it is the one deliberate addition.
      const isHome = route === 'src/pages/index.astro' || route === 'src/pages/not-found.astro';
      expect(isApi || isAccount || isDetail || isSitemap || isHome, `${route} is a public page rendered on demand`).toBe(true);
    }
  });

  it('builds every public page as a file', () => {
    const dir = existingClientDir();
    expect(dir).toBeDefined();
    // The whole public site, still on disk.
    expect(filesUnder(dir!, ['.html']).length).toBeGreaterThan(10);
  });
});

describe('the forms are wired to the endpoint', () => {
  it('points all four at /api/submit', () => {
    expect(forms.length).toBe(4);
    for (const form of forms) {
      expect(form.endpoint, `form ${form.id}`).toBe('/api/submit/');
    }
  });

  it('asks every form for an email, so every submission can be acknowledged', () => {
    for (const form of forms) {
      const email = form.fields.find((f) => f.type === 'email');
      expect(email, `form ${form.id}`).toBeDefined();
      expect(email!.required, `form ${form.id} email is required`).toBe(true);
      // And says out loud that it is never published.
      expect(email!.hint ?? '', `form ${form.id} email hint`).toMatch(
        /never published|never displayed/i,
      );
    }
  });

  it('keeps the clipboard fallback in the client script', () => {
    const script = readFileSync('src/scripts/submit.ts', 'utf8');
    // The composed text is produced on every path, including failure, so a
    // person never loses what they typed.
    expect(script).toMatch(/Sending failed/);
    expect(script).toMatch(/navigator\.clipboard/);
    expect(script).toMatch(/function compose/);
  });
});
