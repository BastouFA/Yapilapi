// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import nextConfig from '../next.config.mjs';
import { middleware } from './middleware';

const SRC = __dirname;
const files: string[] = [];
(function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|css)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) files.push(p);
  }
})(SRC);
const source = (f: string) => readFileSync(f, 'utf8');
const rel = (f: string) => path.relative(SRC, f);
const code = files.filter((f) => /\.(ts|tsx)$/.test(f));

afterEach(() => vi.unstubAllEnvs());

describe('content security policy (middleware)', () => {
  const run = (url = 'http://localhost:3100/users?q=ada') => middleware(new NextRequest(url));

  it('uses a per-request nonce and no unsafe-inline / unsafe-eval in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const a = run().headers.get('content-security-policy')!;
    const b = run().headers.get('content-security-policy')!;
    expect(a).toMatch(/script-src 'self' 'nonce-[\w=+/-]+' 'strict-dynamic'/);
    expect(a).not.toContain('unsafe-inline');
    expect(a).not.toContain('unsafe-eval');
    expect(a.match(/nonce-[\w=+/-]+/)![0]).not.toBe(b.match(/nonce-[\w=+/-]+/)![0]);
  });

  it('cannot be framed, embedded, or made to submit forms elsewhere', () => {
    const csp = run().headers.get('content-security-policy')!;
    for (const d of [
      `default-src 'self'`,
      `frame-ancestors 'none'`,
      `object-src 'none'`,
      `base-uri 'self'`,
      `form-action 'self'`,
      `style-src 'self'`,
    ])
      expect(csp).toContain(d);
  });

  it('only lets the browser talk to this origin and the API origin', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/');
    expect(run().headers.get('content-security-policy')).toContain(
      `connect-src 'self' https://api.example.com`,
    );
  });

  it('passes the request path to server components for the sign-in redirect, and cannot be spoofed by the client', () => {
    const req = new NextRequest('http://localhost:3100/users?q=ada', {
      headers: { 'x-yl-path': '/evil' },
    });
    const res = middleware(req);
    expect(res.headers.get('x-middleware-request-x-yl-path')).toBe('/users?q=ada');
  });
});

describe('static security headers (next.config)', () => {
  it('sets hardening headers on every route and hides the framework', async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    const [rule] = await nextConfig.headers!();
    expect(rule!.source).toBe('/:path*');
    const h = Object.fromEntries(rule!.headers.map((x) => [x.key, x.value]));
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['Referrer-Policy']).toBe('no-referrer');
    expect(h['Strict-Transport-Security']).toMatch(/max-age=\d{7,}/);
    expect(h['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(h['Cross-Origin-Resource-Policy']).toBe('same-origin');
    expect(h['Cache-Control']).toBe('no-store');
    expect(h['X-Robots-Tag']).toContain('noindex');
    expect(h['Permissions-Policy']).toContain('camera=()');
  });

  it('runs on its own port, distinct from the web app', () => {
    const pkg = JSON.parse(readFileSync(path.resolve(SRC, '../package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const web = JSON.parse(readFileSync(path.resolve(SRC, '../../web/package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['dev']).toContain('-p 3100');
    // `start` uses `-p ${PORT:-3100}` so hosts like Render can inject their own PORT at runtime,
    // while still defaulting to 3100 (distinct from the web app) when nothing overrides it.
    expect(pkg.scripts['start']).toContain('3100');
    expect(pkg.scripts['start']).toMatch(/-p\s/);
    expect(web.scripts['dev']).not.toContain('3100');
  });
});

describe('source hygiene', () => {
  it('reads only one public env var in client code, and no secrets', () => {
    const uses = code.flatMap((f) =>
      [...source(f).matchAll(/NEXT_PUBLIC_[A-Z_]+/g)].map((m) => `${rel(f)}:${m[0]}`),
    );
    expect(uses.filter((u) => !u.endsWith('NEXT_PUBLIC_API_URL'))).toEqual([]);
    for (const f of code)
      expect(source(f), rel(f)).not.toMatch(
        /(secret|password|token)\s*[:=]\s*['"][A-Za-z0-9+/]{16,}['"]/i,
      );
  });

  it('never logs (no console output of requests, users or tokens), except the error boundary', () => {
    const offenders = code
      .filter((f) => /\bconsole\.(log|info|debug|warn|error)\b/.test(source(f)))
      .map(rel);
    expect(offenders.filter((f) => f !== path.join('app', 'error.tsx'))).toEqual([]);
    const boundary = source(path.join(SRC, 'app/error.tsx'));
    expect(boundary).toMatch(/console\.error\([^)]*digest/); // only the opaque digest, never the error's message or stack
    expect(boundary).not.toMatch(/console\.error\(error\)/);
  });

  it('never stores credentials or session state in the browser (the session is an httpOnly cookie)', () => {
    for (const f of code) {
      const s = source(f);
      expect(s, rel(f)).not.toMatch(/\b(localStorage|sessionStorage|indexedDB)\b/);
      expect(s, rel(f)).not.toMatch(/dangerouslySetInnerHTML|\beval\(|new Function\(/);
    }
    // The only client-written cookies are display preferences.
    const writers = code
      .filter((f) => /document\.cookie\s*=/.test(source(f)))
      .map(rel)
      .sort();
    expect(writers).toEqual([
      path.join('components', 'LocaleSwitch.tsx'),
      path.join('components', 'ThemeSwitch.tsx'),
    ]);
  });

  it('keeps server-only modules off the client', () => {
    expect(source(path.join(SRC, 'lib/server-session.ts'))).toContain("import 'server-only'");
    const clientImporters = code.filter(
      (f) => source(f).startsWith("'use client'") && /server-session/.test(source(f)),
    );
    expect(clientImporters.map(rel)).toEqual([]);
  });

  it('never forwards the session cookie anywhere except the configured API origin', () => {
    const src = source(path.join(SRC, 'lib/server-session.ts'));
    expect(src).toContain('getServerApiUrl()');
    expect(src).not.toMatch(/https?:\/\//);
  });

  it('uses no inline styles or physical left/right CSS (strict CSP, right-to-left support)', () => {
    const inline = code.filter((f) => f.endsWith('.tsx') && /\sstyle=\{/.test(source(f))).map(rel);
    expect(inline).toEqual([]);
    const css = source(path.join(SRC, 'app/admin.css'));
    expect(css).not.toMatch(/(margin|padding|border)-(left|right)\s*:/);
    expect(css).not.toMatch(/(^|[\s;{])(left|right)\s*:/);
  });

  it('has no hard-coded user-facing text in components (everything goes through the catalog)', () => {
    const offenders: string[] = [];
    for (const f of code.filter(
      (x) => x.endsWith('.tsx') && !x.includes(`${path.sep}app${path.sep}layout`),
    )) {
      const s = source(f);
      for (const m of s.matchAll(
        /\s(aria-label|placeholder|title|alt|label|description|submitLabel|reasonLabel)="([^"{]*[A-Za-z]{3,}[^"]*)"/g,
      ))
        offenders.push(`${rel(f)}: ${m[1]}="${m[2]}"`);
      // JSX text between tags that looks like a sentence or word (letters, not just punctuation/entities)
      for (const m of s.matchAll(/(?<![=:>])>\s*([A-Z][a-z]+(?:\s+[A-Za-z][a-z]*)*)\s*</g))
        offenders.push(`${rel(f)}: text >${m[1]}<`);
    }
    expect(offenders).toEqual([]);
  });
});
