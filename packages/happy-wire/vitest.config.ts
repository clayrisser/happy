import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // bin/ holds the dist-freshness guard (DROVE-104). It lives outside src/
    // on purpose, so editing it never marks the wire's source newer than its
    // own dist and triggers the very check it implements.
    include: ['src/**/*.test.ts', 'bin/**/*.test.ts'],
  },
});
