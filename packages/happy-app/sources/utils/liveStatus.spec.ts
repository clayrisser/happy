/**
 * The live task tree the app draws while a session is working (DROVE-54).
 */
import { describe, expect, it } from 'vitest';

import {
    formatElapsed,
    formatTokens,
    isLiveStatusFresh,
    liveStatusSince,
    liveStatusWatchLine,
    summarizeLiveStatus,
    type LiveStatus,
} from './liveStatus';

const now = 1_700_000_000_000;

/** The state Clay photographed: a workflow, two agents and a running command. */
const busy: LiveStatus = {
    at: now,
    turnStartedAt: now - 1_033_000,
    tool: { id: 'toolu_1', name: 'Bash', arg: 'Run the unit suite', startedAt: now - 65_000 },
    agents: [
        { id: 'a1', label: 'Un-drop thinking', startedAt: now - 280_000, tokens: 274_622, toolId: 'toolu_a' },
        { id: 'a2', label: 'Sweep the backlog', startedAt: now - 64_000 },
    ],
    workflows: [
        { id: 'wf_1', name: 'drover-relaunch', phase: 'Impl', done: 3, total: 5, startedAt: now - 1_695_000, tokens: 851_900 },
    ],
};

describe('formatElapsed', () => {
    it('matches the shapes the terminal draws', () => {
        expect(formatElapsed(9_400)).toBe('9s');
        expect(formatElapsed(65_000)).toBe('1m 5s');
        expect(formatElapsed(1_695_000)).toBe('28m 15s');
        expect(formatElapsed(3_840_000)).toBe('1h 04m');
    });

    it('clamps a start time that is slightly in the future rather than counting down', () => {
        expect(formatElapsed(-5_000)).toBe('0s');
    });
});

describe('formatTokens', () => {
    it('matches the shapes the terminal draws', () => {
        expect(formatTokens(851_900)).toBe('851.9k');
        expect(formatTokens(1_530_411)).toBe('1.5M');
        expect(formatTokens(940)).toBe('940');
        expect(formatTokens(0)).toBe('0');
    });
});

describe('isLiveStatusFresh', () => {
    it('stops trusting a snapshot the CLI stopped refreshing', () => {
        expect(isLiveStatusFresh(busy, now)).toBe(true);
        expect(isLiveStatusFresh(busy, now + 119_000)).toBe(true);
        expect(isLiveStatusFresh(busy, now + 121_000)).toBe(false);
        expect(isLiveStatusFresh(null, now)).toBe(false);
    });

    it('treats a snapshot stamped in the future as fresh, because that is clock skew', () => {
        expect(isLiveStatusFresh({ ...busy, at: now + 30_000 }, now)).toBe(true);
    });
});

describe('summarizeLiveStatus', () => {
    it('leads with the running tool, its short argument and its own timer', () => {
        expect(summarizeLiveStatus(busy, now).headline).toBe('Bash · Run the unit suite · 1m 5s');
    });

    it('shows the turn elapsed beside it', () => {
        expect(summarizeLiveStatus(busy, now).turnElapsed).toBe('17m 13s');
    });

    it('lists every agent with label, elapsed and tokens', () => {
        const rows = summarizeLiveStatus(busy, now).rows.filter((r) => r.kind === 'agent');
        expect(rows).toEqual([
            {
                kind: 'agent',
                key: 'agent:a1',
                agentId: 'a1',
                title: 'Un-drop thinking',
                elapsed: '4m 40s',
                tokens: '274.6k',
                toolId: 'toolu_a',
            },
            {
                kind: 'agent',
                key: 'agent:a2',
                agentId: 'a2',
                title: 'Sweep the backlog',
                elapsed: '1m 4s',
            },
        ]);
    });

    it('shows a workflow phase and agents done out of launched', () => {
        const row = summarizeLiveStatus(busy, now).rows.find((r) => r.kind === 'workflow');
        expect(row).toEqual({
            kind: 'workflow',
            key: 'workflow:wf_1',
            title: 'drover-relaunch',
            detail: 'Impl',
            progress: '3/5 agents',
            elapsed: '28m 15s',
            tokens: '851.9k',
        });
    });

    it('counts what is folded away so the collapsed strip still says how much', () => {
        expect(summarizeLiveStatus(busy, now).subtitle).toBe('2 agents · 1 workflow');
    });

    it('falls back through workflow then agents when no tool is running', () => {
        expect(summarizeLiveStatus({ ...busy, tool: undefined }, now).headline)
            .toBe('drover-relaunch · 3/5 agents');
        expect(summarizeLiveStatus({ ...busy, tool: undefined, workflows: [] }, now).headline)
            .toBe('2 agents running');
    });

    it('says "working" while the model is composing, which puts nothing on disk', () => {
        const summary = summarizeLiveStatus({ at: now, turnStartedAt: now - 1_033_000 }, now);
        expect(summary.headline).toBe('working');
        expect(summary.turnElapsed).toBe('17m 13s');
        expect(summary.rows).toEqual([]);
    });

    it('keeps every row key stable across ticks so the tree does not remount each second', () => {
        const first = summarizeLiveStatus(busy, now).rows.map((r) => r.key);
        const later = summarizeLiveStatus(busy, now + 4_000).rows.map((r) => r.key);
        expect(later).toEqual(first);
    });
});

