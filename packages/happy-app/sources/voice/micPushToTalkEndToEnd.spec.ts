import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTalkTouchStream } from '@/components/talkTouchStream';
import { talkButtonWiring } from '@/components/talkButtonWiring';
import { MOBILE_COMPOSER_METRICS } from '@/components/agentInputLayout';
import {
    DictationCapture,
    RECOGNISER_FINAL,
    type DictationEngine,
} from './dictationCapture';
import { dictationComposerEvents } from './dictationComposer';
import {
    HOLD_MIN_MS,
    idleMicGesture,
    reduceMicGesture,
    type MicButtonState,
    type MicGesture,
    type MicGestureEvent,
} from './micButton';

/**
 * A FINGER ON THE COMPOSER'S MICROPHONE, ALL THE WAY THROUGH (DROVE-269).
 *
 * Clay: "why isn't holding down the microphone doing push to talk like it used
 * to do." It used to, and every piece of it still existed: the reducer in
 * `micButton.ts`, the four props on `AgentInput`, the handlers in
 * `useVoiceComposer`. What DROVE-236 removed and DROVE-264 did not put back was
 * the one thing in between -- a control feeding those props a TOUCH STREAM. The
 * mic had a plain `onPress`, and a press knows nothing about how long a finger
 * was down or where it went.
 *
 * WHY THIS FILE IS AN END-TO-END AND NOT THREE UNIT TESTS. Twice tonight a
 * dictation fix shipped green because its tests drove a signal the real path
 * never sends: DROVE-263's first attempt tested a task boundary the on-device
 * recogniser does not produce, and its second had a case called "from empty"
 * that never passed an empty string. So nothing here calls a handler by name.
 * Every test starts from the events REACT NATIVE DELIVERS to a pressable --
 * `onLayout` with a measured box, `onPressIn`/`onPressOut` carrying
 * `nativeEvent.timestamp`, `onTouchMove` carrying `locationX`/`locationY` --
 * pushes them through the same `createTalkTouchStream` and `talkButtonWiring`
 * the composer spreads, into the same reducer, and into a REAL
 * `DictationCapture` over a hand-driven recogniser. The assertions are on what
 * lands in the composer and on whether it was sent.
 *
 * WHAT IS STILL NOT COVERED, said plainly. vitest runs on node and the suite is
 * `.ts` only, so React itself is never mounted: that the mic's JSX hands these
 * props to that stream is read out of the source at the bottom of this file,
 * and that iOS delivers a touch clock at all is a device check. Both are named
 * in the ticket rather than implied by a green run.
 */

/**
 * The button's real box, so the slide test is measured against what ships.
 * `resolveMobileComposerActionGeometry('mic')` builds its width and height out
 * of this same number; taken as a style it is a `DimensionValue`, and this is
 * the arithmetic one.
 */
const micBox = {
    width: MOBILE_COMPOSER_METRICS.primaryActionSize,
    height: MOBILE_COMPOSER_METRICS.primaryActionSize,
};

/**
 * The native module, driven by hand. Same shape as the one in
 * `dictationContinuity.spec.ts`: the counts are how a test sees the microphone
 * actually opening and closing rather than taking the transcript's word for it.
 */
class FakeRecogniser implements DictationEngine {
    starts = 0;
    stops = 0;
    cancels = 0;
    private stopResolvers: ((text: string) => void)[] = [];

    start(): Promise<unknown> {
        this.starts += 1;
        return Promise.resolve(true);
    }

    stop(): Promise<string> {
        this.stops += 1;
        return new Promise<string>((resolve) => { this.stopResolvers.push(resolve); });
    }

    cancel(): void {
        this.cancels += 1;
    }

    /** The recogniser answering a stop with what it finally heard. */
    settle(text: string): void {
        this.stopResolvers.shift()?.(text);
    }
}

