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
 * ## Which sessions are in the cycle: DROVE-297's, consumed whole
 *
 * "The next session that has reading enabled" is DROVE-297's rule, not this
 * ticket's, and there is exactly one copy of it. Enablement is per session
 * there (`readAloud.isSessionEnabled`) and the take is per session too
 * (`readAloud.takeVoice`, which runs DROVE-297's own `voiceMove` and then
 * DROVE-289's hold-and-restore). So `cycle()` arrives already filtered, and
 * this file does not decide membership, does not re-derive it, and does not
 * sort it. The ring step below is the only rule DROVE-300 owns.
 *
 * ORDER TRAVELS WITH THE SET on purpose. Splitting them — membership from
 * DROVE-297, order invented here — is how the two would come to disagree the
 * first time one of them changes its mind about an archived session.
 *
 * THAT IS ALSO WHY THERE IS NO "IS READING ON" GUARD. Under DROVE-297 there is
 * no single answer to that question: the master switch is a DEFAULT and each
 * session has its own. The guard the old global flag was standing in for —
 * DROVE-189's "a squeeze must never turn the voice on for a session he walked
 * away from" — is now structural instead: every id in `cycle()` is a session
 * whose reading he armed, so there is no press that can start audio he did not
 * ask for, and an empty cycle is the refusal.
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
     * No session has reading enabled, so there is nothing to hand the voice
     * to and nothing holding it. This is also where DROVE-189's rule lands
     * now — "a squeeze that turned the voice back on for a session he had
     * walked away from would be a surprise" — because a phone with reading
     * switched off everywhere has an empty cycle and every press refuses.
     */
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
    cycle: readonly string[],
    current: string | null,
): NextSessionMove {
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
     * DROVE-297's per-session switch, through readingCycle.ts.
     */
    cycle(): readonly string[];
    /**
     * Who holds the voice now. `readAloud.readingSessionId`, which is not the
     * same as the focused session: a session he switched reading off on keeps
     * its focus for a moment and has already given the voice up.
     */
    current(): string | null;
    /**
     * Give the voice to this session. `readAloud.takeVoice`, which is
     * DROVE-297's `voiceMove` over DROVE-289's hold-and-restore: the yielding
     * session pauses at its own place and this one resumes at its own. Not a
     * stop, not a jump ahead, and not a claim that he navigated anywhere.
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
            const move = nextSessionMove(deps.cycle(), deps.current());
            if (move.kind !== 'move') return;
            deps.take(move.to);
        } catch {
            // A dead skip button is better than a dead reader. Same rule
            // backgroundAudio.ts applies to the lock screen's play/pause.
        }
    });
    return () => { remote.remove(); };
}
