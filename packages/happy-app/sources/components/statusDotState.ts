/**
 * What the status strip's dot MEANS, and for how long (DROVE-231).
 *
 * Clay, giving the whole strip at once because pieces of it kept being
 * re-derived: "The dot is green for connected, blinking blue when working and
 * yellow when recently disconnected and red if disconnected for a while. Don't
 * show text working. ... Also when compacting the dot turns purple and blinks."
 *
 * So the dot is the only thing on the line that says what the session is
 * doing. The word `working` is gone (DROVE-138 took `online` for the same
 * reason, and this finishes the job), and with the word gone the colour has to
 * carry five states rather than three. Three of those needed a NUMBER rather
 * than a guess, and all three are below with the reasoning:
 *
 *   - how long `recently` lasts before yellow becomes red,
 *   - what counts as compacting,
 *   - the blink period.
 *
 * THE BLINK IS BUSY, AND ONLY BUSY. Two states blink, working and compacting,
 * so the blink cannot be what tells them apart; the hue is. That leaves the
 * blink one job, and it is worth stating as a rule because the strip has a
 * sixth state Clay's table does not cover: waiting on a permission or an
 * answer, which has pulsed amber here since DROVE-82. It stops pulsing. A
 * blinking dot means the session is BURNING TOKENS RIGHT NOW; steady means it
 * is not. Blue is your turn, purple is the compaction pass. Amber, green,
 * yellow and red are all steady, and each is a different reason to be still.
 *
 * Pure, so the thresholds can be pinned without a clock or a renderer.
 */
import { LIVE_STATUS_STALE_MS } from '@/utils/liveStatus';

export type StatusDotState =
    /** Nothing has been heard from this session for a while. */
    | 'disconnected'
    /** It dropped, but recently enough that it is probably coming back. */
    | 'recentlyDisconnected'
    /** The compaction pass is running. */
    | 'compacting'
    /** The main thread is working. */
    | 'working'
    /** Connected and blocked on Clay: a permission, or an answer. */
    | 'waiting'
    /** Connected, idle. */
    | 'connected';

/**
 * HOW LONG `RECENTLY` LASTS. Two minutes, and not a round two minutes.
 *
 * It is `LIVE_STATUS_STALE_MS`, imported rather than written down again. That
 * is the window the strip already uses to decide a live snapshot is too old to
 * draw, so at the moment the dot turns red the strip has ALSO stopped
 * believing anything the session last said about itself. One number, one
 * meaning: inside it the phone is still working from a picture it trusts, and
 * yellow says the picture is probably still true. Outside it the picture is
 * gone and red says go and look.
 *
 * The alternative was a round 60 or 90 seconds chosen for how it feels, and
 * that is the kind of constant that drifts from the one beside it and then
 * nobody can say why the dot and the readout disagree. A lid closed, a wifi
 * hop and a tunnel reconnect all resolve well inside two minutes; a session
 * that has been quiet longer than the strip's own staleness window is a
 * session that has actually gone.
 */
export const DISCONNECT_RECENT_MS = LIVE_STATUS_STALE_MS;

/**
 * WHAT COUNTS AS COMPACTING, given what the phone can actually see.
 *
 * It cannot see the event. Claude Code writes a compaction summary into the
 * transcript and happy-cli DROPS it (`isCompactSummary` returns no envelopes in
 * sessionProtocolMapper.ts), so no marker for it ever reaches the wire, and the
 * live snapshot has no field for one either. Making it exact means the CLI
 * stamping the snapshot, and DROVE-220 means a CLI change does not reach a
 * session that is already running.
 *
 * So it is INFERRED from the two facts the phone does have, and the inference
 * is stated rather than hidden: the main thread is working, no tool is running,
 * and the context has reached the point where the compaction pass fires. That
 * combination is what a compaction looks like from outside: a long model call
 * with nothing on disk to name it, at the top of the window.
 *
 * It is wrong in one direction only. A normal reply composed at 94% of the
 * window with no tool open reads as compacting for the seconds it takes, until
 * the context drops. That is a hue on a 7pt dot being early, not a claim being
 * made, and it is the right way round: the honest failure is saying "about to
 * compact" a little before it happens, never saying nothing while it does.
 */