async function flush(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

/**
 * The composer, the capture, the gesture and the button's touch stream, wired
 * exactly as `useVoiceComposer` and `AgentInput` wire them.
 *
 * TWO CLOCKS, ON PURPOSE (DROVE-140). `wall` is what a handler reads with
 * `Date.now()` when the JS thread finally reaches it; `finger` is the OS touch
 * clock stamped when the touch happened. They advance independently here so a
 * test can make the thread lag, which is what turned taps into holds and is the
 * regression the stream has to keep forwarding `touchAt` to prevent.
 */
function harness(base = '') {
    const engine = new FakeRecogniser();
    let wall = 1_000;
    let finger = 500_000;
    let composer = base;
    let draft = base;
    let sends = 0;
    const errors: string[] = [];
    const haptics: string[] = [];
    const states: MicButtonState[] = [];
    const capture = new DictationCapture(engine, dictationComposerEvents({
        base: () => draft,
        current: () => composer,
        setComposerText: (text) => { composer = text; },
        send: () => { sends += 1; },
        onError: (message) => { errors.push(message); },
        onChange: () => { /* the indicator, not the text */ },
    }), () => wall);

    let gesture: MicGesture = idleMicGesture;
    /** When the hold timer would fire, or null when none is pending. */
    let holdDueAt: number | null = null;

    /** The effect switch out of `useVoiceComposer.dispatch`, minus read-aloud. */
    function dispatch(event: MicGestureEvent): void {
        if (event.type === 'pressOut' || event.type === 'ended') holdDueAt = null;
        const step = reduceMicGesture(gesture, event);
        gesture = step.next;
        states.push(step.next.state);
        for (const effect of step.effects) {
            switch (effect) {
                case 'open':
                    draft = composer;
                    capture.begin('hold');
                    haptics.push('light');
                    break;
                case 'watchHold':
                    // `setTimeout` counts REAL time, so this is the finger's
                    // clock. A jammed thread delays the callback; it does not
                    // move the deadline.
                    holdDueAt = finger + HOLD_MIN_MS;
                    break;
                case 'latch': capture.latch(); break;
                case 'send': capture.send(); break;
                case 'stop': capture.stop(); break;
                case 'cancel': capture.cancel(); break;
                case 'tick': haptics.push('selection'); break;
            }
        }
    }

    // The composer's own two lines: the three handlers by reference, and one
    // stream over them.
    const wiring = talkButtonWiring({
        onTalkPressIn: (touchAt) => dispatch({ type: 'pressIn', at: wall, touchAt }),
        onTalkPressOut: (touchAt) => dispatch({ type: 'pressOut', at: wall, touchAt }),
        onTalkSlide: (inside) => dispatch({ type: 'slide', inside }),
    });
    const stream = createTalkTouchStream(() => wiring);

    // The layout React Native reports once the button has been measured.
    stream.view.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: micBox.width, height: micBox.height } },
    } as never);

    /** Both clocks move together unless a test says otherwise. */
    function advance(ms: number, threadLag = 0): void {
        finger += ms;
        wall += ms + threadLag;
        if (holdDueAt !== null && finger >= holdDueAt) {
            holdDueAt = null;
            dispatch({ type: 'holdConfirm' });
        }
    }

    const centre = { x: micBox.width / 2, y: micBox.height / 2 };

    return {
        engine,
        capture,
        errors,
        haptics,
        states,
        get composer() { return composer; },
        get sends() { return sends; },
        get micState(): MicButtonState { return gesture.state; },
        /** The touch clock right now, for stamping a lift by hand. */
        get now(): number { return finger; },
        advance,
        /** Type into the field between gestures, as a thumb would. */
        type(text: string) { composer = text; },
        /** Finger down on the button, at its centre. */
        down(at: { x: number; y: number } = centre) {
            stream.press.onPressIn({ nativeEvent: { timestamp: finger, ...at } } as never);
        },
        /** The finger moving, still down. Coordinates are button-relative. */
        move(at: { x: number; y: number }) {
            stream.view.onTouchMove({
                nativeEvent: { timestamp: finger, locationX: at.x, locationY: at.y },
            } as never);
        },
        /** Finger up. */
        up() {
            stream.press.onPressOut({ nativeEvent: { timestamp: finger } } as never);
        },
        /**
         * Finger up whose EVENT is processed now but whose STAMP is the
         * touch's own, earlier time: a lift the main thread sat on before
         * delivering (DROVE-293). RN stamps `nativeEvent.timestamp` when the
         * touch happened, not when JS gets the callback, so the stamp
         * survives however late the delivery is.
         */
        upStamped(stamp: number) {
            stream.press.onPressOut({ nativeEvent: { timestamp: stamp } } as never);
        },
        /** A press-in whose touch clock the platform did not stamp (web). */
        downWithNoTouchClock() {
            stream.press.onPressIn({ nativeEvent: {} } as never);
        },
        upWithNoTouchClock() {
            stream.press.onPressOut({ nativeEvent: {} } as never);
        },
    };
}

