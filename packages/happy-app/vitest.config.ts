import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
    test: {
        globals: false,
        environment: 'node',
        include: ['sources/**/*.{spec,test}.ts'],
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
            '@': resolve('./sources'),
            // Metro reaches the local expo modules through autolinking and tsc
            // through tsconfig `paths`; vitest has neither, so a bare
            // `drover-watch` import is unresolvable here and `vi.mock` on it
            // throws before the factory ever runs. Mirrors the tsconfig entry.
            'drover-watch': resolve('./modules/drover-watch'),
            'drover-speech': resolve('./modules/drover-speech'),
        },
    },
})