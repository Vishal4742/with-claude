import { describe, expect, it, vi } from 'vitest';
import { onRequest } from '../src/middleware';

vi.mock('astro:middleware', () => ({ defineMiddleware: (handler: unknown) => handler }));

function context(headers: Record<string, string> = {}) {
  const url = new URL('https://www.withclaude.in/');
  return { url, request: new Request(url, { headers }), rewrite: vi.fn(), redirect: vi.fn() };
}

describe('the public middleware', () => {
  it('refuses the Vercel adapter path-override header', async () => {
    const next = vi.fn();
    const response = (await onRequest(
      context({ 'x-astro-path': '/not-found/' }) as never,
      next,
    )) as Response;
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(next).not.toHaveBeenCalled();
  });

  it('passes an ordinary request through', async () => {
    const ok = new Response('ok');
    const next = vi.fn(async () => ok);
    expect(await onRequest(context() as never, next)).toBe(ok);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('the admin middleware', () => {
  it('refuses the Vercel adapter path-override header before resolving a session', async () => {
    vi.doMock('../admin/src/server/session', () => ({
      resolveSession: vi.fn(() => {
        throw new Error('must not be reached');
      }),
    }));
    const { onRequest: adminOnRequest } = await import('../admin/src/middleware');
    const next = vi.fn();
    const url = new URL('https://admin.withclaude.in/login');
    const response = (await adminOnRequest(
      { url, request: new Request(url, { headers: { 'x-astro-path': '/submissions' } }) } as never,
      next,
    )) as Response;
    expect(response.status).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('the build-time adapter patch', () => {
  it('removes both forms of the path override from the installed adapter entrypoint', async () => {
    const { readFileSync } = await import('node:fs');
    const { createRequire } = await import('node:module');
    const { vercelPathGuard } = await import('../scripts/vercel-path-guard.mjs');
    const id = createRequire(import.meta.url)
      .resolve('@astrojs/vercel/entrypoint')
      .replace(/\\/g, '/');
    const plugin = vercelPathGuard();
    const out = (plugin.transform as (code: string, id: string) => { code: string } | null)(
      readFileSync(id, 'utf8'),
      id,
    );
    expect(out).not.toBeNull();
    expect(out!.code).toContain('const realPath = undefined;');
    expect(out!.code).not.toMatch(/searchParams\.get\(ASTRO_PATH_PARAM\)/);
  });

  it('fails the build when the adapter line it patches has changed', async () => {
    const { vercelPathGuard } = await import('../scripts/vercel-path-guard.mjs');
    const transform = vercelPathGuard().transform as (code: string, id: string) => unknown;
    expect(() =>
      transform('export {}', '/x/node_modules/@astrojs/vercel/dist/serverless/entrypoint.js'),
    ).toThrow(/entrypoint changed/);
    expect(transform('export {}', '/x/src/other.ts')).toBeNull();
  });
});
