import * as React from 'react';
import type { GestureResponderEvent, LayoutChangeEvent } from 'react-native';
import { isInsideTalkButton } from '@/voice/micButton';
import type { TalkButtonWiring } from './talkButtonWiring';

/**
 * The four touch handlers push-to-talk needs, as prop BAGS to be spread
 * (DROVE-269, extracted from TalkButton.tsx).
 *
 * WHY THIS IS A MODULE AND NOT A LAMBDA AT THE CALL SITE. `talkButtonWiring`
 * exists because DROVE-140 widened `() => void` to `(touchAt?: number) => void`
 * and the one line of JSX that called it kept forwarding nothing; a
 * zero-argument arrow is assignable to a one-optional-argument signature, so
 * nothing complained and every press reached the reducer with the JS-thread
 * clock DROVE-140 had just removed. That guarantee only covered the three
 * handlers' identity. The mechanics ABOVE them -- reading
 * `nativeEvent.timestamp`, measuring the button, deciding a slide crossed the
 * edge -- lived inside TalkButton, so a second button wanting the same gesture
 * had to reimplement them and could get any of it subtly wrong.
 *
 * So they live here once, and what a component gets back is two objects it
 * SPREADS. There is no call site to add a wrapper to, and no parameter for a
 * wrapper to drop: `{...stream.press}` either forwards the OS touch clock or
 * does not compile.
 *
 * WHY THE SLIDE IS MEASURED HERE AND NOT IN THE VOICE HOOK. It is a fact about
 * one rectangle and nothing above it needs to know where a finger is:
 * `onPressOut` alone says the finger went up, never where. Touch coordinates
 * are relative to the view the touch started in, so this is the button's own
 * measured box with slop, and no window measuring.
 */
export interface TalkTouchStream {
    /**
     * Spread onto the view that OWNS the button's rectangle. `onLayout` is
     * what the inside test is measured against, and touch events bubble to it
     * from the pressable inside.
     */
    view: {
        onLayout: (event: LayoutChangeEvent) => void;
        onTouchMove: (event: GestureResponderEvent) => void;
    };
    /** Spread onto the pressable inside that view. */
    press: {
        onPressIn: (event: GestureResponderEvent) => void;
        onPressOut: (event: GestureResponderEvent) => void;
    };
}

/**
 * The touch's own timestamp, or undefined when the platform did not give one
 * (DROVE-140).
 *
 * `Date.now()` read inside a handler is the time the JS thread REACHED it, and
 * press-in is the busiest moment the composer has: it interrupts read-aloud,
 * reads the draft, starts the recogniser and mounts the banner. That lag lands
 * inside the tap-versus-hold interval and turned short presses into holds.
 * `nativeEvent.timestamp` is stamped when the finger moved.
 *
 * Guarded rather than assumed: web synthesises these events, and a missing or
 * zero stamp must fall back to the wall clock rather than read as an
 * instantaneous press.
 */
export function touchTime(event: GestureResponderEvent): number | undefined {
    const stamp = event?.nativeEvent?.timestamp;
    return typeof stamp === 'number' && stamp > 0 ? stamp : undefined;
}

/**
 * The stream, reading its wiring through `read` on every event.
 *
 * Late-bound on purpose: the handlers this returns keep one identity for the
 * life of the button, so a re-render cannot swap them mid-gesture and lose the
 * press-in that is still down, while the wiring underneath is free to change
 * identity with the screen. `null` from `read` is a surface with no dictation
 * at all, and every event on it is dropped rather than half-dispatched.
 */
export function createTalkTouchStream(read: () => TalkButtonWiring | null): TalkTouchStream {
    let size = { width: 0, height: 0 };
    // A press begins inside by definition; the first crossing is what reports.
    let inside = true;
    return {
        view: {
            onLayout: (event: LayoutChangeEvent) => {
                const { width, height } = event.nativeEvent.layout;
                size = { width, height };
            },
            onTouchMove: (event: GestureResponderEvent) => {
                const { locationX, locationY } = event.nativeEvent;
                const next = isInsideTalkButton({ x: locationX, y: locationY }, size);
                // One call per CROSSING, not per move: the reducer ticks a
                // haptic on each, and a tick per pixel is not a signal.
                if (next === inside) return;
                inside = next;
                read()?.onSlide(next);
            },
        },
        press: {
            onPressIn: (event: GestureResponderEvent) => {
                inside = true;
                read()?.onPressIn(touchTime(event));
            },
            onPressOut: (event: GestureResponderEvent) => {
                read()?.onPressOut(touchTime(event));
            },
        },
    };
}

/**
 * One stream for the life of the component, pointed at the current wiring.
 *
 * The ref-then-create shape rather than a `useMemo`: a memo that re-ran would
 * throw away the measured box and the inside flag, which are the two things a
 * gesture in flight is made of.
 */
export function useTalkTouchStream(wiring: TalkButtonWiring | null): TalkTouchStream {
    const latest = React.useRef(wiring);
    latest.current = wiring;
    const stream = React.useRef<TalkTouchStream | null>(null);
    if (stream.current === null) {
        stream.current = createTalkTouchStream(() => latest.current);
    }
    return stream.current;
}