/** Well past the point where a press is a hold. */
const holdFor = HOLD_MIN_MS + 400;
/** Well inside the tap window. */
const tapFor = 120;

describe('press and hold, released on the button (DROVE-269)', () => {
    it('opens the mic on the press, not on the lift', async () => {
        const h = harness();
        h.down();
        await flush();
        // The whole point of starting on the press: a hold never misses the
        // first word, and a tap costs no extra latency.
        expect(h.engine.starts).toBe(1);
        expect(h.capture.current.active).toBe(true);
        expect(h.micState).toBe('held');
    });

    it('sends what was said when the finger lifts on the button', async () => {
        const h = harness();
        h.down();
        await flush();
        h.capture.partial('ship the login fix');
        h.advance(holdFor);
        h.up();
        await flush();
        h.engine.settle('ship the login fix');
        await flush();

        expect(h.composer).toBe('ship the login fix');
        expect(h.sends).toBe(1);
        expect(h.micState).toBe('idle');
        expect(h.capture.current.active).toBe(false);
    });

    it('appends to what was already typed rather than replacing it', async () => {
        const h = harness('draft: ');
        h.down();
        await flush();
        h.capture.partial('and then merge it');
        h.advance(holdFor);
        h.up();
        await flush();
        h.engine.settle('and then merge it');
        await flush();
        expect(h.composer).toBe('draft: and then merge it');
        expect(h.sends).toBe(1);
    });

    it('is decided on the OS touch clock, so a lagging thread cannot fake a hold', async () => {
        // The exact failure `talkTouchStream` exists to make unrepeatable: a
        // wrapper that drops `touchAt` leaves the reducer subtracting two
        // JS-thread readings, and press-in is the busiest moment this screen
        // has. 120 ms on the finger, 900 ms of thread lag around it.
        const h = harness();
        h.down();
        await flush();
        h.advance(tapFor, 900);
        h.up();
        await flush();

        expect(h.micState).toBe('latched');
        expect(h.sends).toBe(0);
        expect(h.capture.current.active).toBe(true);
    });

    it('still reads a long hold as a hold when the platform stamps no touch clock', async () => {
        // Web synthesises these events. The wall clock is the documented
        // fallback, and it must not be reachable while a touch clock exists.
        const h = harness();
        h.downWithNoTouchClock();
        await flush();
        h.advance(holdFor);
        h.upWithNoTouchClock();
        await flush();
        h.engine.settle('sent from the browser');
        await flush();
        expect(h.sends).toBe(1);
    });
});

describe('a tap still latches, and the next tap still stops (DROVE-269 adds, it does not replace)', () => {
    it('latches the mic open and leaves it open after the lift', async () => {
        const h = harness();
        h.down();
        await flush();
        h.advance(tapFor);
        h.up();
        await flush();

        expect(h.micState).toBe('latched');
        expect(h.capture.current.active).toBe(true);
        expect(h.capture.current.mode).toBe('latch');
        expect(h.sends).toBe(0);
    });

    it('the next tap stops it with the words in the composer, unsent', async () => {
        const h = harness();
        h.down();
        await flush();
        h.advance(tapFor);
        h.up();
        await flush();

        h.capture.partial('leave this one for me to read');
        h.advance(3_000);
        h.down();
        h.advance(tapFor);
        h.up();
        await flush();
        h.engine.settle('leave this one for me to read');
        await flush();

        expect(h.composer).toBe('leave this one for me to read');
        expect(h.sends).toBe(0);
        expect(h.micState).toBe('idle');
    });

    it('a HOLD on a latched mic stops it too, and does not send', async () => {
        // The reducer's latched branch has no hold timer, so how long the
        // finger stays down cannot change what the lift means. Worth pinning:
        // the natural mistake when adding a hold is to make it send from any
        // state, which would send a latch he opened to think in.
        const h = harness();
        h.down();
        h.advance(tapFor);
        h.up();
        await flush();

        h.capture.partial('still thinking about it');
        h.down();
        h.advance(holdFor);
        h.up();
        await flush();
        h.engine.settle('still thinking about it');
        await flush();

        expect(h.composer).toBe('still thinking about it');
        expect(h.sends).toBe(0);
    });
});

