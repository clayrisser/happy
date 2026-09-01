/**
 * Which sessions are answering their own boolean gates right now (DROVE-277).
 *
 * IN MEMORY, FOR THE LIFE OF THE PROCESS, and that is the security property,
 * not an implementation shortcut. Clay on the ticket: "this should be
 * something that's only enabled on a per session basis". An auto-accept
 * nobody remembers enabling is DROVE-239's bug wearing a feature's clothes —
 * that lane found a gate resolved `allow` with nobody at the terminal, and the
 * only reason it was findable was the ledger saying who answered. A toggle
 * that survived a relaunch would put the app back in that state on purpose,
 * silently, days later.
 *
 * So it deliberately does NOT go through settings.ts (account-wide, synced to
 * every device) or localSettings.ts (device-wide, MMKV, survives a relaunch).
 * It is a module-level set, like `withdrawnGates` and the overlay's
 * dismissals, and it is empty again the moment the process ends. A flip, a
 * relaunch and a crash all come back OFF, and none of them needs code to make
 * that true.
 *
 * Keyed by the session the human is LOOKING AT — the happy session id the
 * composer belongs to — not by the bridge session that happens to hold the
 * mirrored card. Turning it on for one lane must not answer another lane's
 * prompts, and on this machine every local agent's gate lands in ONE bridge
 * session, so keying on the holder would do exactly that.
 */

export interface AutoAcceptSessions {
    /** The session ids that are on, as one immutable snapshot per change. */
    get(): ReadonlySet<string>;
    isOn(sessionId: string): boolean;
    set(sessionId: string, on: boolean): void;
    /** Returns the state it landed in, for a button that toggles. */
    toggle(sessionId: string): boolean;
    subscribe(listener: () => void): () => void;
    /** Testing only: forget everything, as a relaunch would. */
    reset(): void;
}

export function createAutoAcceptSessions(): AutoAcceptSessions {
    let snapshot: ReadonlySet<string> = new Set();
    const listeners = new Set<() => void>();
    const publish = () => { for (const listener of listeners) listener(); };
    const write = (next: ReadonlySet<string>) => { snapshot = next; publish(); };
    return {
        get: () => snapshot,
        isOn: (sessionId) => !!sessionId && snapshot.has(sessionId),
        set(sessionId, on) {
            if (!sessionId) return;
            if (on === snapshot.has(sessionId)) return;
            const next = new Set(snapshot);
            if (on) next.add(sessionId); else next.delete(sessionId);
            write(next);
        },
        toggle(sessionId) {
            if (!sessionId) return false;
            const on = !snapshot.has(sessionId);
            this.set(sessionId, on);
            return on;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        reset() {
            if (snapshot.size === 0) return;
            write(new Set());
        },
    };
}

export const autoAcceptSessions = createAutoAcceptSessions();
