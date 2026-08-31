#!/usr/bin/env node
'use strict';

// DROVE-104. @slopus/happy-wire publishes only its BUILT dist, and that dist is
// rebuilt only by the root postinstall. Every consumer resolves the package to
// that dist: pkgroll bundles it into the CLI, metro bundles it into the app, so
// `expo export` and `eas update` ship whatever dist happens to be on disk.
//
// On 2026-08-28..31 that went wrong exactly the way it can. The wire's source
// changed at 02:51 while its dist was from three days earlier, so createEnvelope
// zod-parsed every envelope through the old schema and SILENTLY STRIPPED the
// fields added since. Nothing failed. The CLI shipped a dead feature for days
// and DROVE-95 read as shipped when it was not (DROVE-103).
//
// This refuses to build against a dist older than the source instead of quietly
// bundling it. Two failures it reports:
//
//   stale-dist      the dist that will be bundled is older than the source it
//                   was built from
//   source-mismatch the wire resolves OUTSIDE this tree (a git worktree
//                   symlinks node_modules at the main checkout) and that tree's
//                   wire source differs from this one, so the build reads a
//                   dist built from somebody else's source
//
// Escape hatch, matching scripts/postinstall.cjs: SKIP_WIRE_DIST_CHECK=1.

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const packageName = '@slopus/happy-wire';
const buildCommand = 'pnpm --filter @slopus/happy-wire build';

// Extensions that end up in the build. A .test.ts change cannot change dist, so
// it must not force a rebuild, or the guard becomes noise people learn to skip.
const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'];

function isSourceFile(file) {
  if (file.endsWith('.test.ts') || file.endsWith('.spec.ts')) return false;
  return sourceExtensions.includes(path.extname(file));
}

function listFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const found = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listFiles(full));
    } else if (entry.isFile()) {
      found.push(full);
    }
  }
  return found;
}

// The build inputs: everything under src/ that can change the output, plus the
// two files that decide HOW it is built.
function sourceFilesOf(wireDir) {
  const files = listFiles(path.join(wireDir, 'src')).filter(isSourceFile);
  for (const name of ['package.json', 'tsconfig.json']) {
    const full = path.join(wireDir, name);
    if (fs.existsSync(full)) files.push(full);
  }
  return files;
}

function newest(files) {
  let winner = null;
  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!winner || stat.mtimeMs > winner.mtimeMs) {
      winner = { file, mtimeMs: stat.mtimeMs };
    }
  }
  return winner;
}

