/**
 * The live task tree the app draws while a session is working (DROVE-54).
 */
import { describe, expect, it } from 'vitest';

import {
    agentSubtreeRows,
    formatElapsed,
    formatTokens,
    isLiveStatusFresh,
    liveStatusSince,
    liveStatusWatchLine,
    orderAgentRows,
    summarizeLiveStatus,
    visibleRows,
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
                depth: 0,
            },
            {
                kind: 'agent',
                key: 'agent:a2',
                agentId: 'a2',
                title: 'Sweep the backlog',
                elapsed: '1m 4s',
                depth: 0,
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
            depth: 0,
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

    it('says "thinking" while the model is composing, which puts nothing on disk', () => {
        const summary = summarizeLiveStatus({ at: now, turnStartedAt: now - 1_033_000 }, now);
        // DROVE-244. It said `working` until Clay pointed out the dot already
        // says that; the word's job is to say WHAT, and with no tool in flight
        // what it is doing is thinking.
        expect(summary.headline).toBe('thinking');
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

    it('says "thinking" while the model composes and puts nothing on disk', () => {
        const composing: LiveStatus = {
            at: now,
            turnStartedAt: now - 1_033_000,
            main: { startedAt: now - 1_033_000, tokens: 9_400 },
        };
        expect(summarizeLiveStatus(composing, now).main)
            .toEqual({ label: 'thinking', working: true, elapsed: '17m 13s', tokens: '9.4k' });
        expect(summarizeLiveStatus(composing, now).sideCount).toBe(0);
    });

    it('has no token count until the turn has spent one', () => {
        const fresh: LiveStatus = { at: now, main: { startedAt: now - 4_000 } };
        expect(summarizeLiveStatus(fresh, now).main).toEqual({ label: 'thinking', working: true, elapsed: '4s' });
    });

    it('says which of the two the label is, so the strip can order them (DROVE-223)', () => {
        // The tool name and the state word are the same slot and give way in
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
            .toEqual({ label: 'thinking', working: true, elapsed: '1m 5s' });
        // Only agents, and no way to tell: it stays null rather than guessing.
        expect(summarizeLiveStatus({ ...busy, tool: undefined }, now).main).toBeNull();
    });

    it('falls back to the tool\'s own clock when the CLI never saw the prompt', () => {
        expect(summarizeLiveStatus({ ...busy, turnStartedAt: undefined }, now).main?.elapsed).toBe('1m 5s');
        expect(summarizeLiveStatus({ at: now }, now).main).toBeNull();
    });
});

describe('the tally across main and every subagent (DROVE-184, DROVE-241)', () => {
    /**
     * Clay: "where's my damn token counter showing tally of all tokens used
     * across main agent and all subagents". Nine agents at 200k each read as
     * 51.6k on the row, because the row's number was the MAIN transcript.
     *
     * Then: "why does my counter in my session keep resetting?" DROVE-184 put
     * the TURN on the row, so the number went back to zero every time he
     * spoke. DROVE-241 swapped it for the session and moved the turn into the
     * sheet, which is why the row assertions below read `4.0M` and not `1.4M`.
     */
    const tallied: LiveStatus = {
        ...busy,
        main: { startedAt: now - 1_033_000, tokens: 251_200 },
        tokens: { turn: 1_377_722, turnMain: 251_200, session: 4_012_000, sessionMain: 402_000 },
    };

    it('is the four numbers the CLI published, and adds up nothing itself', () => {
        expect(summarizeLiveStatus(tallied, now).tally).toEqual({
            turn: '1.4M',
            turnMain: '251.2k',
            session: '4.0M',
            sessionMain: '402.0k',
            // The fan-out's share, which is the session less the main thread.
            sessionAgents: '3.6M',
            raw: {
                turn: 1_377_722,
                turnMain: 251_200,
                session: 4_012_000,
                sessionMain: 402_000,
                // No split on this CLI. `{}`, never undefined, so a caller
                // never has to ask twice whether the field is there.
                sessionByModel: {},
            },
            // Nothing published a thinking share, so it is 0 (DROVE-244).
            turnThinking: 0,
        });
    });

    it('carries the per-model split through untouched when the CLI publishes one (DROVE-241)', () => {
        const split = { 'claude-opus-5': 3_000_000, 'claude-fable-5': 1_000_000 };
        const withModels: LiveStatus = {
            ...tallied,
            tokens: { ...tallied.tokens!, sessionByModel: split },
        };
        expect(summarizeLiveStatus(withModels, now).tally!.raw.sessionByModel).toEqual(split);
    });

    it('puts the SESSION tally in the row\'s one token slot, not the turn and not main (DROVE-241)', () => {
        const main = summarizeLiveStatus(tallied, now).main!;
        // The slot is `main.tokens` and it is unchanged in shape, so the strip
        // gains no term and the width budget is untouched.
        expect(main.tokens).toBe('4.0M');
        // The two numbers it is NOT. `1.4M` is the turn, which is what reset
        // at every prompt; `251.2k` is the main thread's share of it.
        expect(main.tokens).not.toBe('1.4M');
        expect(main.tokens).not.toBe('251.2k');
        // Both are still reachable, in the sheet.
        expect(summarizeLiveStatus(tallied, now).tally!.turn).toBe('1.4M');
        expect(summarizeLiveStatus(tallied, now).tally!.turnMain).toBe('251.2k');
    });

    it('does not move when a new prompt zeroes the turn (DROVE-241)', () => {
        // THE COMPLAINT, as a test. Same session, a moment after Clay sends a
        // message: the CLI zeroes `turn` and `turnMain` and leaves the session
        // totals where they were. The row must not notice.
        const afterPrompt: LiveStatus = {
            ...tallied,
            tokens: { turn: 0, turnMain: 0, session: 4_012_000, sessionMain: 402_000 },
        };
        expect(summarizeLiveStatus(afterPrompt, now).main!.tokens).toBe('4.0M');
        expect(summarizeLiveStatus(tallied, now).main!.tokens).toBe('4.0M');
    });

    it('still shows the spend while the fan-out outlives the turn and main is quiet', () => {
        // The state Clay was looking at: no tool, main idle, agents burning.
        // `main` is null, which is what keeps the dot off, so without this the
        // row draws an agent count and no number at all.
        const fanOut: LiveStatus = {
            at: now,
            turnStartedAt: now - 300_000,
            agents: [{ id: 'a1', label: 'Sweep the backlog', startedAt: now - 280_000, tokens: 1_800_000 }],
            tokens: { turn: 1_812_000, turnMain: 12_000, session: 1_812_000, sessionMain: 12_000 },
        };
        const summary = summarizeLiveStatus(fanOut, now);
        expect(summary.main).toBeNull();
        // The SESSION total here too (DROVE-241), which is the same number as
        // the turn's only because this fan-out has run since the session began.
        expect(summary.sideTokens).toBe('1.8M');
    });

    it('never draws the tally twice: the side number is only there when main is not', () => {
        expect(summarizeLiveStatus(tallied, now).sideTokens).toBeNull();
    });

    it('shows a session that has spent something even mid-prompt, and nothing when it has not (DROVE-241)', () => {
        const base: LiveStatus = {
            at: now,
            agents: [{ id: 'a1', label: 'Just launched', startedAt: now - 1_000 }],
            tokens: { turn: 0, turnMain: 0, session: 900, sessionMain: 900 },
        };
        // The turn is zero because he has just sent a message. Under DROVE-184
        // this drew nothing at all, which is the reset in its other clothes.
        expect(summarizeLiveStatus(base, now).sideTokens).toBe('900');
        const spentNothing: LiveStatus = {
            ...base,
            tokens: { turn: 0, turnMain: 0, session: 0, sessionMain: 0 },
        };
        expect(summarizeLiveStatus(spentNothing, now).sideTokens).toBeNull();
    });

    it('falls back to the main thread\'s own count on a CLI too old to publish a tally', () => {
        const older: LiveStatus = { ...busy, main: { startedAt: now - 1_033_000, tokens: 251_200 } };
        const summary = summarizeLiveStatus(older, now);
        expect(summary.tally).toBeNull();
        expect(summary.main!.tokens).toBe('251.2k');
        expect(summary.sideTokens).toBeNull();
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

/**
 * Agents that spawn agents (DROVE-185).
 *
 * Clay: "what if a subagent has lanes in it? Can we visualize that?" He runs
 * nine or more at once and some of those spawn their own, and every one of
 * them arrives in the same flat `agents` array because Claude Code files them
 * all in one directory. Two levels here, plus a workflow, because the workflow
 * is what caught the count disagreement below.
 */
const nested: LiveStatus = {
    at: now,
    agents: [
        { id: 'a1', label: 'Top one', startedAt: now - 300_000 },
        { id: 'a1b', label: 'Child of one', startedAt: now - 200_000, parentId: 'a1' },
        { id: 'a1c', label: 'Grandchild', startedAt: now - 100_000, parentId: 'a1b' },
        { id: 'a2', label: 'Top two', startedAt: now - 90_000 },
        { id: 'a2b', label: 'Child of two', startedAt: now - 40_000, parentId: 'a2' },
    ],
    workflows: [
        { id: 'wf_1', name: 'drover-relaunch', done: 1, total: 4, startedAt: now - 500_000 },
    ],
};

describe('orderAgentRows', () => {
    const rowsOf = (status: LiveStatus) => orderAgentRows(status.agents ?? [], now);

    it('puts each child straight after its parent, one indent deeper', () => {
        expect(rowsOf(nested).map((row) => [row.agentId, row.depth])).toEqual([
            ['a1', 0],
            ['a1b', 1],
            ['a1c', 2],
            ['a2', 0],
            ['a2b', 1],
        ]);
    });

    it('names the parent on the child and counts DIRECT children on the parent', () => {
        const byId = new Map(rowsOf(nested).map((row) => [row.agentId, row]));
        expect(byId.get('a1')!.childCount).toBe(1);
        expect(byId.get('a1')!.parentId).toBeUndefined();
        expect(byId.get('a1b')!.parentId).toBe('a1');
        // One, not two: the chip says what unfolding this row reveals, and
        // unfolding a1 reveals a1b and not yet a1c.
        expect(byId.get('a1b')!.childCount).toBe(1);
        expect(byId.get('a1c')!.childCount).toBeUndefined();
    });

    it('returns every agent exactly once, whatever the shape', () => {
        // The load-bearing property. sideCount is taken off the same array the
        // rows come from, so an agent dropped here goes quiet on the wrist.
        const ids = rowsOf(nested).map((row) => row.agentId);
        expect(ids).toHaveLength(nested.agents!.length);
        expect(new Set(ids).size).toBe(nested.agents!.length);
    });

    it('promotes a child whose parent has already finished', () => {
        // The normal end of a fan-out: the parent stops, the child runs on.
        // Filing it under an absent parent would hide a running agent behind a
        // row that no longer exists to unfold.
        const orphan: LiveStatus = {
            at: now,
            agents: [{ id: 'b1', label: 'Left behind', startedAt: now - 10_000, parentId: 'gone' }],
        };
        const [row] = orderAgentRows(orphan.agents ?? [], now);
        expect(row.depth).toBe(0);
        expect(row.parentId).toBeUndefined();
    });

    it('promotes a parent chain that loops instead of hanging on it', () => {
        const cycle: LiveStatus = {
            at: now,
            agents: [
                { id: 'c1', label: 'One', startedAt: now - 10_000, parentId: 'c2' },
                { id: 'c2', label: 'Two', startedAt: now - 10_000, parentId: 'c1' },
            ],
        };
        const rows = orderAgentRows(cycle.agents ?? [], now);
        expect(rows.map((row) => row.agentId).sort()).toEqual(['c1', 'c2']);
        expect(rows.every((row) => row.depth === 0)).toBe(true);
    });

    it('leaves a session with no nesting exactly as it was', () => {
        const rows = summarizeLiveStatus(busy, now).rows.filter((row) => row.kind === 'agent');
        expect(rows.map((row) => row.agentId)).toEqual(['a1', 'a2']);
        expect(rows.every((row) => row.depth === 0)).toBe(true);
        expect(rows.every((row) => row.childCount === undefined)).toBe(true);
    });
});

describe('visibleRows', () => {
    const rows = summarizeLiveStatus(nested, now).rows;

    it('shows only the top level until something is unfolded', () => {
        // The whole design decision. Nine top-level agents each with children
        // is a lot of rows on a phone, so the default view is the list Clay
        // already reads and a child count is what opens it.
        expect(visibleRows(rows, new Set()).map((row) => row.agentId ?? row.key))
            .toEqual(['workflow:wf_1', 'a1', 'a2']);
    });

    it('unfolds one level at a time', () => {
        expect(visibleRows(rows, new Set(['a1'])).map((row) => row.agentId ?? row.key))
            .toEqual(['workflow:wf_1', 'a1', 'a1b', 'a2']);
        expect(visibleRows(rows, new Set(['a1', 'a1b'])).map((row) => row.agentId ?? row.key))
            .toEqual(['workflow:wf_1', 'a1', 'a1b', 'a1c', 'a2']);
    });

    it('keeps a grandchild hidden while its parent is folded, even if it is itself unfolded', () => {
        expect(visibleRows(rows, new Set(['a1b'])).map((row) => row.agentId ?? row.key))
            .toEqual(['workflow:wf_1', 'a1', 'a2']);
    });
});

describe('agentSubtreeRows', () => {
    const rows = summarizeLiveStatus(nested, now).rows;

    it('gives an agent screen its own children, re-based to its own left edge', () => {
        expect(agentSubtreeRows(rows, 'a1').map((row) => [row.agentId, row.depth, row.parentId]))
            .toEqual([
                ['a1b', 0, undefined],
                ['a1c', 1, 'a1b'],
            ]);
    });

    it('is empty for an agent with nothing out, and for one not in the snapshot', () => {
        expect(agentSubtreeRows(rows, 'a1c')).toEqual([]);
        expect(agentSubtreeRows(rows, 'nope')).toEqual([]);
    });
});

/**
 * ONE number, on the screen and on the wrist (DROVE-155, DROVE-209, DROVE-185).
 *
 * DROVE-209 removed a deliberate +1 so the heartbeat would say exactly what
 * the status row says. It did not land: the row prints `sideCount` (agents AND
 * workflows) while the heartbeat re-counted `rows` filtered to agents, so the
 * two disagreed for as long as any workflow was running and no fixture had a
 * workflow in it to notice. Both read the one field now.
 */
describe('the count the row shows and the wrist beats', () => {
    it('counts nested agents, so folding a parent changes nothing', () => {
        const summary = summarizeLiveStatus(nested, now);
        // 5 agents at three depths + 1 workflow.
        expect(summary.sideCount).toBe(6);
        expect(visibleRows(summary.rows, new Set()).length).toBeLessThan(summary.rows.length);
        expect(summarizeLiveStatus(nested, now).sideCount).toBe(6);
    });

    it('counts the workflow, whose own agents are nowhere else on the wire', () => {
        // The CLI collapses a workflow's agents into done/total and keeps them
        // out of `agents` entirely, so the workflow row IS that fan-out here.
        expect(summarizeLiveStatus(busy, now).sideCount).toBe(3);
    });
});

/**
 * WHAT THE STRIP SAYS WHILE THE MAIN THREAD IS THINKING (DROVE-244).
 *
 * Clay: "When it's thinking instead of bashing on the main thread show the
 * thinking token count." His screenshot reads `● Bash 2m 58s 👥6 ^` — the slot
 * naming the running tool, working exactly as DROVE-223 built it. The state it
 * could not name was the other one: main thread working, no tool in flight,
 * where the slot went blank and the line held the last thing it knew.
 *
 * The word costs no CLI change; the number does. That split is the point of
 * these cases: DROVE-220 means a session running right now never picks up a
 * new CLI, so the half that works today has to keep working on its own.
 */
describe('the thinking state (DROVE-244)', () => {
    const thinking: LiveStatus = {
        at: now,
        turnStartedAt: now - 178_000,
        main: { startedAt: now - 178_000, tokens: 51_600 },
        tokens: { turn: 51_600, turnMain: 51_600, session: 251_600, sessionMain: 251_600, turnThinking: 3_412 },
    };

    it('names the state in the slot the tool name uses, and flags it as the word', () => {
        const main = summarizeLiveStatus(thinking, now).main!;
        expect(main.label).toBe('thinking');
        // The flag, not the string, is what the strip's fold order reads.
        expect(main.working).toBe(true);
        expect(main.elapsed).toBe('2m 58s');
    });

    it('carries what this thinking has cost, from the CLI\'s own per-turn figure', () => {
        expect(summarizeLiveStatus(thinking, now).main!.thinkingTokens).toBe('3.4k');
        expect(summarizeLiveStatus(thinking, now).tally!.turnThinking).toBe(3_412);
    });

    it('is a SHARE of the row\'s number and never an addition to it', () => {
        // Extended thinking is billed inside output tokens, so the 3.4k IS
        // part of the turn's 51.6k. Nothing anywhere may add the two.
        //
        // The row's own number is the SESSION total since DROVE-241, not the
        // turn, so it is larger than the figure the share belongs to. That is
        // the point of asserting both: the share is measured against
        // `raw.turnMain`, never against whatever the row happens to print.
        const summary = summarizeLiveStatus(thinking, now);
        expect(summary.main!.tokens).toBe('251.6k');
        expect(summary.tally!.raw.turnMain).toBe(51_600);
        expect(summary.tally!.turnThinking).toBeLessThan(summary.tally!.raw.turnMain);
    });

    it('says the word on a CLI too old to publish the figure', () => {
        // The whole reason the word is derived rather than published: DROVE-220
        // means Clay's running session will never see a new CLI, and the word
        // is the half of this that can reach it anyway.
        const old: LiveStatus = { at: now, turnStartedAt: now - 178_000, main: { startedAt: now - 178_000 } };
        const main = summarizeLiveStatus(old, now).main!;
        expect(main.label).toBe('thinking');
        expect(main.thinkingTokens).toBeUndefined();
    });

    it('draws no number when the model did no extended thinking', () => {
        // A real 0 and an absent field mean the same thing and get the same
        // nothing. `0` beside the word would be furniture.
        const none: LiveStatus = {
            ...thinking,
            tokens: { turn: 51_600, turnMain: 51_600, session: 51_600, sessionMain: 51_600, turnThinking: 0 },
        };
        expect(summarizeLiveStatus(none, now).main!.thinkingTokens).toBeUndefined();
    });

    it('says nothing about thinking while a tool is running', () => {
        // The word names the tool then, and a thinking count beside a tool
        // name would be describing something other than what the line says.
        const withTool: LiveStatus = { ...thinking, tool: { id: 't1', name: 'Bash', startedAt: now - 4_000 } };
        const main = summarizeLiveStatus(withTool, now).main!;
        expect(main.label).toBe('Bash');
        expect(main.working).toBe(false);
        expect(main.thinkingTokens).toBeUndefined();
    });

    it('refuses a thinking share larger than the turn it is a share of', () => {
        // A malformed snapshot, and drawing it would put a bigger number beside
        // the word than the one in the centre.
        const bogus: LiveStatus = {
            ...thinking,
            tokens: { turn: 51_600, turnMain: 51_600, session: 51_600, sessionMain: 51_600, turnThinking: 900_000 },
        };
        expect(summarizeLiveStatus(bogus, now).tally!.turnThinking).toBe(51_600);
    });
});