describe('a lift the platform never delivers cannot arm a send (DROVE-286)', () => {
    /**
     * THE PHONE'S OWN EVENT STREAM, not the spec's ideal one. Clay: "not if I
     * tap and then talk and then tap again" -- and the app was sending exactly
     * there. The tap-latch-tap case above PASSES, and the phone still
     * misbehaved, which is the DROVE-263 trap a third time: the spec drove a
     * PAIRED press the device does not always deliver.
     *
     * WHERE THE LIFT GOES. The mic's press-in turns the bare glyph into the
     * red disc, and ComposerControlButton answered that by swapping component
     * type -- BubblePressable out, GlassChromeButton in -- which unmounts the
     * pressable UNDER THE FINGER. React Native fires no onPressOut for a
     * press whose responder was unmounted, so the opening tap's lift dies
     * with the old view. The reducer is left in 'held' over a phantom finger,
     * the hold timer confirms a hold nobody is making, and the CLOSING tap's
     * lift then reads as a push-to-talk release and SENDS. The same stream
     * describes a lost push-to-talk lift, so this one test covers both ways
     * the phone can eat a release.
     *
     * So this test replays what the device actually sends: a pressIn, NO
     * pressOut, the hold timer firing, then one whole closing tap.
     */
    it('the closing tap stops and keeps the words when the opening lift was eaten', async () => {
        const h = harness();
        h.down();
        await flush();
        // No h.up(): that is the event the remount ate. The hold timer fires
        // over a finger that is long gone, and with the lift lost nothing
        // contradicts it.
        h.advance(HOLD_MIN_MS + 100);
        h.capture.partial('read this back before it goes anywhere');
        h.advance(3_000);
        // The closing tap, delivered whole: the face does not change on this
        // press, so nothing remounts under the finger.
        h.down();
        h.advance(tapFor);
        h.up();
        await flush();
        h.engine.settle('read this back before it goes anywhere');
        await flush();

        // The contract, in his words: "not if I tap and then talk and then
        // tap again". Nothing sent, every word kept (DROVE-263: stopping may
        // never shorten what was heard), mic closed.
        expect(h.sends).toBe(0);
        expect(h.composer).toBe('read this back before it goes anywhere');
        expect(h.micState).toBe('idle');
        expect(h.capture.current.active).toBe(false);
    });

    it('the recovery press itself turns the capture into a latch, idle clock running', async () => {
        // The press-in is the moment the reducer learns the first lift was
        // lost, and the capture must become a LATCH there and then: the mode
        // flips and the idle clock starts, so a mic nobody is holding cannot
        // sit hot forever (DROVE-74's deadline applies to it).
        const h = harness();
        h.down();
        await flush();
        h.advance(HOLD_MIN_MS + 100);
        h.capture.partial('still being said');
        h.advance(1_000);
        h.down();
        expect(h.capture.current.mode).toBe('latch');
        expect(h.capture.current.idleAt).not.toBeNull();
        expect(h.micState).toBe('latched');
    });

    it('a closing tap that slides off still cancels, lost lift or not', async () => {
        // The slide-off promise holds on the recovery path too: the closing
        // press dragged off the button is the voice-note cancel, not a stop.
        const h = harness();
        h.down();
        await flush();
        h.advance(HOLD_MIN_MS + 100);
        h.capture.partial('thrown away on purpose');
        h.advance(1_000);
        h.down();
        h.move({ x: micBox.width + 40, y: micBox.height / 2 });
        h.advance(tapFor);
        h.up();
        await flush();

        expect(h.sends).toBe(0);
        expect(h.composer).toBe('');
        expect(h.micState).toBe('idle');
    });
});

