/**
 * `drover mcps` help must be FREE (DROVE-315). cattle-drover's
 * tests/libexec-loadtime.bats treats any subprocess spawned on `--help` as a
 * load-time side effect and fails it; the shell answered help before it ever
 * reached `exec node engine/mcp.js`. The port keeps that: the help path returns
 * before `await import('./engine')`, so asking for help never loads the engine
 * and never touches a file. This pins both — the exact text, and that fetch and
 * the engine stay untouched.
 *
 * The engine's OWN behaviour (the reads, and the security proof that no secret,
 * host or key is ever printed) stays engine/mcp.js's, asserted by
 * cattle-drover/tests/mcp.bats, because the engine stays there and both the
 * verb and GET /v1/mcps call into it — one reader.
 */

import { describe, expect, it, vi } from 'vitest';

import { run } from './mcps';

function withStdout(): { out: () => string; restore: () => void } {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
        chunks.push(String(c));
        return true;
    });
    return { out: () => chunks.join(''), restore: () => spy.mockRestore() };
}

describe('drover mcps — help answers before the engine loads', () => {
    it('prints the usage and exits 0 for --help, -h and help alike', async () => {
        for (const flag of ['--help', '-h', 'help']) {
            const cap = withStdout();
            const fetchSpy = vi.spyOn(globalThis, 'fetch');
            const code = await run([flag]);
            const text = cap.out();
            cap.restore();

            expect(code, flag).toBe(0);
            expect(text, flag).toContain('drover mcps — the MCP servers and model providers each harness is\nconfigured with.');
            expect(text, flag).toContain('drover mcps <harness>  one of: claude, cursor, codex, opencode, pi');
            expect(text.trimEnd(), flag).toMatch(/Reads only\. Never an env value, an argument, an API key or a base URL\.$/);
            expect(fetchSpy, flag).not.toHaveBeenCalled();
            fetchSpy.mockRestore();
        }
    });
});
