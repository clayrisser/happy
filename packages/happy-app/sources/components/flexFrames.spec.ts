import { describe, expect, it } from 'vitest';
import { FlexFrame, FlexNode, resolveFlexFrames, roundedRectClearance } from './flexFrames';

/**
 * The resolver checked against YOGA, the engine React Native actually runs.
 *
 * A resolver that quietly approximates would be the same failure this ticket
 * is about: a green suite over a layout nobody measured. So the expected
 * frames below are not hand-derived. They are what `yoga-layout@3.2.1` prints
 * for the identical trees, captured once and pinned here.
 *
 * Yoga is not a dependency of this package — it arrives transitively and is not
 * declared — so the comparison is not run in CI. Re-run it by hand against a
 * real Yoga build if this resolver ever grows a case.
 */

function flatten(frame: FlexFrame, out: FlexFrame[] = []): FlexFrame[] {
    out.push(frame);
    frame.children.forEach((child) => flatten(child, out));
    return out;
}

function shape(node: FlexNode, width: number) {
    return flatten(resolveFlexFrames(node, width))
        .map((f) => `${f.name} ${f.x},${f.y} ${f.width}x${f.height}`);
}

const composer = (text: number, withAdd = true): FlexNode => ({
    name: 'bubble',
    style: { flexDirection: 'column', alignItems: 'stretch', padding: 9, gap: 6 },
    children: [
        {
            name: 'textRow',
            style: { width: '100%', minHeight: 30, maxHeight: 128, paddingTop: 4, paddingBottom: 4 },
            intrinsicHeight: text,
        },
        {
            name: 'actionRow',
            style: {
                flexDirection: 'row', alignItems: 'center',
                justifyContent: 'flex-start', width: '100%', height: 36,
            },
            children: [
                ...(withAdd ? [{ name: 'add', style: { width: 36, height: 36 } }] : []),
                { name: 'spacer', style: { flex: 1 } },
                { name: 'send', style: { width: 36, height: 36 } },
            ],
        },
    ],
});

describe('flexFrames agrees with Yoga', () => {
    it('resolves the empty composer exactly as Yoga does', () => {
        expect(shape(composer(22), 373)).toEqual([
            'bubble 0,0 373x90',
            'textRow 9,9 355x30',
            'actionRow 9,45 355x36',
            'add 9,45 36x36',
            'spacer 45,63 283x0',
            'send 328,45 36x36',
        ]);
    });

    it('grows the text row and moves the button row down with it', () => {
        expect(shape(composer(88), 373)).toEqual([
            'bubble 0,0 373x156',
            'textRow 9,9 355x96',
            'actionRow 9,111 355x36',
            'add 9,111 36x36',
            'spacer 45,129 283x0',
            'send 328,111 36x36',
        ]);
    });

    it('caps the text row and stops growing', () => {
        expect(shape(composer(400), 373)).toEqual([
            'bubble 0,0 373x188',
            'textRow 9,9 355x128',
            'actionRow 9,143 355x36',
            'add 9,143 36x36',
            'spacer 45,161 283x0',
            'send 328,143 36x36',
        ]);
    });

    it('lets the spacer take the whole row when the `+` is not drawn', () => {
        expect(shape(composer(22, false), 373)).toEqual([
            'bubble 0,0 373x90',
            'textRow 9,9 355x30',
            'actionRow 9,45 355x36',
            'spacer 9,63 319x0',
            'send 328,45 36x36',
        ]);
    });

    it('sizes a container with no width to its CONTENT, as a flex item does', () => {
        // DROVE-231's addition, and the branch DROVE-214's tree never reached:
        // every node in the composer carries a width or a flex, so a row that
        // had to measure itself did not exist there. The status strip's zones
        // do, and a zone that took `available` would swallow the whole line.
        expect(shape({
            name: 'row',
            style: { flexDirection: 'row', alignItems: 'center' },
            children: [
                { name: 'auto', style: { flexDirection: 'row', gap: 3 }, children: [
                    { name: 'a', style: { width: 24, height: 11 } },
                    { name: 'b', style: { width: 36, height: 11 } },
                ] },
                { name: 'spacer', style: { flex: 1 } },
                { name: 'end', style: { width: 10, height: 11 } },
            ],
        }, 200)).toEqual([
            'row 0,0 200x11',
            'auto 0,0 63x11',
            'a 0,0 24x11',
            'b 27,0 36x11',
            'spacer 63,5.5 127x0',
            'end 190,0 10x11',
        ]);
    });

    it('lets a content-sized row OVERFLOW, because flexShrink is 0 in RN', () => {
        // Clamping to what is available would report every zone as fitting,
        // which is the measurement the strip's give-way order is driven by.
        const frames = shape({
            name: 'row',
            style: { flexDirection: 'row' },
            children: [
                { name: 'wide', style: { flexDirection: 'row' }, children: [
                    { name: 'a', style: { width: 300, height: 11 } },
                ] },
            ],
        }, 100);
        expect(frames).toContain('wide 0,0 300x11');
    });

    it('refuses a style it does not model rather than ignoring it', () => {
        expect(() => resolveFlexFrames(
            { name: 'x', style: { position: 'absolute' } as never },
            10,
        )).toThrow(/unmodelled style "position"/);
    });
});

describe('rounded-rect clearance', () => {
    it('measures a disc against a straight edge when it is nowhere near a corner', () => {
        expect(roundedRectClearance(
            { x: 0, y: 0, width: 300, height: 100 },
            30,
            { x: 140, y: 10, width: 36, height: 36 },
        )).toBe(10);
    });

    it('measures against the ARC when the disc is in a corner, which a box test misses', () => {
        // The box is inside the rectangle on both axes and still outside the
        // drawn shape. This is the check a plain frame comparison cannot make.
        const box = { x: 0, y: 0, width: 300, height: 60 };
        const disc = { x: 1, y: 23, width: 36, height: 36 };
        expect(disc.x).toBeGreaterThanOrEqual(box.x);
        expect(disc.y + disc.height).toBeLessThanOrEqual(box.y + box.height);
        expect(roundedRectClearance(box, 30, disc)).toBeLessThan(0);
    });
});
