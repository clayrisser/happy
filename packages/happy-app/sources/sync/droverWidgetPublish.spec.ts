import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WIDGET_RELOAD_FLOOR_MS } from './droverWidgetFace';

/**
 * THE ACCOUNTANT for WidgetKit's reload budget (DROVE-260).
 *
 * `droverWidgetFace.spec.ts` pins what the widget SAYS. This pins how often it
 * is TOLD, which is the half that can fail silently in the worst possible
 * direction: spend the day's 40-70 reloads on a dot flickering between working
 * and idle, and the raise that arrives at four o'clock reaches a frozen
 * widget.
 */

const mocks = vi.hoisted(() => ({
    writes: [] as { face: Record<string, unknown>; reload: boolean }[],
    available: true,
    accepts: true,
}));

vi.mock('drover-watch', () => ({
    isDroverWidgetAvailable: () => mocks.available,
    writeDroverWidgetFace: (face: Record<string, unknown>, reload: boolean) => {
        if (mocks.accepts) mocks.writes.push({ face, reload });
        return Promise.resolve(mocks.accepts);
    },
}));

const { publishDroverWidgetFace, resetDroverWidgetMemory } = await import('./droverWidgetPublish');

const clear = [{ id: 's', dotState: 'connected' }];
const gate = (id: string) => ({ id, title: `gate ${id}`, createdAt: '2026-09-01T08:00:00.000Z' });

beforeEach(() => {
    mocks.writes = [];
    mocks.available = true;
    mocks.accepts = true;
    resetDroverWidgetMemory();
});

describe('writing the widget face', () => {
    /**
     * ISO-8601, not epoch milliseconds. `DroverWidgetFace.swift` decodes
     * through `DroverSnapshot.decoder`, which is pinned to `.iso8601` because
     * that is what the wrist's blob has always used — and a JSONDecoder handed
     * a number where it wants that string fails the WHOLE face, which on this
     * surface reads as a widget that never updates again.
     */
    it('sends the timestamp in the format the extension decodes', async () => {
        await publishDroverWidgetFace({ gates: [], sessions: clear, now: 1_760_000_000_000 });
        expect(mocks.writes[0].face.updatedAt).toBe(new Date(1_760_000_000_000).toISOString());
    });

    it('tells the widget on the first publish of a run', async () => {
        await publishDroverWidgetFace({ gates: [], sessions: clear, now: 0 });
        expect(mocks.writes[0].reload).toBe(true);
    });

    /**
     * The WRITE is unconditional and the RELOAD is not. The blob is what a
     * system-scheduled refresh reads whenever WidgetKit next feels like it, so
     * keeping it current costs nothing; only the telling is rationed.
     */
    it('keeps writing while it stops telling', async () => {
        await publishDroverWidgetFace({ gates: [], sessions: clear, now: 0 });
        await publishDroverWidgetFace({ gates: [], sessions: clear, now: 60_000 });
        await publishDroverWidgetFace({ gates: [], sessions: clear, now: 120_000 });
        expect(mocks.writes).toHaveLength(3);
        expect(mocks.writes.map((w) => w.reload)).toEqual([true, false, false]);
    });

    it('tells it the moment a gate is raised, whatever the floor says', async () => {
        await publishDroverWidgetFace({ gates: [], sessions: clear, now: 0 });
        const result = await publishDroverWidgetFace({
            gates: [gate('a')],
            sessions: clear,
            now: 1_000,
        });
        expect(result).toBe('reloaded');
        expect(mocks.writes[1].face.count).toBe(1);
    });

    it('tells it again once the floor is reached, with nothing else changed', async () => {
        await publishDroverWidgetFace({ gates: [], sessions: clear, now: 0 });
        expect(await publishDroverWidgetFace({
            gates: [], sessions: clear, now: WIDGET_RELOAD_FLOOR_MS - 1,
        })).toBe('written');
        expect(await publishDroverWidgetFace({
            gates: [], sessions: clear, now: WIDGET_RELOAD_FLOOR_MS,
        })).toBe('reloaded');
    });

    /**
     * The floor is measured from the last RELOAD, never the last write. A
     * write nobody reloaded for did not reach the widget, which goes on
     * rendering whatever it last drew — so counting writes would let an hour
     * of unreloaded churn look like an hour of keeping it current.
     */
    it('measures the floor from what the widget was told, not from what was written', async () => {
        await publishDroverWidgetFace({ gates: [], sessions: clear, now: 0 });
        for (let at = 60_000; at < WIDGET_RELOAD_FLOOR_MS; at += 60_000) {
            await publishDroverWidgetFace({ gates: [], sessions: clear, now: at });
        }
        expect(await publishDroverWidgetFace({
            gates: [], sessions: clear, now: WIDGET_RELOAD_FLOOR_MS,
        })).toBe('reloaded');
    });

    /**
     * A refused write means the widget is still holding whatever it had, so
     * the memory must not move: recording it as told would let the floor
     * suppress the retry that finally lands.
     */
    it('does not count a refused write as having told the widget anything', async () => {
        mocks.accepts = false;
        expect(await publishDroverWidgetFace({ gates: [], sessions: clear, now: 0 })).toBe('failed');
        mocks.accepts = true;
        expect(await publishDroverWidgetFace({ gates: [], sessions: clear, now: 1 })).toBe('reloaded');
    });

    /**
     * Every binary before the widget shipped. It is said apart from a failure
     * because the two want different logging, and because an OTA carrying this
     * file reaches those builds.
     */
    it('says so, and writes nothing, on a build with no widget', async () => {
        mocks.available = false;
        expect(await publishDroverWidgetFace({ gates: [], sessions: clear })).toBe('unavailable');
        expect(mocks.writes).toHaveLength(0);
    });

    /**
     * A restarted feed tells the widget once rather than inheriting a budget
     * decision from a run that is over — the same rule the feed applies to the
     * wrist with `publishedOnce`.
     */
    it('forgets what the widget was told when the feed stops', async () => {
        await publishDroverWidgetFace({ gates: [], sessions: clear, now: 0 });
        expect(await publishDroverWidgetFace({ gates: [], sessions: clear, now: 1 })).toBe('written');
        resetDroverWidgetMemory();
        expect(await publishDroverWidgetFace({ gates: [], sessions: clear, now: 2 })).toBe('reloaded');
    });
});
