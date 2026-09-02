/**
 * Where a pi session actually registered, printed where you can see it
 * (DROVE-379).
 *
 * `drover pi` printed its session id and nothing else, so when the phone's
 * list did not show the session there was no way to tell from the terminal
 * whether it had gone to another machine, another account, another happy home
 * or another server. Answering that took reading sessions.json, the daemon log
 * and the session log, and every one of those theories turned out to be wrong.
 *
 * One line at startup makes the next occurrence a glance instead. It carries
 * the four things that decide which list a session lands in, and nothing that
 * could be a secret: the machine id, the drover account, the happy home and
 * the server. `$HOME` collapses to `~` for the same reason the huly session
 * identity does — the same session then reads identically on macOS and Linux,
 * and no OS username rides along.
 */

export interface PiRegistrationFacts {
    machineId: string;
    happyHomeDir: string;
    serverUrl: string;
    /** `DROVER_ACCOUNT`, when drover started this pane. */
    account?: string | null;
    /** `os.homedir()`, so the caller decides what home means. */
    homeDir?: string | null;
}

function collapseHome(path: string, homeDir?: string | null): string {
    const home = homeDir?.replace(/\/+$/, '');
    if (!home) return path;
    if (path === home) return '~';
    return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * The registration line, or null when there is nothing worth printing. Never
 * throws and never includes a token: a caller can print it unconditionally.
 */
export function piRegistrationLine(facts: PiRegistrationFacts): string | null {
    const parts: string[] = [];
    const machineId = facts.machineId?.trim();
    if (machineId) parts.push(`machine ${machineId}`);
    const account = facts.account?.trim();
    if (account) parts.push(account);
    const happyHome = facts.happyHomeDir?.trim();
    if (happyHome) parts.push(collapseHome(happyHome, facts.homeDir));
    const serverUrl = facts.serverUrl?.trim();
    if (serverUrl) parts.push(serverUrl);
    if (parts.length === 0) return null;
    return `registered on ${parts.join(' · ')}`;
}
