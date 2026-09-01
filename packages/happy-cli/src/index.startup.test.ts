/**
 * Startup / bundle-load budget for the CLI entry (DROVE-314).
 *
 * The read-only verbs `drover --version` (the daemon's constant version probe)
 * and `drover --help` must answer from a version/usage string and NOTHING else.
 * DROVE-314 was a control-flow regression: both fell through to the session-
 * start branch, which dynamic-imports persistence, the auth/api layer and
 * runClaude — ~680ms of bundle-load waste to print a string. DROVE-288 had
 * already fixed the same shape for `pick-account`; these two verbs still went
 * the long way.
 *
 * This test is the budget Clay asked for on the ticket: a future eager import
 * (static, added at the entry) or a future fall-through (control-flow, a read
 * verb reaching the session machinery again) FAILS here instead of quietly
 * costing ~800ms. It runs against the BUILT dist, so the boundaries are checked
 * as the bundler emits them, not as the source reads.
 *
 * The check is deterministic: it records which dist chunks a verb actually
 * loads and asserts the heavy ones are absent. It does not lean on wall-clock
 * time (which varies by machine); a separate, deliberately generous relative
 * timing assertion documents the win without being flaky.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const distDir = join(__dirname, '..', 'dist')
const mjsEntry = join(distDir, 'index.mjs')
const cjsEntry = join(distDir, 'index.cjs')

// Chunks that mean the session/auth/api machinery has been pulled in. A read
// verb that loads any of these has regressed to paying the session-supervisor
// cost. `api-`, `runClaude` and `codexCommand` are the three big ones from the
// ticket; `persistence-` and `auth-` are the gateway chunks the fall-through
// hits first, so catching them fails the moment the regression starts.
const HEAVY = /(?:runClaude|api-[A-Za-z0-9_]+\.[cm]js|codexCommand|persistence-|auth-[A-Za-z0-9_]+\.[cm]js)/

// Budget for how many dist chunks a pure read verb may load: the entry shim,
// the index chunk it re-exports, and the package (version) chunk. A little
// headroom, but nowhere near enough to reach the session machinery.
const READ_VERB_CHUNK_BUDGET = 5

/**
 * Run an entry under an ESM resolve hook that appends every loaded dist chunk
 * basename to a file, in a throwaway HAPPY_HOME_DIR so nothing touches the real
 * daemon/credentials. Returns the loaded chunk set plus the child's result.
 */
function traceLoad(entry: string, args: string[]): { chunks: string[]; status: number | null; stdout: string } {
  const work = mkdtempSync(join(tmpdir(), 'drove314-guard-'))
  const chunksOut = join(work, 'chunks.txt')
  const hook = join(work, 'hook.mjs')
  const register = join(work, 'register.mjs')
  writeFileSync(hook, `
import fs from 'node:fs'
const out = process.env.CHUNKS_OUT
export async function resolve(specifier, context, nextResolve) {
  const r = await nextResolve(specifier, context)
  try {
    if (out && /\\/dist\\/[^/]+\\.(mjs|cjs)$/.test(r.url)) {
      fs.appendFileSync(out, r.url.split('/').pop() + '\\n')
    }
  } catch {}
  return r
}
`)
  writeFileSync(register, `import { register } from 'node:module'\nregister('./hook.mjs', import.meta.url)\n`)
  const r = spawnSync(process.execPath, ['--no-warnings', '--no-deprecation', '--import', register, entry, ...args], {
    encoding: 'utf8',
    input: '',
    timeout: 20_000,
    env: { ...process.env, CHUNKS_OUT: chunksOut, HAPPY_HOME_DIR: join(work, '.happy') },
  })
  const chunks = existsSync(chunksOut)
    ? [...new Set(readFileSync(chunksOut, 'utf8').split('\n').filter(Boolean))]
    : []
  rmSync(work, { recursive: true, force: true })
  return { chunks, status: r.status, stdout: r.stdout || '' }
}

/** Median wall time of `node <extra> <args>` over a few plain runs. */
function medianRun(extra: string[], runs = 5): number {
  const work = mkdtempSync(join(tmpdir(), 'drove314-time-'))
  const env = { ...process.env, HAPPY_HOME_DIR: join(work, '.happy') }
  const times: number[] = []
  for (let i = 0; i < runs + 1; i++) {
    const t = process.hrtime.bigint()
    spawnSync(process.execPath, ['--no-warnings', '--no-deprecation', ...extra], {
      timeout: 20_000, input: '', stdio: ['ignore', 'ignore', 'ignore'], env,
    })
    if (i > 0) times.push(Number(process.hrtime.bigint() - t) / 1e6) // drop the first (cold) run
  }
  times.sort((a, b) => a - b)
  rmSync(work, { recursive: true, force: true })
  return times[Math.floor(times.length / 2)]
}