describe('a lift delivered late is still a tap: the finger clock outranks the timer (DROVE-293)', () => {
    /**
     * THE STREAM 286'S HOIST ACTUALLY DELIVERS, one OTA later. Clay, an hour
     * after DROVE-286 shipped: "hold and press to talk is working but when I
     * tap it once to talk is not working correctly... it just doesn't
     * activate."
     *
     * The tap cases above drive the pair PROMPTLY: the lift is processed
     * milliseconds after the finger rose, and the reducer latches. The phone
     * does not always deliver it that way. Press-in is the busiest moment
     * the composer has -- it mounts the red glass disc, the banner and the
     * waveform, and the recogniser's start flips the audio session's
     * category -- and that work sits on the very main thread that must
     * deliver touchesEnded. The finger rises at 80ms; the EVENT reaches JS
     * after HOLD_MIN_MS, by which time the hold timer has confirmed a hold
     * nobody is making.
     *
     * The late lift still carries the proof. RN stamps
     * `nativeEvent.timestamp` with the touch's own time (BaseTouch.cpp puts
     * UITouch's seconds into ms), so the stamp says 80ms however late the
     * delivery. Today's reducer reads `confirmed ||` first and never looks:
     * the tap takes the send arm, a zero-length push-to-talk -- opened,
     * instantly closed, whatever was heard SENT. From outside, "it just
     * doesn't activate".
     *
     * Before 286 this stream could not occur: the remount ate the lift
     * entirely, which is the only reason tap-to-latch ever worked on device.
     * 286 made lifts arrive, and the first thing a late one met was the
     * timer's verdict. The DROVE-286 cases above stay: a lift can still be
     * lost outright, and the recovery arm is theirs.
     */
    it('latches a single tap whose lift arrives after the hold timer fired', async () => {
        const h = harness();
        const pressed = h.now;
        h.down();
        await flush();
        // Real time passes with the finger already up: the delivery is
        // jammed behind press-in's own work, and the hold timer fires over
        // a finger that rose at 80ms.
        h.advance(HOLD_MIN_MS + 100);
        h.upStamped(pressed + 80);
        await flush();

        expect(h.micState).toBe('latched');
        expect(h.capture.current.active).toBe(true);
        expect(h.capture.current.mode).toBe('latch');
        // Still listening: the tap neither sent nor stopped the recogniser.
        expect(h.engine.stops).toBe(0);
        expect(h.sends).toBe(0);
    });

    it('the closing tap after a late-lift latch stops, words kept, unsent', async () => {
        const h = harness();
        const pressed = h.now;
        h.down();
        await flush();
        h.advance(HOLD_MIN_MS + 100);
        h.upStamped(pressed + 80);
        await flush();

        // He talks into what he rightly believes is a latched mic.
        h.capture.partial('do not send this until I read it');
        h.advance(2_000);
        // The closing tap, delivered promptly: nothing jams the thread now.
        h.down();
        h.advance(tapFor);
        h.up();
        await flush();
        h.engine.settle('do not send this until I read it');
        await flush();

        expect(h.sends).toBe(0);
        expect(h.composer).toBe('do not send this until I read it');
        expect(h.micState).toBe('idle');
        expect(h.capture.current.active).toBe(false);
    });

    it('a hold whose lift is delivered late still sends: the stamp says hold', async () => {
        // The do-not-regress half. A real hold's lift can be delivered late
        // too, and its stamp then says the finger was down past HOLD_MIN_MS,
        // which is what decides: the send survives on the same evidence that
        // refuses the tap.
        const h = harness();
        const pressed = h.now;
        h.down();
        await flush();
        h.capture.partial('send this one');
        h.advance(HOLD_MIN_MS + 700);
        h.upStamped(pressed + HOLD_MIN_MS + 600);
        await flush();
        h.engine.settle('send this one');
        await flush();

        expect(h.sends).toBe(1);
        expect(h.composer).toBe('send this one');
        expect(h.micState).toBe('idle');
    });
});

describe('sliding off before the lift cancels (DROVE-269)', () => {
    it('throws the recording away and puts the composer back', async () => {
        const h = harness('half a sentence');
        h.down();
        await flush();
        h.capture.partial('scratch that');
        expect(h.composer).not.toBe('half a sentence');

        h.advance(holdFor);
        // Off the button's right edge, past the slop.
        h.move({ x: micBox.width + 40, y: micBox.height / 2 });
        h.up();
        await flush();

        expect(h.engine.cancels).toBe(1);
        expect(h.composer).toBe('half a sentence');
        expect(h.sends).toBe(0);
        expect(h.micState).toBe('idle');
    });

    it('cancels a TAP that slid off too: nobody drags off a button they meant to latch', async () => {
        const h = harness();
        h.down();
        await flush();
        h.advance(tapFor);
        h.move({ x: -60, y: 0 });
        h.up();
        await flush();

        expect(h.micState).toBe('idle');
        expect(h.capture.current.active).toBe(false);
        expect(h.engine.cancels).toBe(1);
    });

    it('does not cancel on a wobble inside the slop, which a two-second hold has', async () => {
        const h = harness();
        h.down();
        await flush();
        h.capture.partial('a long one');
        h.advance(holdFor);
        // Just past the edge but inside CANCEL_SLOP: a thumb resettling.
        h.move({ x: micBox.width + 8, y: micBox.height + 8 });
        h.up();
        await flush();
        h.engine.settle('a long one');
        await flush();

        expect(h.engine.cancels).toBe(0);
        expect(h.sends).toBe(1);
    });

    it('cancels even when the platform reports the lift before the slide', async () => {
        // Pressability drops the press when the finger leaves its press rect,
        // which is wider than CANCEL_SLOP, so the crossing is normally seen
        // first. This pins the other order anyway: an early `onPressOut` with
        // no crossing behind it must not send.
        const h = harness();
        h.down();
        await flush();
        h.capture.partial('do not send this');
        h.advance(holdFor);
        h.up();
        h.move({ x: micBox.width + 200, y: 0 });
        await flush();

        // Nothing was sent by the lift itself; the transcript went to the
        // composer rather than to the wire.
        expect(h.sends).toBe(0);
    });
});

