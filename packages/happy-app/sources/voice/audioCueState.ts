import { ambientForGateKind, cueSpec, workingCueFor, type AudioCueId } from './audioCues';

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
    /**
     * How many subagents are running on this session (DROVE-182). The count
     * the status row shows, from `summarizeLiveStatus`, and derived exactly
     * once: a heartbeat that disagrees with the screen is worse than no
     * heartbeat. The main thread is NOT in it (DROVE-209).
     */
    agents: number;
    /** A sentence is at the synthesiser right now. */
    speaking: boolean;
}

/**
 * The pulse a state DESERVES, or null, said without reference to whether it
 * could be heard this instant.
 *
 * Three rules, in order, and the order is the argument:
 *
 *  1. Read-aloud off, or no session in focus: nothing. The audio channel is
 *     the user's to switch off and this is part of it.
 *  2. A gate is pending: the waiting pulse for the most urgent one, whether or
 *     not anything is also running. A session blocked on Clay is the state
 *     worth hearing, and it does not stop being that because the CLI has
 *     nothing else on.
 *  3. Working: the ordinary pulse.
 *
 * Everything else is IDLE, which is not a state but the absence of one, and
 * silence is already the right signal for it.
 *
 * SPEECH IS NOT ONE OF THE RULES HERE, and that is DROVE-197. Whether the
 * voice has the route is a question about this instant; which pulse the
 * session deserves is not. The mixer needs the second answer even while the
 * first is no, because that is what keeps the heartbeat's CADENCE running
 * through a spoken sentence instead of stalling until one ends. `ambientCue`
 * below is this plus the audibility check, for everything that wants both.
 */
export function ambientCueFor(state: CueSessionState): AudioCueId | null {
    if (!state.reading) return null;
    if (state.pendingKinds.length > 0) {
        let best: AudioCueId | null = null;
        for (const kind of state.pendingKinds) {
            const candidate = ambientForGateKind(kind);
            if (best === null || cueSpec(candidate).rank > cueSpec(best).rank) best = candidate;
        }
        return best;
    }
    // The working pulse COUNTS the subagents, in Morse after the thump
    // (DROVE-182), and the agent count goes in untouched (DROVE-209): the
    // number in the sound is the number on the status row, with no arithmetic
    // between them to drift. None running is the thump on its own.
    if (state.working) return workingCueFor(state.agents);
    return null;
}

/**
 * The pulse that should be SOUNDING right now, or null.
 *
 * `ambientCueFor` plus the one thing it deliberately leaves out: speech always
 * wins the audio route, and a pulse under a spoken sentence is worse than no
 * pulse at all. For the settings preview and for anything asking "what am I
 * hearing"; the mixer asks the two halves separately (see DROVE-197 above).
 */
export function ambientCue(state: CueSessionState): AudioCueId | null {
    if (state.speaking) return null;
    return ambientCueFor(state);
}

/** True when the pulse is one of the waiting family, which runs on the fast clock. */
export function isWaitingCue(id: AudioCueId | null): boolean {
    return id !== null && id.startsWith('waiting');
}
