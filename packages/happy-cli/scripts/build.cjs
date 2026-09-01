#!/usr/bin/env node
/**
 * Build the CLI beside the running one, and swap only on success (DROVE-65).
 *
 * The script this replaces was
 *
 *     shx rm -rf dist && tsc --noEmit && pkgroll
 *
 * The delete ran FIRST. So any failing step, including a type error in a
 * *.test.ts that tsc --noEmit checks and pkgroll never bundles, left no dist
 * at all, and the launchd daemon and bridge that load dist/index.mjs
 * restarted into nothing. Measured live 2026-08-31 01:35: four minutes of
 * dead phone bridge from one test-local type alias.
 *
 * Now:
 *
 *   1. typecheck the SOURCES with tsconfig.build.json, which excludes tests.
 *      The full check over tests is `pnpm typecheck`, run by `pnpm test` and
 *      CI, where a broken test should fail and nothing is running on it.
 *   2. pkgroll into dist.next/dist. pkgroll writes wherever package.json's
 *      exports point, so it runs from a staging dir holding a copy of
 *      package.json, with the real src and tsconfig passed by path.
 *   3. verify the candidate: `node --check` every chunk, and every relative
 *      import in every chunk must resolve. That is exactly what node does at
 *      load, so a pass here means no ERR_MODULE_NOT_FOUND.
 *   4. swap: dist -> dist.prev, dist.next/dist -> dist, rm dist.prev.
 *
 * A failure anywhere before step 4 leaves dist exactly as it was. The one
 * window with no dist is the two renames in step 4, which is milliseconds.
 *
 * .build/last records the outcome (key=value, one per line) and
 * .build/build.log holds the captured output, so `drover status` can say
 * when the last build ran and why it failed even for a build run by hand.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// The package this script builds is the one it lives in. scripts/build.test.ts
// points it at a throwaway package instead, so the failure paths are proven
// without breaking this one.
const pkgDir = path.resolve(process.env.HAPPY_BUILD_PKG_DIR || path.join(__dirname, '..'))
const distDir = path.join(pkgDir, 'dist')
const prevDir = path.join(pkgDir, 'dist.prev')
const stageDir = path.join(pkgDir, 'dist.next')
const candidate = path.join(stageDir, 'dist')
const buildState = path.join(pkgDir, '.build')
const lockDir = path.join(buildState, 'lock')
const lastFile = path.join(buildState, 'last')
const logFile = path.join(buildState, 'build.log')

const startedAt = Date.now()
const logLines = []

function say(line) {
  process.stderr.write(`build: ${line}\n`)
  logLines.push(`build: ${line}`)
}

function capture(text) {
  if (!text) return
  process.stderr.write(text)
  logLines.push(text.replace(/\n$/, ''))
}

function shortSha() {
  const r = spawnSync('git', ['-C', pkgDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : 'unknown'
}

function distMtime() {
  try {
    return fs.statSync(path.join(distDir, 'index.mjs')).mtime.toISOString()
  } catch {
    return 'none'
  }
}

function record(status, step, rc, reason) {
  fs.mkdirSync(buildState, { recursive: true })
  const lines = [
    `status=${status}`,
    `at=${Math.floor(Date.now() / 1000)}`,
    `step=${step}`,
    `rc=${rc}`,
    `reason=${reason.replace(/\s+/g, ' ').trim()}`,
    `ms=${Date.now() - startedAt}`,
    `sha=${shortSha()}`,
  ]
  fs.writeFileSync(lastFile, lines.join('\n') + '\n')
  fs.writeFileSync(logFile, logLines.join('\n') + '\n')
}

function fail(step, rc, reason) {
  say(`FAILED at ${step}: ${reason}`)
  say(`dist untouched (dist/index.mjs ${distMtime()})`)
  record('failed', step, rc, reason)
  releaseLock()
  process.exit(rc || 1)
}

// --- one build at a time ----------------------------------------------------
//
// Two builds racing on one staging dir would each rm the other's candidate.
// mkdir is the atomic primitive; the pid inside is how a lock left by a killed
// build is told apart from a live one.

let holdingLock = false

function lockPid() {
  try {
    return parseInt(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'), 10)
  } catch {
    return NaN
  }
}

function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

function lockAge() {
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs
  } catch {
    return 0
  }
}

function takeLock() {
  fs.mkdirSync(buildState, { recursive: true })
  const deadline = Date.now() + 300_000
  let said = false
  for (;;) {
    try {
      fs.mkdirSync(lockDir)
      fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid))
      holdingLock = true
      return
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
    const pid = lockPid()
    // A pid that is gone, or no pid at all after a minute, is a lock nobody
    // will ever release. Clear it and go again.
    if ((pid && !pidAlive(pid)) || (!pid && lockAge() > 60_000)) {
      say(`clearing a stale build lock (pid ${pid || '?'} is gone)`)
      fs.rmSync(lockDir, { recursive: true, force: true })
      continue
    }
    if (!said) {
      say(`another build is running (pid ${pid || '?'}), waiting`)
      said = true
    }
    if (Date.now() > deadline) {
      say('gave up waiting for the other build')
      process.exit(1)
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
  }
}

function releaseLock() {
  if (!holdingLock) return
  holdingLock = false
  fs.rmSync(lockDir, { recursive: true, force: true })
}

process.on('exit', releaseLock)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    releaseLock()
    process.exit(1)
  })
}

// --- steps ------------------------------------------------------------------

function run(step, cmd, args, opts) {
  const t = Date.now()
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  capture(r.stdout)
  capture(r.stderr)
  if (r.error) fail(step, 1, `${cmd}: ${r.error.message}`)
  return { rc: r.status === null ? 1 : r.status, out: (r.stdout || '') + (r.stderr || ''), ms: Date.now() - t }
}

function typecheck() {
  say('typecheck sources (tsconfig.build.json, tests excluded)')
  const tsc = require.resolve('typescript/bin/tsc')
  const r = run('typecheck', process.execPath, [tsc, '--noEmit', '-p', path.join(pkgDir, 'tsconfig.build.json')], { cwd: pkgDir })
  if (r.rc !== 0) {
    const errors = [...r.out.matchAll(/^([^\s(]+)\(\d+,\d+\): error /gm)]
    const files = [...new Set(errors.map((x) => x[1]))]
    fail('typecheck', r.rc, `${errors.length} type error(s) in ${files.slice(0, 5).join(', ') || 'the sources'}`)
  }
  say(`typecheck ok (${r.ms}ms)`)
}

function bundle() {
  fs.rmSync(stageDir, { recursive: true, force: true })
  fs.mkdirSync(stageDir, { recursive: true })
  fs.copyFileSync(path.join(pkgDir, 'package.json'), path.join(stageDir, 'package.json'))
  say(`bundle into ${path.relative(pkgDir, candidate)}`)
  const pkgrollPkg = require.resolve('pkgroll/package.json')
  const pkgroll = path.join(path.dirname(pkgrollPkg), require(pkgrollPkg).bin)
  const r = run(
    'bundle',
    process.execPath,
    [pkgroll, '--srcdist', `${path.relative(stageDir, path.join(pkgDir, 'src'))}:dist`, '-p', path.join(pkgDir, 'tsconfig.json')],
    { cwd: stageDir },
  )
  if (r.rc !== 0) fail('bundle', r.rc, 'pkgroll failed')
  say(`bundle ok (${r.ms}ms)`)
}

function chunks(dir) {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...chunks(p))
    else if (/\.[cm]?js$/.test(ent.name)) out.push(p)
  }
  return out
}

// Every relative specifier node will resolve at load time, in every chunk,
// not only the entrypoint's own imports.
const specifierRe = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g

function verify() {
  say('verify the candidate')
  const entry = path.join(candidate, 'index.mjs')
  if (!fs.existsSync(entry)) fail('verify', 1, 'no index.mjs in the candidate')
  const files = chunks(candidate)
  const missing = []
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })
    if (r.status !== 0) {
      capture(r.stderr)
      fail('verify', 1, `${path.relative(candidate, f)} does not parse`)
    }
    const src = fs.readFileSync(f, 'utf8')
    for (const m of src.matchAll(specifierRe)) {
      const target = path.resolve(path.dirname(f), m[1])
      if (!fs.existsSync(target)) missing.push(`${path.relative(candidate, f)} -> ${m[1]}`)
    }
  }
  if (missing.length) fail('verify', 1, `unresolvable imports: ${missing.slice(0, 5).join('; ')}`)
  say(`verify ok (${files.length} chunks)`)
}

function swap() {
  say('swap dist.next/dist -> dist')
  fs.rmSync(prevDir, { recursive: true, force: true })
  const had = fs.existsSync(distDir)
  if (had) fs.renameSync(distDir, prevDir)
  try {
    fs.renameSync(candidate, distDir)
  } catch (e) {
    if (had) fs.renameSync(prevDir, distDir)
    fail('swap', 1, `rename failed, old dist put back: ${e.message}`)
  }
  fs.rmSync(prevDir, { recursive: true, force: true })
  fs.rmSync(stageDir, { recursive: true, force: true })
}

takeLock()
typecheck()
bundle()
verify()
swap()
record('ok', 'swap', 0, 'built and swapped')
say(`ok (${Date.now() - startedAt}ms)`)
releaseLock()
