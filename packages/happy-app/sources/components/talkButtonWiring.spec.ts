import { describe, expect, it, vi } from 'vitest';
import { talkButtonWiring } from './talkButtonWiring';

/**
 * The case DROVE-210 was: the composer wrapped every talk handler in an arrow
 * that took no arguments, so the OS touch clock DROVE-140 threaded all the way
 * down was thrown away one layer above the reducer. TypeScript is blind to it,
 * a zero-argument function being assignable to a one-optional-argument
 * signature, so the guarantee has to be a test.
 */
describe('talkButtonWiring', () => {
    it('carries the touch clock through press-in', () => {
        const onTalkPressIn = vi.fn();
        talkButtonWiring({ onTalkPressIn })?.onPressIn(41287.5);
        expect(onTalkPressIn).toHaveBeenCalledWith(41287.5);
    });

    it('carries the touch clock through the lift', () => {
        const onTalkPressIn = vi.fn();
        const onTalkPressOut = vi.fn();
        talkButtonWiring({ onTalkPressIn, onTalkPressOut })?.onPressOut(41287.65);
        expect(onTalkPressOut).toHaveBeenCalledWith(41287.65);
    });

    it('passes a platform with no touch clock through as undefined', () => {
        // Web synthesises press events with no usable timestamp. The reducer
        // handles that; what it must not get is a number that was silently
        // dropped and one that was never there looking the same.
        const onTalkPressIn = vi.fn();
        talkButtonWiring({ onTalkPressIn })?.onPressIn(undefined);
        expect(onTalkPressIn).toHaveBeenCalledWith(undefined);
    });

    it('carries which side of the edge the finger crossed to', () => {
        const onTalkPressIn = vi.fn();
        const onTalkSlide = vi.fn();
        const wiring = talkButtonWiring({ onTalkPressIn, onTalkSlide });
        wiring?.onSlide(false);
        wiring?.onSlide(true);
        expect(onTalkSlide.mock.calls).toEqual([[false], [true]]);
    });

    it('is the same function objects the props carry, not wrappers', () => {
        // The structural half of the fix: identity here is what makes a
        // dropped argument impossible rather than merely tested for.
        const onTalkPressIn = vi.fn();
        const onTalkPressOut = vi.fn();
        const wiring = talkButtonWiring({ onTalkPressIn, onTalkPressOut });
        expect(wiring?.onPressIn).toBe(onTalkPressIn);
        expect(wiring?.onPressOut).toBe(onTalkPressOut);
    });

    it('has no button at all without a press-in', () => {
        expect(talkButtonWiring({})).toBeNull();
        expect(talkButtonWiring({ onTalkPressOut: vi.fn(), onTalkSlide: vi.fn() })).toBeNull();
    });

    it('fills in a missing lift and slide rather than drawing half a button', () => {
        const wiring = talkButtonWiring({ onTalkPressIn: vi.fn() });
        expect(() => {
            wiring?.onPressOut(1);
            wiring?.onSlide(false);
        }).not.toThrow();
    });
});
