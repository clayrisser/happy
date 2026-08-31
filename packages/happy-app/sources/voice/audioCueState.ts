import { ambientForGateKind, cueSpec, type AudioCueId } from './audioCues';

/**
 * Which ambient cue a session's state deserves (DROVE-112).
 *
 * One pure function, and the only place the ambient half of the vocabulary is
 * decided. The inputs are the state the SCREEN already reads: the same
 * `thinking` / `liveStatus` pair the status row is drawn from, and the same
 * gate list the gate cards and the wrist are drawn from. There is deliberately
 * no second notion of busy or of pending anywhere in this feature, because a
 * sound that disagrees with the screen is worse than no sound.
 */

export interface CueSessionState {
    /** Read-aloud is on and a session is in focus. Nothing pulses otherwise. */
    reading: boolean;
    /**
     * The session is WORKING. `metadata.liveStatus` being fresh is the status
     * row's own measure of that, and `thinking` covers the window before the
     * CLI has published anything.
     */
    working: boolean;
    /**
     * Bus `kind` of every gate pending on this session, unsorted. A gate is
     * what "waiting on Clay" means, and it is the state the whole product
     * exists to surface.
     */
    pendingKinds: readonly string[];
    /** A sentence is at the synthesiser right now. */
    speaking: boolean;
}

/**
 * The pulse for a state, or null for silence.
 *
 * Four rules, in order, and the order is the argument:
 *
 *  1. Read-aloud off, or no session in focus: nothing. The audio channel is
 *     the user's to switch off and this is part of it.
 *  2. Speech is running: nothing. Speech always wins the audio route, and a
 *     pulse under a spoken sentence would be worse than no pulse at all.
 *  3. A gate is pending: the waiting pulse for the most urgent one, whether or
 *     not anything is also running. A session blocked on Clay is the state
 *     worth hearing, and it does not stop being that because the CLI has
 *     nothing else on.
 *  4. Working: the ordinary pulse.
 *
 * Everything else is IDLE, which is not a state but the absence of one, and
 * silence is already the right signal for it.
 */
export function ambientCue(state: CueSessionState): AudioCueId | null {
    if (!state.reading) return null;
    if (state.speaking) return null;
    if (state.pendingKinds.length > 0) {
        let best: AudioCueId | null = null;
        for (const kind of state.pendingKinds) {
            const candidate = ambientForGateKind(kind);
            if (best === null || cueSpec(candidate).rank > cueSpec(best).rank) best = candidate;
        }
        return best;
    }
    if (state.working) return 'working';
    return null;
}

/** True when the pulse is one of the waiting family, which runs on the fast clock. */
export function isWaitingCue(id: AudioCueId | null): boolean {
    return id !== null && id.startsWith('waiting');
}