/**
 * THE TRAP THAT CAUSED THE ORIGINAL COLLAPSE (DROVE-236, checked not assumed).
 *
 * DROVE-236 wrote its longest comment about `captureOpen` having to outrank the
 * composer's contents: dictation partials land in the field MID-WORD, the one
 * morphing button re-resolved its face from that text, and it flipped to Send
 * under his thumb mid-sentence. DROVE-264 argued the split makes that guard
 * unnecessary because two separate controls cannot flip into each other.
 *
 * That argument is about the FACE. Restoring the hold makes it about the
 * GESTURE too, because now there is a finger down for seconds while those
 * partials arrive. So both halves are checked here: the words landing in the
 * field change nothing about what the button is, and nothing about what its
 * lift will do.
 */
describe('the mic cannot change identity under a held finger', () => {
    it('runs an identical gesture whether the composer is empty or filling up', async () => {
        async function run(fill: boolean) {
            const h = harness(fill ? 'typed first' : '');
            h.down();
            await flush();
            if (fill) {
                // Every one of these is a partial landing mid-word, which is
                // the shape DROVE-236 named.
                h.capture.partial('so');
                h.capture.partial('so we sh');
                h.capture.partial('so we should');
            }
            h.advance(holdFor);
            h.up();
            await flush();
            h.engine.settle(fill ? 'so we should' : '');
            await flush();
            return h;
        }
        const empty = await run(false);
        const filling = await run(true);
        expect(filling.states).toEqual(empty.states);
        expect(filling.haptics).toEqual(empty.haptics);
        // And the one that had words sent them.
        expect(filling.sends).toBe(1);
        expect(filling.composer).toBe('typed first so we should');
    });

    it('keeps the button held for the whole hold, however the text moves', async () => {
        const h = harness();
        h.down();
        await flush();
        h.capture.partial('one');
        h.advance(200);
        h.capture.partial('one two');
        h.advance(200);
        h.type('a thumb typing in the middle of a capture');
        h.advance(holdFor);
        h.capture.partial('one two three');
        h.up();
        await flush();
        h.engine.settle('one two three');
        await flush();

        // Held from the press to the lift, then idle. Never latched, never
        // anything the composer's contents could have made it.
        expect(h.states).toEqual(['held', 'held', 'idle']);
        expect(h.sends).toBe(1);
    });
});

/**
 * DROVE-263, ON THIS GESTURE (the invariant that must not weaken).
 *
 * `requiresOnDeviceRecognition = true` means the recogniser never finalises on
 * a pause: it keeps ONE task and opens a new RESULT SEQUENCE from empty. So the
 * signal a real pause sends mid-hold is a partial that is suddenly SHORTER, and
 * often an empty one. A hold is exactly the gesture that spans a pause, so it
 * is the gesture that has to survive it.
 */
