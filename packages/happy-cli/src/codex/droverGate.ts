/**
 * Codex approvals on the Cattle Drover bus (DROVE-273, slice 3).
 *
 * Codex approvals reach the phone today, through the Happy session, and they
 * reach nothing else. The gum popup in tmux and the watch are drover bus
 * surfaces, and nothing in src/codex/ has ever spoken to the bus — so a Codex
 * session asking to run `rm -rf` is invisible to every surface except an app
 * someone has to already be looking at.
 *
 * Every other harness publishes from a shell hook (adapters/*-permission-gate.sh).
 * Codex has no hook point: approvals arrive as server→client JSON-RPC REQUESTS
 * on the app-server socket, in process. So the publish has to happen here.
 *
 * WHERE THE FAIL-OPEN LINE IS DRAWN, and it is drawn exactly where DROVE-203
 * drew it for Cursor after four Destructive-Bash gates resolved `allow` with
 * nobody at the terminal:
 *
 *   BEFORE the event is published — no DROVER_URL, bus down, POST refused, no
 *   id back — this returns null. Null is not a decision. It means "the bus
 *   could not be asked", and the caller carries on with the surfaces it already
 *   had. The bus ACCELERATES; it never gates, and a drover that is down must
 *   not brick a Codex session.
 *
 *   AFTER it is published, silence is not a fallback. The event was a human's
 *   chance to see this call and it ended unanswered — expired, canceled, or
 *   still pending at the budget. That is `denied`, out loud. Never `approved`
 *   on any failure path.
 *
 * The one exception is `cancel()`, which is US withdrawing the card because
 * another surface answered first. A gate we withdrew is not a gate nobody
 * answered, so it resolves null rather than denying.
 */

import { logger } from '@/ui/logger';

/** What the caller gets back. Null means the bus could not be asked at all. */
export type CodexGateDecision = 'approved' | 'denied';

export type CodexGateRequest = {
    /** Which approval Codex raised. Only used for the card's wording. */
    type: 'exec' | 'patch' | 'mcp';
    /** The Happy-side tool name, e.g. CodexBash. */
    toolName: string;
    /** What is about to happen, for the card body. Truncated by the bus. */
    preview: string;
    sessionId: string | null;
    cwd: string | null;
};

export type CodexGateOptions = {
    /** Defaults to DROVER_URL, then the loopback bus. */
    bus?: string;
    /** How long to hold the long poll. Matches the shell gates' budget. */
    timeoutMs?: number;
    /** Injectable for tests. */
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
};

export type CodexGateHandle = {
    /** 'approved' | 'denied', or null when the bus was never asked. */
    decision: Promise<CodexGateDecision | null>;
    /** Withdraw the card: another surface answered first. */
    cancel: () => void;
};

/** The bus the shell gates use when nothing says otherwise. */
const DEFAULT_BUS = 'http://127.0.0.1:7970';

/** Cap the preview here as well as at the bus, so a huge patch is not POSTed. */
const PREVIEW_MAX = 2000;

function cardTitle(req: CodexGateRequest): string {
    if (req.type === 'exec') return 'Codex wants to run a command';
    if (req.type === 'patch') return 'Codex wants to edit files';
    return `Codex wants to call ${req.toolName}`;
}

/**
 * Publish a Codex approval to the drover bus and wait for a human.
 *
 * Returns immediately with a handle; nothing here blocks the caller, because
 * the caller is racing this against the app's own permission card.
 */
