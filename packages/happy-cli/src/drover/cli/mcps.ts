/**
 * `drover mcps` — the MCP servers and model providers each harness on this box
 * is configured with (DROVE-274, DROVE-296), in node (DROVE-315).
 *
 * The shell file this replaces, cattle-drover/libexec/drover-mcps, was two
 * things: a help text, and `exec node "$root/engine/mcp.js" "$@"`. Both are
 * kept exactly. The help answers HERE, before the engine is loaded, because
 * help must be free (the loadtime gate in tests/libexec-loadtime.bats treats a
 * subprocess on --help as a load-time side effect, and it is right). Every
 * other argument reaches engine/mcp.js's own `main(argv)` unchanged, and its
 * return is this verb's exit code — 0, or 2 for an unknown option or harness.
 *
 * Reads the files DIRECTLY rather than asking /v1/mcps. The config is on this
 * disk, so the bus adds a hop that can only fail; and `drover mcps` has to
 * work when the bus is down, which is exactly the state you are in while
 * debugging why an account lost its servers. Both paths call engine/mcp.js,
 * so there is still ONE reader and the terminal cannot disagree with the
 * phone. The security proof — not one planted secret, no credential-shaped
 * key, no host or path — is the engine's, in cattle-drover/tests/mcp.bats,
 * and it stays there because the engine stays there.
 */

const HELP = `drover mcps — the MCP servers and model providers each harness is
configured with.

USAGE
  drover mcps            every harness: name, transport, enabled
  drover mcps -m         ...and name every provider's models
  drover mcps --json     the object /v1/mcps serves
  drover mcps <harness>  one of: claude, cursor, codex, opencode, pi

OpenCode is the harness that takes a provider list, so it is the one with a
providers line, and it is ASKED (\`opencode models\`) rather than worked out
from its config (DROVE-296).

Reads only. Never an env value, an argument, an API key or a base URL.
`;

interface McpEngine {
    main: (argv: string[]) => number;
}

export async function run(args: string[]): Promise<number> {
    const first = args[0];
    if (first === '--help' || first === '-h' || first === 'help') {
        process.stdout.write(HELP);
        return 0;
    }
    const { loadEngine } = await import('./engine');
    const engine = await loadEngine<McpEngine>('mcp.js');
    return engine.main(args);
}
