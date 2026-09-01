/**
 * Vitest global setup — runs ONCE before all tests.
 *
 * We only build the CLI here. Integration suites now provision their own
 * isolated environments so each suite can get a fresh lab-rat project copy.
 *
 * We also unpack tools/ here (DROVE-342). scripts/unpack-tools.cjs is
 * happy-cli's postinstall, so a plain checkout has tools/unpacked because
 * `pnpm install` ran in it. A git worktree does not: its node_modules is a
 * symlink to the main checkout's, no install ever runs, and nothing unpacks.
 * difftastic then spawns tools/unpacked/difft and ENOENTs, and ripgrep's
 * launcher misses tools/unpacked/ripgrep.node, falls back to the system rg and
 * prints "Using system ripgrep: ..." onto the stdout its tests parse as JSON.
 * Seven unit tests that measured the developer's machine rather than the code.
 * The script is idempotent, so this costs a stat on a checkout that has them.
 *
 * And one check across the whole run (DROVE-336): the real
 * ~/.happy/sessions.json must not gain a session from this checkout. The unit
 * project's setup file keeps every test, and every child a test spawns, off
 * the real home; that guard is per file, and this is the backstop that fails
 * the run, loudly, if anything got past it. Counted by the session's cwd and
 * happyLibDir under this repo, so a real session started elsewhere while the
 * suite runs is not blamed. A throw from teardown is a vitest startup error
 * and a nonzero exit.
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { realSessionsFile, sessionsUnder } from './testing/leakedSessions'

/** The repo this checkout is: a leaked session's cwd or happyLibDir is under it. */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')

/** This package's root, the directory holding scripts/ and tools/. */
const packageRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

let sessionsBefore = new Set<string>()

export async function setup() {
    process.env.VITEST_POOL_TIMEOUT = '60000'
    process.env.HAPPY_RUN_SANDBOX_NETWORK_TESTS = '1'

    const unpackScript = join(packageRoot, 'scripts', 'unpack-tools.cjs')
    const unpackResult = spawnSync(process.execPath, [unpackScript], { stdio: 'pipe' })
    if (unpackResult.status !== 0) {
        throw new Error(
            `DROVE-342: ${unpackScript} failed (exit ${unpackResult.status}), so tools/unpacked has no difft `
            + 'and no ripgrep.node; the difftastic and ripgrep suites would measure the system binaries.\n'
            + `  stdout: ${unpackResult.stdout?.toString() ?? ''}\n`
            + `  stderr: ${unpackResult.stderr?.toString() ?? ''}`,
        )
    }

    const buildResult = spawnSync('pnpm', ['build'], { stdio: 'pipe' })
    if (buildResult.stderr && buildResult.stderr.length > 0) {
        const errorOutput = buildResult.stderr.toString()
        console.error(`Build stderr (could be debugger output): ${errorOutput}`)
        console.log(`Build stdout: ${buildResult.stdout.toString()}`)
        if (errorOutput.includes('Command failed with exit code')) {
            throw new Error(`Build failed STDERR: ${errorOutput}`)
        }
    }

    sessionsBefore = new Set(sessionsUnder(repoRoot))
}

export async function teardown() {
    // Per-suite integration environments clean themselves up.
    const leaked = sessionsUnder(repoRoot).filter((id) => !sessionsBefore.has(id))
    if (leaked.length > 0) {
        throw new Error(
            `DROVE-336: this run leaked ${leaked.length} session(s) from ${repoRoot} into the real ${realSessionsFile}: `
            + `${leaked.slice(0, 5).join(', ')}${leaked.length > 5 ? ', …' : ''}.\n`
            + '  Something ran the CLI, or a child of it, with the real HAPPY_HOME_DIR and the real server. '
            + 'Every unit test runs under src/testing/noRealState.setup.ts; find the process that did not inherit that env.',
        )
    }
}