function stamp(mtimeMs) {
  return new Date(mtimeMs).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function ago(olderMs, newerMs) {
  const seconds = Math.round((newerMs - olderMs) / 1000);
  if (seconds < 90) return seconds + 's';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return minutes + 'm';
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours + 'h';
  return Math.round(hours / 24) + 'd';
}

// Walk up from a resolved file to the directory whose package.json IS the wire.
function packageRootOf(file) {
  let dir = path.dirname(file);
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        if (JSON.parse(fs.readFileSync(manifest, 'utf8')).name === packageName) return dir;
      } catch {
        // an unreadable package.json is not the one we want
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The dist a bundler in `fromDir` would actually read. realpath matters: in a
// git worktree node_modules is a symlink to the main checkout, so this lands on
// the MAIN checkout's wire however the worktree's own source reads.
function resolveBundledWireDir(fromDir) {
  let entry;
  try {
    // createRequire from the CONSUMER, not require.resolve({paths}). This file
    // lives inside the wire package, and Node's self-reference rule (a package
    // with an "exports" field can require its own name) wins over `paths`, so
    // require.resolve here would always answer "my own dist" and miss the
    // symlinked one that actually gets bundled.
    entry = createRequire(path.join(fromDir, '__wire_dist_check__.cjs')).resolve(packageName);
  } catch {
    return null;
  }
  try {
    entry = fs.realpathSync(entry);
  } catch {
    // keep the unresolved path
  }
  return packageRootOf(entry);
}

function readIfFile(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

// Content, not mtime. `git worktree add` stamps every file with the checkout
// time, so an mtime comparison across trees is always a false positive.
function differingSourceFiles(localWireDir, bundledWireDir) {
  const relative = (wireDir, file) => path.relative(wireDir, file);
  const localSrc = path.join(localWireDir, 'src');
  const bundledSrc = path.join(bundledWireDir, 'src');
  const names = new Set([
    ...listFiles(localSrc).filter(isSourceFile).map((f) => relative(localSrc, f)),
    ...listFiles(bundledSrc).filter(isSourceFile).map((f) => relative(bundledSrc, f)),
  ]);
  const differing = [];
  for (const name of [...names].sort()) {
    const mine = readIfFile(path.join(localSrc, name));
    const theirs = readIfFile(path.join(bundledSrc, name));
    if (mine === null || theirs === null || !mine.equals(theirs)) differing.push(name);
  }
  return differing;
}

/**
 * @param {{localWireDir?: string, fromDir?: string, bundledWireDir?: string}} options
 * @returns {{ok: boolean, code: string, message: string, bundledWireDir: string|null,
 *            localWireDir: string, dist: object|null, source: object|null}}
 */
function checkWireDistFreshness(options) {
  const opts = options || {};
  const localWireDir = opts.localWireDir || path.resolve(__dirname, '..');
  const fromDir = opts.fromDir || process.cwd();
  const bundledWireDir = opts.bundledWireDir || resolveBundledWireDir(fromDir) || localWireDir;

  const result = { ok: true, code: 'ok', message: '', bundledWireDir, localWireDir, dist: null, source: null };

  const distDir = path.join(bundledWireDir, 'dist');
  const dist = newest(listFiles(distDir));
  const source = newest(sourceFilesOf(bundledWireDir));
  result.dist = dist;
  result.source = source;

  const where =
    path.resolve(bundledWireDir) === path.resolve(localWireDir)
      ? ''
      : `\n  NOTE  ${packageName} resolves OUTSIDE this tree.\n        this tree ${localWireDir}\n        bundled   ${bundledWireDir}\n        A git worktree symlinks node_modules at the main checkout, so a build\n        here reads the MAIN checkout's wire dist.\n`;

  if (!dist) {
    result.ok = false;
    result.code = 'missing-dist';
    result.message =
      `${packageName} has NO built dist, and it publishes only its dist.\n\n` +
      `  dist    ${distDir} (missing)\n` +
      `  source  ${source ? source.file : path.join(bundledWireDir, 'src')}` +
      `${source ? '  ' + stamp(source.mtimeMs) : ''}\n` +
      `${where}\n` +
      `Bundling now would fail to resolve the wire, or resolve an empty one.\n\n` +
      `Fix:\n  ${buildCommand}\n`;
    return result;
  }

  if (source && source.mtimeMs > dist.mtimeMs) {
    result.ok = false;
    result.code = 'stale-dist';
    result.message =
      `${packageName} dist is STALE. Refusing to bundle it.\n\n` +
      `  dist    ${stamp(dist.mtimeMs)}  ${dist.file}\n` +
      `  source  ${stamp(source.mtimeMs)}  ${source.file}\n` +
      `  source is ${ago(dist.mtimeMs, source.mtimeMs)} NEWER than the build.\n` +
      `${where}\n` +
      `The wire ships only its built dist, so metro and pkgroll bundle that dist,\n` +
      `never the source. zod strips unknown keys, so a stale schema drops every\n` +
      `field added since the build and NOTHING errors. That is DROVE-103: the CLI\n` +
      `shipped a dead feature for three days that way.\n\n` +
      `Fix:\n  ${buildCommand}\n\n` +
      `Override (you had better be sure):\n  SKIP_WIRE_DIST_CHECK=1\n`;
    return result;
  }

  if (path.resolve(bundledWireDir) !== path.resolve(localWireDir)) {
    const differing = differingSourceFiles(localWireDir, bundledWireDir);
    if (differing.length > 0) {
      result.ok = false;
      result.code = 'source-mismatch';
      result.message =
        `${packageName} resolves OUTSIDE this tree and its source DIFFERS from yours.\n\n` +
        `  this tree ${localWireDir}\n` +
        `  bundled   ${bundledWireDir}\n` +
        `  dist      ${stamp(dist.mtimeMs)}  ${dist.file}\n` +
        `  differing: ${differing.join(', ')}\n\n` +
        `node_modules here is a symlink to the main checkout, so the bundler reads\n` +
        `the MAIN checkout's wire dist however this tree's source reads. Building\n` +
        `the wire from here writes a dist nothing will bundle.\n\n` +
        `Fix, one of:\n` +
        `  - land the wire change in the main checkout and run there:\n      ${buildCommand}\n` +
        `  - give this tree its own node_modules (pnpm install here)\n\n` +
        `Override (you had better be sure):\n  SKIP_WIRE_DIST_CHECK=1\n`;
      return result;
    }
  }

  result.message =
    `${packageName} dist is current.\n` +
    `  dist    ${stamp(dist.mtimeMs)}  ${dist.file}\n` +
    `  source  ${source ? stamp(source.mtimeMs) + '  ' + source.file : '(no source files found)'}\n` +
    `${where}`;
  return result;
}

/** Throws on a stale or mismatched dist. Called from metro.config.js. */
function assertWireDistFresh(options) {
  if (process.env.SKIP_WIRE_DIST_CHECK === '1') return null;
  const result = checkWireDistFreshness(options);
  if (!result.ok) {
    throw new Error('\n\n' + result.message + '\n');
  }
  return result;
}

module.exports = { checkWireDistFreshness, assertWireDistFresh };

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--wire-dir') {
      // Point both sides at one tree. Used by the proof script so it can make a
      // dist stale without touching the shared main checkout.
      const dir = path.resolve(args[++i]);
      options.localWireDir = dir;
      options.bundledWireDir = dir;
    } else if (args[i] === '--from') {
      options.fromDir = path.resolve(args[++i]);
    }
  }
  if (process.env.SKIP_WIRE_DIST_CHECK === '1') {
    console.log(`[wire-dist-check] SKIP_WIRE_DIST_CHECK=1, skipping`);
    process.exit(0);
  }
  const result = checkWireDistFreshness(options);
  if (result.ok) {
    console.log('[wire-dist-check] ' + result.message.trim());
    process.exit(0);
  }
  console.error('\n[wire-dist-check] ' + result.message);
  process.exit(1);
}