describe('a hold that spans a pause keeps everything, and the lift sends all of it', () => {
    it('survives the empty partial the on-device recogniser opens a sequence with', async () => {
        const h = harness();
        h.down();
        await flush();
        h.capture.partial('so the thing I wanted to say');
        h.advance(1_800);
        // The pause. A new result sequence, reported from nothing.
        h.capture.partial('');
        h.capture.partial('is that');
        h.capture.partial('is that it should ship tonight');
        h.advance(holdFor);
        h.up();
        await flush();
        h.engine.settle('is that it should ship tonight');
        await flush();

        expect(h.composer).toBe('so the thing I wanted to say is that it should ship tonight');
        expect(h.sends).toBe(1);
    });

    it('survives a recogniser that does finalise, on the builds where it does', async () => {
        const h = harness();
        h.down();
        await flush();
        h.capture.partial('first half');
        h.advance(4_000);
        h.capture.recogniserEnded('first half', RECOGNISER_FINAL);
        await flush();
        // The microphone is still open under the finger, and reopened.
        expect(h.capture.current.active).toBe(true);
        expect(h.engine.starts).toBe(2);
        expect(h.micState).toBe('held');

        h.capture.partial('second half');
        h.advance(holdFor);
        h.up();
        await flush();
        h.engine.settle('second half');
        await flush();

        expect(h.composer).toBe('first half second half');
        expect(h.sends).toBe(1);
    });
});

const sourcesRoot = resolve(__dirname, '..');

function read(relative: string): string {
    return readFileSync(join(sourcesRoot, relative), 'utf8');
}

/**
 * The wiring, read out of the composer (DROVE-210, DROVE-235's precedent).
 *
 * vitest cannot mount the button, so the last link is asserted against the
 * source. Coarse, and it catches the exact class of regression this ticket is
 * about: a mic whose props never reach the stream above, which is how the
 * gesture came to be missing in the first place.
 */
describe('the composer hands the mic the touch stream (DROVE-269)', () => {
    const agentInput = read('components/AgentInput.tsx');

    it('spreads both halves of the stream onto the mic', () => {
        expect(agentInput).toContain('{...micTouch.view}');
        expect(agentInput).toContain('{...micTouch.press}');
        expect(agentInput).toContain('const micTouch = useTalkTouchStream(talkWiring);');
    });

    it('builds the three handlers by reference, never through a lambda', () => {
        // A zero-argument arrow is assignable to `(touchAt?: number) => void`,
        // so nothing but this catches a wrapper that drops the touch clock.
        expect(agentInput).toContain('onTalkPressIn: props.onTalkPressIn');
        expect(agentInput).not.toContain('onTalkPressIn?.()');
        expect(agentInput).not.toContain('props.onTalkPressIn()');
    });

    it('binds no bare press on the mic, which would fight the lift', () => {
        expect(agentInput).not.toContain('onPress={handleMobileMicPress}');
        expect(agentInput).not.toContain('onPress={() => props.onTalkTap');
    });

    it('draws the mic from the recogniser and its own state, never from the composer', () => {
        // The DROVE-236 trap, pinned in the source as well as in the gesture:
        // neither the button's existence nor its surface may read the text.
        expect(agentInput).toContain('const canDictateHere = compactMobileComposer && !!talkWiring;');
        expect(agentInput).toContain('const micSurface = composerMicSurface({ live: micLive });');
        expect(agentInput).toContain("const micLive = props.talkState === 'latched' || props.talkState === 'held';");
    });

    it('leaves the two talk buttons on one stream, so they cannot drift', () => {
        const talkButton = read('components/TalkButton.tsx');
        expect(talkButton).toContain('{...stream.view}');
        expect(talkButton).toContain('{...stream.press}');
    });

    it('owns the gesture on a pressable the face flip cannot unmount (DROVE-286)', () => {
        // ComposerControlButton swaps component type with its fill, and the
        // mic's press-in is what turns the fill red: a press stream spread on
        // that control is unmounted mid-press, and the opening lift dies with
        // it, which is how the closing tap came to send. The stream must sit
        // on a plain Pressable that outlives the face, with the face behind
        // pointerEvents="none" so no press ever rides on the part that
        // remounts.
        const mic = agentInput.slice(
            agentInput.indexOf('const mobileMicAction'),
            agentInput.indexOf('const mobileSessionControls'),
        );
        expect(mic).toContain('<Pressable');
        expect(mic).toContain('{...micTouch.press}');
        expect(mic).toContain('<View pointerEvents="none"');
        // The press lands on the Pressable, before the decoration ever
        // appears; nothing presses the face itself any more.
        expect(mic.indexOf('{...micTouch.press}')).toBeGreaterThan(mic.indexOf('<Pressable'));
        expect(mic.indexOf('{...micTouch.press}')).toBeLessThan(mic.indexOf('<ComposerControlButton'));
    });
});
