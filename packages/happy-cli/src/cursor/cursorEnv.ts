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
 *
 * A SUBSCRIPTION TOKEN IS NOT PASSED AT ALL (DROVE-387). `--account` runs on a
 * drover-held token, and there is no spelling of that token in this environment
 * — the scrub above would eat it, and eating it is correct. It arrives instead
 * as a private HOME holding cursor-agent's own file credential store, which is
 * the one place cursor-agent reads a login from that is not the machine
 * Keychain. The init frame then reads `apiKeySource: "login"`, because from
 * cursor-agent's side that is exactly what it is: a login, in a store drover
 * owns. Which account it belongs to is on `DROVER_ACCOUNT`, not on the frame.
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
    /**
     * The private HOME whose `.cursor/auth.json` holds this session's own
     * subscription token (DROVE-387). This is how a `--account` run is given a
     * credential WITHOUT one being in the environment: HOME plus the file
     * store, which is where cursor-agent reads a login from and the only path
     * that never touches the machine Keychain. See cursorCredentialHome.ts.
     */
    credentialHome?: string | null;
}

/**
 * The variable `drover cursor --account` leaves for the runner to pick up. It
 * is a PATH, not a secret — the token is a 0600 file inside it — so it may sit
 * in the environment where `CURSOR_AUTH_TOKEN` may not.
 */
export const cursorCredentialHomeVar = 'DROVER_CURSOR_HOME';

/** What this process was told it owns, off its own environment. */
export function cursorOwnedFromEnv(base: NodeJS.ProcessEnv = process.env): CursorOwnedCredential {
    const home = base[cursorCredentialHomeVar];
    return home ? { credentialHome: home } : {};
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
    // The credential the session owns arrives as a PLACE rather than a value
    // (DROVE-387). The scrub above still runs, and still runs first: a home is
    // not a licence to also inherit somebody's token.
    if (owned.credentialHome) {
        env.HOME = owned.credentialHome;
        env.AGENT_CLI_CREDENTIAL_STORE = 'file';
    }
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