beforeAll(() => {
  if (!existsSync(mjsEntry)) {
    throw new Error(
      `dist/index.mjs is missing. Build the CLI before running this test ` +
      `(\`pnpm run build\`, which \`pnpm test\` does for you).`,
    )
  }
})

describe('CLI startup budget (DROVE-314)', () => {
  it('--version loads no session/auth/runClaude chunk and exits 0', () => {
    const { chunks, status, stdout } = traceLoad(mjsEntry, ['--version'])
    expect(status).toBe(0)
    expect(stdout).toContain('drover version:')
    const heavy = chunks.filter((c) => HEAVY.test(c))
    expect(heavy, `--version pulled in session/auth machinery: ${heavy.join(', ')}`).toEqual([])
    expect(
      chunks.length,
      `--version loaded ${chunks.length} chunks (budget ${READ_VERB_CHUNK_BUDGET}): ${chunks.join(', ')}`,
    ).toBeLessThanOrEqual(READ_VERB_CHUNK_BUDGET)
  })

  it('--help loads no session/auth/runClaude chunk and exits 0', () => {
    const { chunks, status, stdout } = traceLoad(mjsEntry, ['--help'])
    expect(status).toBe(0)
    expect(stdout).toContain('drover')
    const heavy = chunks.filter((c) => HEAVY.test(c))
    expect(heavy, `--help pulled in session/auth machinery: ${heavy.join(', ')}`).toEqual([])
    expect(
      chunks.length,
      `--help loaded ${chunks.length} chunks (budget ${READ_VERB_CHUNK_BUDGET}): ${chunks.join(', ')}`,
    ).toBeLessThanOrEqual(READ_VERB_CHUNK_BUDGET)
  })

  it('the entry (shim + index chunk) does not eagerly import a heavy chunk', () => {
    // The 4-line shims and the index chunk they re-export are the ENTIRE eager
    // (module-load-time) cost. A static `import { runClaude } from ...` added at
    // the top of index.ts compiles to a top-level `require('./runClaude-*')`
    // here — an eager require, NOT the lazy `return require(...)` form the
    // dynamic imports use — and blows this assertion before any verb runs.
    for (const entry of [cjsEntry, mjsEntry]) {
      if (!existsSync(entry)) continue
      const isCjs = entry.endsWith('.cjs')
      const files = [entry]
      const shim = readFileSync(entry, 'utf8')
      for (const m of shim.matchAll(/['"](\.\/index-[^'"]+)['"]/g)) {
        const p = join(distDir, m[1].replace(/^\.\//, ''))
        if (existsSync(p)) files.push(p)
      }
      const eagerHeavy: string[] = []
      for (const f of files) {
        const src = readFileSync(f, 'utf8')
        if (isCjs) {
          // Eager = `require('./x')` NOT preceded by `return ` (dynamic imports
          // emit `return require('./x')` inside a `.then(...)`).
          for (const m of src.matchAll(/(return\s+)?require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)) {
            if (!m[1] && HEAVY.test(m[2])) eagerHeavy.push(m[2])
          }
        } else {
          // Eager = top-level `import ... from './x'` / `import './x'` /
          // `export ... from './x'`. Dynamic imports emit `import('./x')`, which
          // has a `(` after `import` and is skipped by requiring whitespace.
          for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^\n]*?from\s*['"](\.\/[^'"]+)['"]/g)) {
            if (HEAVY.test(m[1])) eagerHeavy.push(m[1])
          }
          for (const m of src.matchAll(/(?:^|\n)\s*import\s+['"](\.\/[^'"]+)['"]/g)) {
            if (HEAVY.test(m[1])) eagerHeavy.push(m[1])
          }
        }
      }
      expect(eagerHeavy, `${entry.split('/').pop()} eagerly imports: ${eagerHeavy.join(', ')}`).toEqual([])
    }
  })

  it('read verbs stay near node boot, not near session start (generous, relative)', () => {
    // Deliberately loose so it does not flake on a slow CI box: node boot plus a
    // wide margin. The regression this guards cost ~680ms over boot; the fix is
    // a few ms over boot. The margin sits comfortably between.
    const boot = medianRun(['-e', ''])
    const budget = boot + 300
    const v = medianRun([mjsEntry, '--version'])
    const h = medianRun([mjsEntry, '--help'])
    expect(v, `--version ${v.toFixed(0)}ms >= budget ${budget.toFixed(0)}ms (node boot ${boot.toFixed(0)}ms)`).toBeLessThan(budget)
    expect(h, `--help ${h.toFixed(0)}ms >= budget ${budget.toFixed(0)}ms (node boot ${boot.toFixed(0)}ms)`).toBeLessThan(budget)
  })
})