export const COMPACTING_NEEDS_WORKING_MAIN = true;

export interface StatusDotInput {
    /** `session.presence === 'online'`. */
    online: boolean;
    /** `session.activeAt`: when the phone last heard from this session, epoch ms. */
    lastSeenAt?: number | null;
    /** The main thread is working: `summarizeLiveStatus(...).main !== null`. */
    mainWorking: boolean;
    /** A tool is running. Compaction is a model call with no tool under it. */
    toolRunning: boolean;
    /** The context has reached the compaction point (see contextCompaction.ts). */
    atCompaction: boolean;
    /** Connected and blocked on Clay: a permission prompt, or a question. */
    waiting: boolean;
    now: number;
}

/**
 * The dot's state, in precedence order.
 *
 * Disconnected wins over working on purpose. Presence can drop while a
 * snapshot taken thirty seconds ago still says the main thread is busy, and a
 * blue dot on a session the phone cannot reach is the strip lying about the
 * one thing it exists to say.
 */
export function statusDotState(input: StatusDotInput): StatusDotState {
    if (!input.online) {
        const since = input.lastSeenAt;
        if (typeof since !== 'number' || !Number.isFinite(since)) return 'disconnected';
        return input.now - since < DISCONNECT_RECENT_MS ? 'recentlyDisconnected' : 'disconnected';
    }
    if (input.mainWorking && !input.toolRunning && input.atCompaction) return 'compacting';
    if (input.mainWorking) return 'working';
    if (input.waiting) return 'waiting';
    return 'connected';
}

/**
 * The hues, spelled out because Clay named them by colour.
 *
 * Green, blue and amber are the ones this strip already drew (DROVE-82,
 * DROVE-155), kept to the digit so nothing on the screen shifts that was not
 * asked to. Yellow is iOS systemYellow rather than the amber beside it: they
 * are two different states now and #FF9500 against #FFCC00 is the widest
 * separation available without inventing a colour the app does not use
 * anywhere else. Red and purple are systemRed and systemPurple.
 */
export const statusDotColors: Record<StatusDotState, string> = {
    connected: '#34C759',
    working: '#007AFF',
    waiting: '#FF9500',
    recentlyDisconnected: '#FFCC00',
    disconnected: '#FF3B30',
    compacting: '#AF52DE',
};

/** Every state a screen reader hears, since the word beside the dot is gone. */
export const statusDotLabels: Record<StatusDotState, string> = {
    connected: 'Connected',
    working: 'Working',
    waiting: 'Waiting for you',
    recentlyDisconnected: 'Disconnected just now',
    disconnected: 'Disconnected',
    compacting: 'Compacting',
};

/**
 * THE BLINK PERIOD: one full cycle, in milliseconds.
 *
 * 2000, which is what StatusDot has always pulsed at (a 1000ms fade to 0.3,
 * reversed). It is written down here rather than left as a literal in the
 * renderer because it is now a SHARED period: working and compacting must
 * blink identically so that the blink says "busy" and the hue says which kind
 * of busy. Two rhythms would make it two languages, and at 7pt the eye reads
 * rhythm before it reads hue.
 *
 * The value stays where it was for a reason, not out of inertia. A strip Clay
 * watches for hours cannot nag, which rules out anything under about a second;
 * a 7pt dot has to visibly move to read as alive, which rules out much over
 * three. Two seconds is the middle of that, and it is what every other pulsing
 * dot in the app already does, so changing it would make this dot the odd one
 * out for no gain.
 */
export const STATUS_DOT_BLINK_MS = 2000;

/** The half cycle: the fade out, which reverses to make the full period. */
export const STATUS_DOT_BLINK_HALF_MS = STATUS_DOT_BLINK_MS / 2;

/** The opacity the fade reaches. Never 0: a dot that vanishes reads as gone. */
export const STATUS_DOT_BLINK_MIN_OPACITY = 0.3;

/** Which states blink. Exactly the two that are burning tokens. */
export function statusDotBlinks(state: StatusDotState): boolean {
    return state === 'working' || state === 'compacting';
}
