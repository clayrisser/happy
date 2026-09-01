/**
 * The dot's vocabulary, which now lives on the wire (DROVE-247).
 *
 * DROVE-231 wrote it here, because the phone's status strip was the only thing
 * that drew a dot. DROVE-243 pointed the session LIST at it and DROVE-257 gave
 * the wrist the same states, and both of those could keep importing from an app
 * file. The terminal cannot: a dot in Clay's tmux status line is resolved by
 * the happy-cli driving that pane, which is a different package.
 *
 * So the file moved to `@slopus/happy-wire` — the one package the app and the
 * CLI both already depend on — and this is a re-export so nothing that imports
 * `@/components/statusDotState` had to move. The reasoning, the thresholds and
 * the colours all went with it; read them there.
 *
 * There is still exactly ONE table. That is the whole point of both the move
 * and this file.
 */
export {
    DISCONNECT_RECENT_MS,
    COMPACTING_NEEDS_WORKING_MAIN,
    COMPACTING_OBSERVED_WINS,
    STATUS_DOT_BLINK_MS,
    STATUS_DOT_BLINK_HALF_MS,
    STATUS_DOT_BLINK_MIN_OPACITY,
    statusDotState,
    statusDotColors,
    statusDotLabels,
    statusDotBlinks,
} from '@slopus/happy-wire';
export type { StatusDotState, StatusDotInput } from '@slopus/happy-wire';