/**
 * The main thread's own line on the composer row (DROVE-155).
 *
 * Clay: "Where is the live token counter for the main thread as it's
 * thinking". The row used to fold the tool name, the workflow and the agent
 * count into one label with the turn's clock behind it, which is how
 * "3 agents 29s" came to sit there reading as the agents' own time.
 */
describe('summarizeLiveStatus main thread readout', () => {
    /** The same state, from a CLI that publishes the main thread's own block. */
    const mainBusy: LiveStatus = { ...busy, main: { startedAt: now - 1_033_000, tokens: 251_200 } };

    it('is the tool it is blocked on, the turn clock and the turn tokens', () => {
        expect(summarizeLiveStatus(mainBusy, now).main)
            .toEqual({ label: 'Bash', working: false, elapsed: '17m 13s', tokens: '251.2k' });
    });

    it('never lets the agents into that line, and counts them on their own', () => {
        const summary = summarizeLiveStatus(mainBusy, now);
        expect(summary.sideCount).toBe(3);
        expect(summary.main!.label).not.toMatch(/agent|drover-relaunch/);
    });

    it('says "working" while the model composes and puts nothing on disk', () => {
        const composing: LiveStatus = {
            at: now,
            turnStartedAt: now - 1_033_000,
            main: { startedAt: now - 1_033_000, tokens: 9_400 },
        };
        expect(summarizeLiveStatus(composing, now).main)
            .toEqual({ label: 'working', working: true, elapsed: '17m 13s', tokens: '9.4k' });
        expect(summarizeLiveStatus(composing, now).sideCount).toBe(0);
    });

    it('has no token count until the turn has spent one', () => {
        const fresh: LiveStatus = { at: now, main: { startedAt: now - 4_000 } };
        expect(summarizeLiveStatus(fresh, now).main).toEqual({ label: 'working', working: true, elapsed: '4s' });
    });

    it('says which of the two the label is, so the strip can order them (DROVE-223)', () => {
        // The tool name and the working word are the same slot and give way in
        // opposite orders: the name folds third of the text on the row, the
        // word folds last of anything on it. The strip reads this flag rather
        // than comparing the label to a string.
        expect(summarizeLiveStatus(mainBusy, now).main!.working).toBe(false);
        expect(summarizeLiveStatus({
            at: now,
            turnStartedAt: now - 1_000,
            main: { startedAt: now - 1_000 },
        }, now).main!.working).toBe(true);
    });

    it('is null while only background agents are out, which is what keeps the dot off', () => {
        const fanOut: LiveStatus = {
            at: now,
            turnStartedAt: now - 300_000,
            agents: [{ id: 'a1', label: 'Sweep the backlog', startedAt: now - 280_000, tokens: 1_000 }],
        };
        const summary = summarizeLiveStatus(fanOut, now);
        expect(summary.main).toBeNull();
        expect(summary.sideCount).toBe(1);
    });

    it('infers the main thread from an older CLI that publishes no block for it', () => {
        // A running tool IS the main thread waiting, whatever else is out.
        expect(summarizeLiveStatus(busy, now).main).toEqual({ label: 'Bash', working: false, elapsed: '17m 13s' });
        // Nothing else running: the snapshot can only be about the main thread.
        expect(summarizeLiveStatus({ at: now, turnStartedAt: now - 65_000 }, now).main)
            .toEqual({ label: 'working', working: true, elapsed: '1m 5s' });
        // Only agents, and no way to tell: it stays null rather than guessing.
        expect(summarizeLiveStatus({ ...busy, tool: undefined }, now).main).toBeNull();
    });

    it('falls back to the tool\'s own clock when the CLI never saw the prompt', () => {
        expect(summarizeLiveStatus({ ...busy, turnStartedAt: undefined }, now).main?.elapsed).toBe('1m 5s');
        expect(summarizeLiveStatus({ at: now }, now).main).toBeNull();
    });
});

describe('liveStatusWatchLine', () => {
    it('is one short line: the tool name, the workflow, the count', () => {
        expect(liveStatusWatchLine(busy, now)).toBe('Bash · drover-relaunch 3/5 · 2 agents');
    });

    it('never carries an elapsed time, because the wrist ticks its own from liveStatusSince', () => {
        expect(liveStatusWatchLine(busy, now)).not.toMatch(/\d+m \d+s/);
        expect(liveStatusSince(busy, now)).toBe(new Date(now - 1_033_000).toISOString());
    });

    it('says nothing at all when the session is idle or the snapshot went stale', () => {
        expect(liveStatusWatchLine(null, now)).toBeUndefined();
        expect(liveStatusWatchLine(busy, now + 300_000)).toBeUndefined();
        expect(liveStatusSince(null, now)).toBeUndefined();
    });
});
