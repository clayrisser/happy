import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { checkWireDistFreshness } = require('./check-dist-fresh.cjs');

// DROVE-104. Everything here runs against throwaway fixture trees. Touching the
// real packages/happy-wire would move the mtime every other worktree resolves
// through, so the fixtures are the point, not a shortcut.

let root: string;

function wireTree(name: string, options: { dist?: boolean; source?: string } = {}) {
  const dir = join(root, name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@slopus/happy-wire' }));
  writeFileSync(join(dir, 'src', 'sessionProtocol.ts'), options.source ?? 'export const t = 1;\n');
  if (options.dist !== false) {
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'index.cjs'), 'module.exports = {};\n');
  }
  return dir;
}

function setMtime(file: string, isoDate: string) {
  const when = new Date(isoDate);
  utimesSync(file, when, when);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wire-dist-check-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('checkWireDistFreshness', () => {
  it('passes when the dist is newer than the source', () => {
    const dir = wireTree('fresh');
    setMtime(join(dir, 'src', 'sessionProtocol.ts'), '2026-08-31T02:51:00Z');
    setMtime(join(dir, 'package.json'), '2026-08-31T02:51:00Z');
    setMtime(join(dir, 'dist', 'index.cjs'), '2026-08-31T04:54:00Z');

    const result = checkWireDistFreshness({ localWireDir: dir, bundledWireDir: dir });

    expect(result.ok).toBe(true);
    expect(result.code).toBe('ok');
  });

  it('fails when a source file is newer than the dist, naming both timestamps and the fix', () => {
    const dir = wireTree('stale');
    // The real DROVE-103 numbers: dist built Aug 28, source changed Aug 31.
    setMtime(join(dir, 'package.json'), '2026-08-28T03:56:00Z');
    setMtime(join(dir, 'dist', 'index.cjs'), '2026-08-28T04:00:00Z');
    setMtime(join(dir, 'src', 'sessionProtocol.ts'), '2026-08-31T02:51:00Z');

    const result = checkWireDistFreshness({ localWireDir: dir, bundledWireDir: dir });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('stale-dist');
    expect(result.message).toContain('2026-08-28 04:00:00 UTC');
    expect(result.message).toContain('2026-08-31 02:51:00 UTC');
    expect(result.message).toContain('pnpm --filter @slopus/happy-wire build');
  });

  it('ignores test files, which cannot change the build output', () => {
    const dir = wireTree('tests-only');
    setMtime(join(dir, 'src', 'sessionProtocol.ts'), '2026-08-28T03:00:00Z');
    setMtime(join(dir, 'package.json'), '2026-08-28T03:00:00Z');
    setMtime(join(dir, 'dist', 'index.cjs'), '2026-08-28T04:00:00Z');
    writeFileSync(join(dir, 'src', 'sessionProtocol.test.ts'), 'export {};\n');
    setMtime(join(dir, 'src', 'sessionProtocol.test.ts'), '2026-08-31T02:51:00Z');

    const result = checkWireDistFreshness({ localWireDir: dir, bundledWireDir: dir });

    expect(result.ok).toBe(true);
  });

  it('fails when the dist is missing entirely', () => {
    const dir = wireTree('no-dist', { dist: false });

    const result = checkWireDistFreshness({ localWireDir: dir, bundledWireDir: dir });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('missing-dist');
    expect(result.message).toContain('pnpm --filter @slopus/happy-wire build');
  });

  it('fails when the bundled wire is another tree whose source differs', () => {
    // The worktree trap: node_modules is symlinked at the main checkout, so the
    // lane's own wire source is never what gets bundled.
    const bundled = wireTree('main-checkout', { source: 'export const t = 1;\n' });
    const local = wireTree('worktree', { source: 'export const t = 2;\n' });
    setMtime(join(bundled, 'src', 'sessionProtocol.ts'), '2026-08-28T03:00:00Z');
    setMtime(join(bundled, 'package.json'), '2026-08-28T03:00:00Z');
    setMtime(join(bundled, 'dist', 'index.cjs'), '2026-08-28T04:00:00Z');

    const result = checkWireDistFreshness({ localWireDir: local, bundledWireDir: bundled });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('source-mismatch');
    expect(result.message).toContain('sessionProtocol.ts');
  });

  it('passes when the bundled wire is another tree with identical source', () => {
    const bundled = wireTree('main-same');
    const local = wireTree('worktree-same');
    setMtime(join(bundled, 'src', 'sessionProtocol.ts'), '2026-08-28T03:00:00Z');
    setMtime(join(bundled, 'package.json'), '2026-08-28T03:00:00Z');
    setMtime(join(bundled, 'dist', 'index.cjs'), '2026-08-28T04:00:00Z');

    const result = checkWireDistFreshness({ localWireDir: local, bundledWireDir: bundled });

    expect(result.ok).toBe(true);
    expect(result.message).toContain('resolves OUTSIDE this tree');
  });
});
