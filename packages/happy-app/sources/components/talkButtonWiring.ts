/**
 * The composer's half of the talk button's wiring (DROVE-210).
 *
 * WHY THIS FILE EXISTS. DROVE-140 found that the tap-versus-hold split was
 * measured on the JS thread rather than on the finger, and fixed it by
 * carrying the OS's touch clock (`nativeEvent.timestamp`) from TalkButton
 * down to the reducer. It widened every signature on the way,
 * `() => void` becoming `(touchAt?: number) => void`, and it widened
 * AgentInput's props too. What it did not touch was the one line of JSX that
 * actually calls them, written a lane earlier as
 *
 *     onPressIn={() => props.onTalkPressIn?.()}
 *
 * A zero-argument arrow is assignable to a one-optional-argument signature,
 * so TypeScript had nothing to say, and the wrapper silently dropped the
 * timestamp on the floor. Every press reached the reducer with `touchAt`
 * undefined, `pressElapsed` fell back to the `Date.now()` difference, and the
 * measurement was the JS-thread interval DROVE-140 had just removed. The fix
 * shipped; it never reached the phone.
 *
 * No type can catch a dropped parameter, so the guarantee is structural
 * instead: the handlers are built HERE, once, by reference, and the JSX
 * spreads what this returns. A wrapper cannot be added at the call site
 * because there is no longer a call site to add one to, and this module is
 * pure, so the forwarding is a case in a spec rather than a thing to notice
 * in review.
 */

export interface TalkHandlerProps {
    onTalkPressIn?: (touchAt?: number) => void;
    onTalkPressOut?: (touchAt?: number) => void;
    onTalkSlide?: (inside: boolean) => void;
}

export interface TalkButtonWiring {
    onPressIn: (touchAt?: number) => void;
    onPressOut: (touchAt?: number) => void;
    onSlide: (inside: boolean) => void;
}

/**
 * The three handlers TalkButton needs, or null when this surface has no
 * dictation at all.
 *
 * `onTalkPressIn` alone decides whether the button exists: a press-in with no
 * lift behind it would leave the mic open with no way to close it, so the
 * other two are filled in with no-ops rather than the button being drawn half
 * wired.
 */
export function talkButtonWiring(props: TalkHandlerProps): TalkButtonWiring | null {
    const pressIn = props.onTalkPressIn;
    if (!pressIn) return null;
    const pressOut = props.onTalkPressOut;
    const slide = props.onTalkSlide;
    return {
        onPressIn: pressIn,
        onPressOut: pressOut ? pressOut : () => { },
        onSlide: slide ? slide : () => { },
    };
}
