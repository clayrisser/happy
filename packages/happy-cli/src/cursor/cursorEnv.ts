/**
 * The environment a Cursor turn runs in (DROVE-253).
 *
 * `CursorBackend.env()` used to spread `process.env` whole. That is the same
 * hole DROVE-238 closed on the Claude side, and here it is worse, because
 * cursor-agent does not merely READ an inherited key — it exchanges it for an
 * access and refresh token pair and PERSISTS that pair through the credential
 * store. Under the default store that is the macOS keychain at the fixed
 * service names `cursor-access-token` / `cursor-refresh-token`, which are not
 * keyed to `CURSOR_CONFIG_DIR`. So a key sitting in the daemon's environment
 * does not just bill the wrong account for one turn: it can overwrite the
 * machine's own login, IDE included.
 *
 * Measured on cursor-agent 2026.08.25-3e8eec8, out of the bundle:
 *
 *     Pe = Ee||Me ? "env" : (o.apiKey||o.authToken ? "flag" : "login")
 *
 * `Ee`/`Me` are `CURSOR_API_KEY` and `CURSOR_AUTH_TOKEN`, `o.apiKey`/
 * `o.authToken` are `--api-key` / `--auth-token`, and `Pe` is the
 * `apiKeySource` published on the `system/init` frame. So the three variables
 * that silently move identity are `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN` and
 * `CURSOR_API_ENDPOINT` — the last because it moves where the credential is
 * spent even when the credential itself is the machine's.
 *
 * The rule: a turn gets a key only when the SESSION owns one. Inheritance is
 * not ownership. When a session does own one it is passed explicitly, so the
 * init frame comes back `apiKeySource: "env"` and the row says so.
 */

/** The variables that move who a turn is and where it is billed. */
export const cursorIdentityVars = [
    'CURSOR_API_KEY',
    'CURSOR_AUTH_TOKEN',
    'CURSOR_API_ENDPOINT',
] as const;

/** A credential this session was explicitly given, as opposed to one it found. */
export interface CursorOwnedCredential {
    /** Passed as `CURSOR_API_KEY`. Null/undefined means the machine login. */
    apiKey?: string | null;
    /** Passed as `CURSOR_API_ENDPOINT`. Only meaningful beside an owned key. */
    apiEndpoint?: string | null;
}

/**
 * `base` with the identity variables removed, then whatever the session owns
 * put back. Never mutates `base`.
 */
export function cursorTurnEnv(
    configDir: string,
    owned: CursorOwnedCredential = {},
    base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base, CURSOR_CONFIG_DIR: configDir };
    for (const name of cursorIdentityVars) delete env[name];
    if (owned.apiKey) env.CURSOR_API_KEY = owned.apiKey;
    if (owned.apiEndpoint) env.CURSOR_API_ENDPOINT = owned.apiEndpoint;
    return env;
}

/**
 * What was scrubbed, for the log line. An inherited key that silently vanishes
 * is better than one that silently bills, but a key that vanishes without a
 * word is how someone spends an afternoon on "why is it the wrong account".
 */
export function scrubbedCursorVars(
    owned: CursorOwnedCredential = {},
    base: NodeJS.ProcessEnv = process.env,
): string[] {
    const kept = new Set<string>();
    if (owned.apiKey) kept.add('CURSOR_API_KEY');
    if (owned.apiEndpoint) kept.add('CURSOR_API_ENDPOINT');
    return cursorIdentityVars.filter((n) => base[n] !== undefined && !kept.has(n));
}

/**
 * How the app should read the `apiKeySource` on the init frame.
 *
 * `login` is the machine's own credential and is the only quiet answer. `env`
 * and `flag` mean the turn is running as whoever that key belongs to, which is
 * exactly the thing that must not be invisible.
 */
export type CursorApiKeySource = 'login' | 'env' | 'flag' | 'config' | string;

export function cursorApiKeySourceIsOwnLogin(source: string | null | undefined): boolean {
    return !source || source === 'login';
}