export function openCodexGate(
    req: CodexGateRequest,
    opts: CodexGateOptions = {},
): CodexGateHandle {
    const env = opts.env ?? process.env;
    const doFetch = opts.fetchImpl ?? fetch;
    const bus = (opts.bus ?? env.DROVER_URL ?? DEFAULT_BUS).replace(/\/+$/, '');
    // Same budget the shell gates use, and read from the same env var so all
    // four harnesses time out together rather than drifting apart.
    const fromEnv = Number(env.DROVER_GATE_TIMEOUT_MS);
    const timeoutMs = opts.timeoutMs
        ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 580_000);

    let eventId: string | null = null;
    let withdrawn = false;

    const cancel = () => {
        if (withdrawn) return;
        withdrawn = true;
        if (!eventId) return;
        // Fire and forget. The card is gone from our side either way; leaving a
        // stale pending event on the bus is untidy, not dangerous.
        void doFetch(`${bus}/v1/events/${eventId}/cancel`, { method: 'POST' })
            .catch(() => { /* the bus being unreachable now changes nothing */ });
    };

    const decision = (async (): Promise<CodexGateDecision | null> => {
        // ---- publish. Everything that fails here is a pre-publish fail-open.
        let created: { id?: string } | null = null;
        try {
            const res = await doFetch(`${bus}/v1/events`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kind: 'permission',
                    title: cardTitle(req),
                    reason: req.toolName,
                    preview: (req.preview || '').slice(0, PREVIEW_MAX),
                    channel: 'hook-wait',
                    origin: {
                        harness: 'codex',
                        sessionId: req.sessionId,
                        cwd: req.cwd,
                        // PRESENT beats truthy in the registry (DROVE-31): the
                        // key with a null says "on no drover-managed account",
                        // which is the true answer — the flip moves Claude
                        // logins and Codex keeps its own under CODEX_HOME.
                        account: null,
                        surface: env.TMUX_PANE ?? null,
                    },
                }),
            });
            if (!res.ok) {
                logger.debug(`[CodexGate] bus refused the publish: ${res.status}`);
                return null;
            }
            created = await res.json() as { id?: string };
        } catch (err) {
            logger.debug(`[CodexGate] could not publish: ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
        if (!created?.id) {
            logger.debug('[CodexGate] bus returned no event id');
            return null;
        }
        eventId = created.id;
        if (withdrawn) {
            // cancel() ran while the POST was in flight, so it had no id to use
            // and returned early. Send it now — via cancelSilently, because
            // cancel() would see `withdrawn` already set and do nothing, which
            // is how the card would have been left pending on the bus forever.
            cancelSilently();
            return null;
        }

        // ---- wait. From here on, silence is a DENY.
        try {
            const res = await doFetch(
                `${bus}/v1/events/${eventId}/wait?timeout_ms=${timeoutMs}`,
            );
            if (withdrawn) return null;
            if (!res.ok) {
                logger.debug(`[CodexGate] wait returned ${res.status}; denying`);
                return 'denied';
            }
            const body = await res.json() as {
                state?: string;
                resolution?: { action?: string; by?: string };
            };
            if (body?.state !== 'resolved') {
                logger.debug(`[CodexGate] gate ended ${body?.state ?? 'unreadable'}; denying`);
                cancelSilently();
                return 'denied';
            }
            const action = body.resolution?.action;
            if (action === 'allow') return 'approved';
            if (action === 'deny') return 'denied';
            // Resolved, carrying nothing readable as a decision. Not an approval.
            logger.debug(`[CodexGate] resolved with no usable action (${action ?? 'none'}); denying`);
            return 'denied';
        } catch (err) {
            if (withdrawn) return null;
            logger.debug(`[CodexGate] lost the bus while waiting: ${err instanceof Error ? err.message : String(err)}`);
            return 'denied';
        }
    })();

    /** Withdraw without flipping `withdrawn`, which would mask the deny. */
    function cancelSilently() {
        if (!eventId) return;
        void doFetch(`${bus}/v1/events/${eventId}/cancel`, { method: 'POST' })
            .catch(() => { /* nothing to do */ });
    }

    return { decision, cancel };
}

/**
 * Whether to put Codex approvals on the bus at all.
 *
 * Off by default while this is new. On, a Codex approval raises a drover card
 * as well as the app's own, and whichever answers first withdraws the other.
 * Turn it on with DROVER_CODEX_GATE=1.
 */
export function codexGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.DROVER_CODEX_GATE === '1';
}
