import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
    test: {
        globals: false,
        environment: 'node',
        globalSetup: ['./src/test-setup.ts'],
        projects: [
            {
                extends: true,
                test: {
                    name: 'unit',
                    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
                    exclude: ['src/**/*.integration.test.ts'],
                    sequence: {
                        groupOrder: 0,
                    },
                },
            },
            {
                extends: true,
                test: {
                    name: 'integration-empty',
                    fileParallelism: false,
                    hookTimeout: 120_000,
                    maxWorkers: 1,
                    minWorkers: 1,
                    testTimeout: 60_000,
                    include: [
                        'src/claude/claude.integration.test.ts',
                        'src/codex/codex.integration.test.ts',
                        'src/sandbox/network.integration.test.ts',
                    ],
                    setupFiles: ['./src/testing/droverTestHome.setup.ts', './src/testing/integration.setup.empty.ts'],
                    sequence: {
                        groupOrder: 1,
                    },
                },
            },
            {
                extends: true,
                test: {
                    name: 'integration-plan-mode',
                    fileParallelism: false,
                    hookTimeout: 120_000,
                    maxWorkers: 1,
                    minWorkers: 1,
                    testTimeout: 180_000,
                    include: [
                        'src/claude/planMode.integration.test.ts',
                    ],
                    setupFiles: ['./src/testing/droverTestHome.setup.ts'],
                    sequence: {
                        groupOrder: 1,
                    },
                },
            },
            {
                extends: true,
                test: {
                    name: 'integration-authenticated',
                    fileParallelism: false,
                    hookTimeout: 120_000,
                    maxWorkers: 1,
                    minWorkers: 1,
                    testTimeout: 60_000,
                    include: [
                        'src/daemon/daemon.integration.test.ts',
                        'src/openclaw/openclaw.integration.test.ts',
                    ],
                    setupFiles: ['./src/testing/droverTestHome.setup.ts', './src/testing/integration.setup.authenticated.ts'],
                    sequence: {
                        groupOrder: 2,
                    },
                },
            },
        ],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: [
                'node_modules/**',
                'dist/**',
                '**/*.d.ts',
                '**/*.config.*',
                '**/mockData/**',
            ],
        },
    },
    resolve: {
        alias: {
            '@': resolve('./src'),
            // Test the wire in THIS tree, not the last artifact someone built
            // (DROVE-103). `@slopus/happy-wire` publishes only `dist`, and that
            // dist is refreshed by the root postinstall, so it is whatever the
            // last `pnpm install` produced. DROVE-95 added `result`/`isError`
            // to sessionToolCallEndEventSchema; the dist on this machine was
            // three days older, and `createEnvelope` zod-parses through it, so
            // every tool-call-end came out as bare `{t, call}` and the three
            // DROVE-95 tests failed against correct code. Worse in a worktree:
            // node_modules is symlinked to the main checkout, so a worktree
            // resolved the main checkout's stale dist. Point at the source and
            // the tests measure the lane.
            '@slopus/happy-wire': resolve('../happy-wire/src/index.ts'),
        },
    },
})
