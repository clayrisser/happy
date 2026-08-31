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
                title: 'Un-drop thinking',
                elapsed: '4m 40s',
                tokens: '274.6k',
                toolId: 'toolu_a',
            },
            {
                kind: 'agent',
                key: 'agent:a2',
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

    it('folds to a state word and the turn clock for the one-line composer row (DROVE-82)', () => {
        expect(summarizeLiveStatus(busy, now).compact).toEqual({ label: 'Bash', elapsed: '17m 13s' });
        expect(summarizeLiveStatus({ ...busy, tool: undefined }, now).compact.label).toBe('drover-relaunch 3/5');
        expect(summarizeLiveStatus({ ...busy, tool: undefined, workflows: [] }, now).compact.label).toBe('2 agents');
        expect(summarizeLiveStatus({ at: now, turnStartedAt: now - 1_033_000 }, now).compact)
            .toEqual({ label: 'working', elapsed: '17m 13s' });
    });

    it('falls back to the running thing\'s own clock when the CLI never saw the prompt', () => {
        expect(summarizeLiveStatus({ ...busy, turnStartedAt: undefined }, now).compact.elapsed).toBe('1m 5s');
        expect(summarizeLiveStatus({ at: now }, now).compact).toEqual({ label: 'working' });
    });

    it('keeps every row key stable across ticks so the tree does not remount each second', () => {
        const first = summarizeLiveStatus(busy, now).rows.map((r) => r.key);
        const later = summarizeLiveStatus(busy, now + 4_000).rows.map((r) => r.key);
        expect(later).toEqual(first);
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
