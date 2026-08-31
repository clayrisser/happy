/**
 * scripts/build.cjs never destroys a working dist (DROVE-65).
 *
 * The old build script deleted dist BEFORE tsc ran, so a type error anywhere,
 * including in a test file, left nothing for the daemon and bridge to load.
 * These run the real script (real tsc, real pkgroll) against a throwaway
 * package, so the failure paths are measured rather than reasoned about.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = join(__dirname, 'build.cjs')

let pkg: string

function write(rel: string, text: string) {
    const p = join(pkg, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, text)
}

function build() {
    const r = spawnSync(process.execPath, [script], {
        encoding: 'utf8',
        env: { ...process.env, HAPPY_BUILD_PKG_DIR: pkg },
    })
    return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

function last(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const line of readFileSync(join(pkg, '.build', 'last'), 'utf8').split('\n')) {
        const i = line.indexOf('=')
        if (i > 0) out[line.slice(0, i)] = line.slice(i + 1)
    }
    return out
}

beforeEach(() => {
    pkg = mkdtempSync(join(tmpdir(), 'build-cjs-'))
    write('package.json', JSON.stringify({
        name: 'fixture',
        version: '0.0.0',
        type: 'module',
        exports: { '.': { import: './dist/index.mjs' } },
    }))
    write('tsconfig.json', JSON.stringify({
        compilerOptions: {
            target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler',
            strict: true, noEmit: true, skipLibCheck: true, types: [],
        },
        include: ['src/**/*.ts'],
    }))
    write('tsconfig.build.json', JSON.stringify({
        extends: './tsconfig.json',
        exclude: ['src/**/*.test.ts'],
    }))
    write('src/index.ts', 'export const answer: number = 42\n')
    write('src/index.test.ts', 'import { answer } from "./index"\nexport const same: number = answer\n')
})

afterEach(() => {
    rmSync(pkg, { recursive: true, force: true })
})

describe('scripts/build.cjs', () => {
    it('builds a clean tree into dist and records ok', () => {
        const r = build()
        expect(r.rc, r.out).toBe(0)
        expect(existsSync(join(pkg, 'dist', 'index.mjs'))).toBe(true)
        expect(existsSync(join(pkg, 'dist.next'))).toBe(false)
        expect(existsSync(join(pkg, 'dist.prev'))).toBe(false)
        expect(last().status).toBe('ok')
        expect(existsSync(join(pkg, '.build', 'lock'))).toBe(false)
    }, 60_000)

    it('a type error in a SOURCE file fails the build and leaves dist byte-for-byte as it was', () => {
        expect(build().rc).toBe(0)
        const before = readFileSync(join(pkg, 'dist', 'index.mjs'), 'utf8')
        const mtime = statSync(join(pkg, 'dist', 'index.mjs')).mtimeMs

        write('src/index.ts', 'export const answer: number = "no"\n')
        const r = build()
        expect(r.rc, r.out).not.toBe(0)
        expect(r.out).toContain('FAILED at typecheck')
        expect(r.out).toContain('src/index.ts')
        expect(r.out).toContain('dist untouched')

        expect(readFileSync(join(pkg, 'dist', 'index.mjs'), 'utf8')).toBe(before)
        expect(statSync(join(pkg, 'dist', 'index.mjs')).mtimeMs).toBe(mtime)
        expect(existsSync(join(pkg, 'dist.prev'))).toBe(false)
        const rec = last()
        expect(rec.status).toBe('failed')
        expect(rec.step).toBe('typecheck')
        expect(rec.reason).toContain('src/index.ts')
    }, 60_000)

    it('a type error in a TEST file does not fail the build; the full typecheck is what catches it', () => {
        write('src/index.test.ts', 'export const same: number = "no"\n')
        const r = build()
        expect(r.rc, r.out).toBe(0)
        expect(existsSync(join(pkg, 'dist', 'index.mjs'))).toBe(true)
        expect(last().status).toBe('ok')

        const tsc = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '-p', join(pkg, 'tsconfig.json')], { encoding: 'utf8' })
        expect(tsc.status).not.toBe(0)
        expect(tsc.stdout).toContain('src/index.test.ts')
    }, 60_000)

    it('a tree that typechecks but will not bundle fails at bundle, dist untouched', () => {
        expect(build().rc).toBe(0)
        const before = readFileSync(join(pkg, 'dist', 'index.mjs'), 'utf8')
        // tsc is satisfied by the .d.mts; rollup has no file to bundle.
        write('src/index.ts', 'export * from "./missing-chunk.mjs"\n')
        write('src/missing-chunk.d.mts', 'export const x: number\n')
        const r = build()
        expect(r.rc, r.out).not.toBe(0)
        expect(r.out).toContain('FAILED at bundle')
        expect(readFileSync(join(pkg, 'dist', 'index.mjs'), 'utf8')).toBe(before)
        expect(existsSync(join(pkg, 'dist.next', 'dist', 'index.mjs'))).toBe(false)
        expect(last().step).toBe('bundle')
    }, 60_000)

    it('a stale lock left by a dead build is cleared, not waited on', () => {
        mkdirSync(join(pkg, '.build', 'lock'), { recursive: true })
        writeFileSync(join(pkg, '.build', 'lock', 'pid'), '999999999')
        const r = build()
        expect(r.rc, r.out).toBe(0)
        expect(r.out).toContain('stale build lock')
    }, 60_000)
})
