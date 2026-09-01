import { headphoneAction, type RemoteCommand } from './headphonePress';

/**
 * The double press, turned into "the next session reads now" (DROVE-300).
 *
 * Clay, choosing the gesture himself: "double press would be just like playing
 * YouTube, it skips to the next track — in this case the next session."
 *
 * headphonePress.ts decides that a double press MEANS the next session. This
 * decides which session that is and what happens to the one it leaves, and it
 * is deliberately short, because almost none of the mechanism is new.
 *
 * ## What already existed, and is therefore not reimplemented here
 *
 * DROVE-289 already made a session switch a PAUSE TAKEN PER SESSION. The one
 * reader keeps a held reading per session (`heldReadings`, capped at eight);
 * `readAloud.focus(next)` stashes the outgoing session's whole position — the
 * timeline, the cursor, every spoken mark, the pause he took himself — and
 * restores the incoming session's own, then resumes from it. A held session's
 * timeline KEEPS FILLING while it waits, so coming back reads on through what
 * landed rather than skipping it.
 *
 * That is exactly the verb this ticket asks for: never a stop, never a jump
 * ahead. So the hand-over is one call, `take`, and this file's only real job
 * is deciding WHICH session and refusing when there is nowhere to go.
 *
 * ## Which sessions are in the cycle: the DROVE-297 seam
 *
 * "The next session that has reading enabled" is DROVE-297's rule, not this
 * ticket's, and there must be exactly one copy of it. So the enabled set
 * arrives through `cycle()` and this file does not compute it, does not
 * filter it, and does not sort it. `cycle()` returns the sessions with reading
 * enabled IN THE ORDER A PRESS WALKS THEM, and the ring step below is all that
 * is added on top.
 *
 * ORDER TRAVELS WITH THE SET on purpose. Splitting them — membership from
 * DROVE-297, order invented here — is how the two would come to disagree the
 * first time DROVE-297 decides that, say, an archived session sorts last.
 *
 * WHAT TO DO WHEN DROVE-297 LANDS: point `cycle` at its exported policy in
 * nextSessionService.ts and delete the fallback there. Nothing in this file
 * changes, and neither do its tests, which is the whole reason the port is
 * shaped this way.
 *
 * ## Pure, because the press arrives with the app in his pocket
 *
 * Foreground/background parity is the requirement this ticket is really
 * about, and the cheapest way to satisfy it is to have nothing here that
 * could tell the difference. No react, no navigation, no mounted screen, no
 * timers, no device. `nextSessionMove` is a function of three values, so the
 * answer with the phone locked is the same answer as with it in his hand, and
 * a test can prove it without a simulator.
 */

/**
 * What a double press does, decided.
 *
 * `stay` carries a reason rather than being a bare null, because the three
 * ways to end up going nowhere are genuinely different things and a caller
 * that wants to SAY so — a cue, a log line — needs to know which.
 */
export type NextSessionMove =
    /** Give the voice to this session, holding the outgoing one's place. */
    | { kind: 'move'; to: string }
    /** Nowhere to go. Doing nothing is the answer; it is never a stop. */
    | { kind: 'stay'; why: NextSessionRefusal };

export type NextSessionRefusal =
    /**
     * Read-aloud is off. There is no voice to hand over, and a remote press
     * must never turn reading ON — DROVE-189's rule, kept verbatim through
     * DROVE-233 and again here: "a squeeze that turned the voice back on for
     * a session he had walked away from would be a surprise".
     */
    | 'not-reading'
    /** Reading is on and no session has it enabled. Nothing to cycle. */
    | 'empty'
    /**
     * Exactly one session has reading enabled, and it already has the voice.
     *
     * A NO-OP RATHER THAN A STOP, which is the decision the ticket asked for
     * out loud. The alternative — pausing the only session because there is
     * nobody to hand to — would make the double press a second, worse pause
     * that he cannot resume with the same gesture. Going nowhere is the
     * honest answer to "next" when there is no next.
     *
     * It is SILENT, and that is the one thing here worth arguing about later:
     * headphonePress.ts's own doctrine is that eyes-free means a press with no
     * sound is indistinguishable from a press that did nothing, which is why
     * the mic has three cues. This refusal deserves one too. It is left
     * unspent rather than guessed at, and the shape above is what makes it a
     * one-line addition at the call site rather than a change in here.
     */
    | 'alone';

/**
 * The whole decision.
 *
 * The ring step is the only rule this file owns: walk `cycle` from wherever
 * the voice is now and take the next one, wrapping at the end.
 *
 * A CURRENT SESSION THAT IS NOT IN THE CYCLE takes the FIRST entry, rather
 * than refusing. That is the case where he is listening to a session whose
 * reading DROVE-297 has since turned off, or where nothing holds the voice at
 * all; both want the press to land somewhere it can be heard, and the first
 * enabled session is the only defensible answer. Refusing instead would leave
 * him pressing a button that never works until he opens the app, which is the
 * failure this ticket exists to avoid.
 */
export function nextSessionMove(
    reading: boolean,
    cycle: readonly string[],
    current: string | null,
): NextSessionMove {
    if (!reading) return { kind: 'stay', why: 'not-reading' };
    if (cycle.length === 0) return { kind: 'stay', why: 'empty' };
    const at = current === null ? -1 : cycle.indexOf(current);
    if (at === -1) return { kind: 'move', to: cycle[0] };
    if (cycle.length === 1) return { kind: 'stay', why: 'alone' };
    return { kind: 'move', to: cycle[(at + 1) % cycle.length] };
}

/** What the press needs of the app, and nothing more. */
export interface NextSessionDeps {
    /**
     * The sessions with reading enabled, in the order a press walks them.
     * DROVE-297's exported policy. See the seam note above.
     */
    cycle(): readonly string[];
    /** Who holds the voice now. `readAloud.focusedSessionId`. */
    current(): string | null;
    /** Read-aloud is on at all. `readAloud.isEnabled`. */
    reading(): boolean;
    /**
     * Give the voice to this session. `readAloud.focus`, which is DROVE-289's
     * hold-and-restore and not a stop.
     */
    take(sessionId: string): void;
    /** The native press stream. `addRemoteCommandListener`. */
    subscribe(listener: (command: RemoteCommand) => void): { remove(): void };
}

/**
 * Wire the double press to the reader.
 *
 * Its own subscription rather than a branch in backgroundAudio.ts, because
 * that file is the TRANSPORT's and this press is not the transport: it moves
 * the focus, not the play/pause state, and `isTransportCommand` says so.
 * Mixing them is how the file that owns pause would come to own the session
 * list as well.
 *
 * The owner is `transport` and nothing else yet, for the same reason
 * useVoiceComposer passes `transport`: DROVE-73 has not shipped an audio menu,
 * so there is no second owner to arbitrate with. When it does, it passes
 * `menu` while the menu is being read and this subscription goes quiet on its
 * own, because the table says `menu-next` and not `next-session`.
 */
export function startNextSessionPress(deps: NextSessionDeps): () => void {
    const remote = deps.subscribe((command) => {
        if (headphoneAction(command, 'transport') !== 'next-session') return;
        try {
            const move = nextSessionMove(deps.reading(), deps.cycle(), deps.current());
            if (move.kind !== 'move') return;
            deps.take(move.to);
        } catch {
            // A dead skip button is better than a dead reader. Same rule
            // backgroundAudio.ts applies to the lock screen's play/pause.
        }
    });
    return () => { remote.remove(); };
}
