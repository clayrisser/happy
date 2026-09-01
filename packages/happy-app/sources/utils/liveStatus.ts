/**
 * The live task tree, turned into the lines the strip, the tree and the wrist
 * draw (DROVE-54).
 *
 * Clay, looking at his phone while the terminal showed six running agents with
 * elapsed times and token counts, a workflow's phase, and the running command
 * with its own timer: "I wish I could see all this rich information on my
 * mobile app as it's working. Right now it just says online and I can't see
 * what it's doing."
 *
 * Everything here is pure and takes `now` explicitly, because the timers tick
 * on THIS device: the CLI publishes absolute start times, not durations, so a
 * snapshot that arrived four seconds ago still renders a correct clock and the
 * counters keep moving between publishes.
 *
 * Nothing here decides whether a session is busy. `metadata.liveStatus` being
 * present IS the session being busy — the CLI publishes nothing while idle and
 * writes an explicit null on the way there.
 */

import type { Metadata } from '@/sync/storageTypes';

export type LiveStatus = NonNullable<NonNullable<Metadata['liveStatus']>>;
export type LiveStatusTool = NonNullable<LiveStatus['tool']>;
export type LiveStatusAgent = NonNullable<LiveStatus['agents']>[number];
export type LiveStatusWorkflow = NonNullable<LiveStatus['workflows']>[number];
export type LiveStatusTokens = NonNullable<LiveStatus['tokens']>;
/** The compaction pass, while the CLI says one is running (DROVE-257). */
export type LiveStatusCompaction = NonNullable<LiveStatus['compacting']>;

/**
 * How long a snapshot may sit before we stop drawing timers off it.
 *
 * The number and its reasoning moved to `@slopus/happy-wire` with the dot's
 * vocabulary (DROVE-247), because `DISCONNECT_RECENT_MS` is defined as this
 * value and happy-cli now resolves the dot too. Re-exported from its old home
 * so every caller and both specs keep the import they had.
 */
import { LIVE_STATUS_STALE_MS } from '@slopus/happy-wire';
export { LIVE_STATUS_STALE_MS };

/**
 * What the main thread is called when no tool names it: THINKING (DROVE-244).
 *
 * It used to be `working`, and DROVE-231 then took that word off the strip
 * altogether — Clay: "Don't show text working" — because the blue dot beside
 * it already said the session was working and the word repeated it.
 *
 * `thinking` is a different word doing a different job. Clay: "When it's
 * thinking instead of bashing on the main thread show the thinking token
 * count." The strip names the running TOOL in this slot, so while a tool runs
 * it says what the session is doing; with no tool in flight it went blank and
 * held the last thing it knew. The dot says the session is working, so this
 * word says WHAT — a tool by name, or thinking. It is the same slot, not a new
 * term on a line DROVE-223 fought to fit.
 *
 * One constant rather than four literals, because the strip has to RECOGNISE
 * it: this word is the last thing on the row to give way (DROVE-223), so the
 * fold order has to tell it apart from a tool's name, and a second spelling
 * here would quietly turn that rule off.
 */
export const LIVE_STATUS_THINKING_WORD = 'thinking';

/**
 * And what it is called while it COMPACTS (DROVE-257).
 *
 * Not `thinking`. A compaction is the session rewriting the conversation it is
 * standing on, and it is the state Clay most wants named — he photographed a
 * terminal mid-compaction next to a phone claiming the session was idle. It
 * does not go on the status strip, which has carried no word at all since
 * DROVE-250 took `thinking` back off the line; the strip's signal is the
 * purple blinking dot. This is for the sheet and the wrist, where there is
 * room for a sentence.
 */
export const LIVE_STATUS_COMPACTING_WORD = 'compacting';

export function isLiveStatusFresh(status: LiveStatus | null | undefined, now: number): boolean {
    if (!status) return false;
    // A clock skew between the Mac and the phone can put `at` in the future.
    // That is not staleness, so only the past side is checked.
    return now - status.at <= LIVE_STATUS_STALE_MS;
}

/**
 * `28m 15s`, `1m 5s`, `9s` — the terminal's own shape.
 *
 * Hours are kept as `1h 04m` rather than `64m` because a run that has been
 * going for over an hour is a different kind of fact, and the minutes still
 * matter. Negative input clamps to zero: a start time slightly in the future
 * is a clock skew, not a countdown.
 */
export function formatElapsed(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const seconds = total % 60;
    const minutes = Math.floor(total / 60) % 60;
    const hours = Math.floor(total / 3600);
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

/**
 * The tiers this scales through, largest first.
 *
 * `B` is new with DROVE-241 and it is not decoration: the strip's number is
 * now the SESSION total, and the home page's is every session this phone has
 * ever seen. At the 1.3M Clay's session reached in an evening, an all-time
 * count crosses a billion inside a year, and `1234.5M` is a number nobody
 * reads.
 */
const tokenTiers = [
    { at: 1_000_000_000, suffix: 'B' },
    { at: 1_000_000, suffix: 'M' },
    { at: 1_000, suffix: 'k' },
] as const;

/**
 * `851.9k`, `1.5M`, `940` — the terminal's own shape again.
 *
 * SIX CHARACTERS, ALWAYS, and that is a layout guarantee rather than a
 * coincidence (DROVE-241). The strip's centre zone is this string, and what
 * bounds the zone is the widest thing this can return: one decimal and a
 * suffix, so `999.9k` and `100.0M` are the ceiling and a session that grows
 * for a week never widens the line by a point.
 *
 * The promotion at `0.99995` is what makes that true. `999_999` is below a
 * million and `(999.999).toFixed(1)` is `1000.0`, so the old form returned
 * `1000.0k` — SEVEN characters, the one string that could push the centre
 * zone past its budget, and it arrived in the narrow band right before the
 * number Clay was watching for. It is a million in k's clothing, so it
 * promotes to `1.0M` instead.
 */
export function formatTokens(tokens: number): string {
    if (!Number.isFinite(tokens) || tokens <= 0) return '0';
    for (const tier of tokenTiers) {
        if (tokens >= tier.at * 0.99995) {
            return `${(tokens / tier.at).toFixed(1)}${tier.suffix}`;
        }
    }
    return String(Math.round(tokens));
}

/** One line in the folded tree. */
export interface LiveStatusRow {
    kind: 'tool' | 'agent' | 'workflow';
    /** Stable across ticks, so the list does not remount every second. */
    key: string;
    title: string;
    /** The middle column: a workflow's phase, an agent's type, a tool's argument. */
    detail?: string;
    /** `3/5 agents` — workflows only. */
    progress?: string;
    elapsed: string;
    tokens?: string;
    /** The tool_use this row is about, so a tap can open its card. */
    toolId?: string;
    /** Claude Code's agent id, so a tap can open the agent's own transcript (DROVE-93). */
    agentId?: string;
    /**
     * How deep under a top-level agent this row sits (DROVE-185). 0 for
     * everything the pane launched itself, and for tools and workflows.
     *
     * Rows stay FLAT: a nested agent is a row in this same array, just after
     * its parent and carrying a depth. The tree is an ordering and a set of
     * labels over the flat list, never a nested structure, because every count
     * in the app is taken off this array and a child hidden inside its parent
     * is a child that stops being counted.
     */
    depth: number;
    /** The agent row this one sits under, absent at depth 0 (DROVE-185). */
    parentId?: string;
    /**
     * Direct children present in this same snapshot (DROVE-185). Absent when
     * there are none, so a row with no `childCount` draws exactly as it did
     * before nesting existed.
     */
    childCount?: number;
    /**
     * What toggling this row's fold is keyed on (DROVE-185, DROVE-290). An
     * agent parent's is its agentId, a workflow's is `workflow:<runId>`;
     * children carry it as their `parentId`. Absent on rows with nothing to
     * fold.
     */
    groupKey?: string;
    /**
     * The workflow run this row heads, so a tap can open the wave screen
     * (DROVE-290). Workflow rows only.
     */
    runId?: string;
}

/**
 * The MAIN thread's readout for the status row (DROVE-155).
 *
 * Clay: "Where is the live token counter for the main thread as it's
 * thinking". The agent cards had a clock and a token count each and the main
 * session had neither, so the only numbers under the composer were the
 * agents'. This is the same pair of numbers, from the same two formatters
 * TaskView calls, read off the main thread's own block instead of an agent's.
 *
 * Null while only background agents are out: a fan-out outlives the turn that
 * launched it, and the main thread being quiet then is the truth.
 */
export interface LiveStatusMain {
    /** What the main thread is blocked on: the tool's name, or `thinking`. */
    label: string;
    /**
     * True when the label is the STATE WORD rather than a tool's name
     * (DROVE-223, DROVE-244).
     *
     * The two look the same on the row and give way in opposite orders: a tool
     * name folds first of the text on the strip, the working word folds last
     * of anything on it. The strip reads this rather than comparing the label
     * to a string, so the rule cannot drift from what `liveStatusMain` decided.
     * name folds first of the text on the strip, the state word folds last of
     * anything on it. The strip reads this rather than comparing the label to
     * a string, so the rule cannot drift from what `mainReadout` decided.
     *
     * This is also the whole test for "is it thinking": the main thread is
     * working (there is a `main` block at all) and no tool is in flight. That
     * costs no CLI change and no new field on the wire, so the WORD works on a
     * session running today — which matters, because DROVE-220 means a running
     * session never picks up a new CLI. Only the NUMBER below needs one.
     */
    working: boolean;
    /** The turn's clock, ticking on this device. */
    elapsed: string;
    /**
     * `1.4M` — the SESSION tally: main plus every subagent since this session
     * was picked up, and not the turn (DROVE-241).
     *
     * DROVE-184 put the per-TURN tally here and the session total one tap
     * away, which is a defensible reading of "tally" and the wrong one. Clay:
     * "why does my counter in my session keep resetting?" It reset because a
     * turn ends when he speaks. What he asked for was "tally of all tokens
     * used across main agent and all subagents", and a number that returns to
     * zero when he sends a message is not a tally of anything.
     *
     * So the two swapped. The session is on the row; the turn is in the sheet,
     * which already spelled all four out. The slot is the same slot, so the
     * strip gains no term and DROVE-223's width budget is untouched — and the
     * new number is no wider than the old one, because `formatTokens` caps at
     * six characters whatever it is given.
     */
    tokens?: string;
    /**
     * `3.4k` — what THIS thinking is costing (DROVE-244), and present only
     * while `working` is true.
     *
     * TWO NUMBERS, TWO SCOPES, AND THEY MUST NOT BE CONFUSED (DROVE-241). The
     * centre of the strip is the SESSION's spend and means the same thing at
     * every moment of the session; this one is the main thread's thinking this
     * turn and describes the activity the word beside it names. So they sit in
     * different zones, the centre one never changes meaning, and this one is
     * simply absent whenever a tool is running.
     *
     * A SHARE of `tokens`, never an addition to it: extended thinking is
     * billed inside output tokens, so this spend is already inside the centre
     * figure. Nothing anywhere adds the two.
     */
    thinkingTokens?: string;
}

/**
 * The tally: main thread plus every subagent, formatted (DROVE-184).
 *
 * Clay: "where's my damn token counter showing tally of all tokens used across
 * main agent and all subagents". The strip's number was `main.tokens`, the
 * MAIN transcript alone. Nine subagents at 200k each did not appear in it, so
 * the row understated the night by an order of magnitude.
 *
 * Nothing here ADDS anything up. The CLI does the summing where the
 * transcripts are, at the same `countTokens` calls that make the cards, and
 * publishes four numbers; this only formats them. Adding up `status.agents`
 * on the phone would give a different answer the moment an agent finished,
 * because a finished agent leaves that array 90s later and takes its spend
 * with it.
 */
export interface LiveStatusTally {
    /** Main plus every subagent since the last prompt. The sheet's last term. */
    turn: string;
    /** The main thread's share of the turn, so main can be told from the fan-out. */
    turnMain: string;
    /** Main plus every subagent for the whole session. What the ROW draws (DROVE-241). */
    session: string;
    /** The main thread's share of the session. */
    sessionMain: string;
    /** The subagents' share of the session, which is `session` less `sessionMain`. */
    sessionAgents: string;
    /**
     * The main thread's THINKING share of the turn (DROVE-244), 0 on a CLI too
     * old to publish it and on a model doing no extended thinking. A share of
     * `turnMain`, already inside every figure above.
     */
    turnThinking: number;
    /** The numbers behind the strings, for anything that needs to compare them. */
    raw: {
        turn: number;
        turnMain: number;
        session: number;
        sessionMain: number;
        /**
         * `session` split by model id (DROVE-241), `{}` on a CLI too old to
         * publish one. It is what the home page's all-time ledger banks, and
         * it is deliberately raw: the parts can be SHORT of `session`, because
         * a record that named no model is counted into the total and left out
         * of the split, so nothing may treat the sum of these as the whole.
         */
        sessionByModel: Record<string, number>;
    };
}

/** The published tally, or null on a CLI too old to publish one. */
export function liveStatusTally(status: LiveStatus): LiveStatusTally | null {
    const tokens = status.tokens;
    if (!tokens) return null;
    const raw = {
        turn: tokens.turn,
        turnMain: tokens.turnMain,
        session: tokens.session,
        sessionMain: tokens.sessionMain,
        sessionByModel: tokens.sessionByModel ?? {},
    };
    return {
        turn: formatTokens(raw.turn),
        turnMain: formatTokens(raw.turnMain),
        session: formatTokens(raw.session),
        sessionMain: formatTokens(raw.sessionMain),
        sessionAgents: formatTokens(Math.max(0, raw.session - raw.sessionMain)),
        // Clamped to the turn's own main figure: a thinking share larger than
        // the total it is a share of is a malformed snapshot, and drawing it
        // would put a bigger number beside the word than the one in the centre.
        turnThinking: Math.max(0, Math.min(tokens.turnThinking ?? 0, raw.turnMain)),
        raw,
    };
}

export interface LiveStatusSummary {
    /**
     * The one line the header strip shows: the running tool and its argument,
     * or what is running when no tool is.
     */
    headline: string;
    /** The turn's own timer, absent when the CLI never saw the prompt. */
    turnElapsed?: string;
    /** Rows behind the fold. Empty means there is nothing to expand. */
    rows: LiveStatusRow[];
    /** `2 agents · 1 workflow`, for the collapsed summary beside the chevron. */
    subtitle?: string;
    /**
     * The one-line composer row's main-thread segment (DROVE-82, DROVE-155):
     * `Bash 1m 2s 251.2k`. Null when the main thread is not the thing running.
     *
     * This replaced a `compact` block whose label was the tool name OR the
     * agent count OR the workflow, which is exactly how "3 agents 29s" came to
     * sit on the row with the main thread's clock behind it. One segment is
     * the main thread, the other is the count. They never share a number.
     */
    main: LiveStatusMain | null;
    /**
     * The compaction pass, while one is running (DROVE-257).
     *
     * Carried whole rather than as a boolean because it holds the pass's own
     * `startedAt` — which is NOT `main.startedAt`, the turn's — and, where a
     * pane could be read, how far along it is.
     *
     * Null on a CLI older than the ticket, which is not the same as "not
     * compacting": the dot keeps DROVE-231's inference for that case.
     */
    compacting: LiveStatusCompaction | null;
    /**
     * Background agents plus workflows: the number beside the fold, the only
     * thing on the row that speaks for the agents, and THE ONE DERIVATION any
     * surface that counts agents reads (DROVE-155, DROVE-209, DROVE-185).
     *
     * The Morse heartbeat reads this field. It used to re-count by filtering
     * `rows` for `kind === 'agent'`, which is agents WITHOUT workflows, so the
     * wrist said two while the screen said three for as long as a workflow was
     * running — the exact disagreement DROVE-209 set out to remove, surviving
     * because its spec never put a workflow in the fixture.
     *
     * IT NO LONGER ADDS THE WORKFLOWS, and that is an inversion, not a
     * regression (DROVE-268). A workflow's agents used to be missing from
     * `agents` entirely — the CLI collapsed them into a done/total — so the
     * workflow row had to stand in for the whole fan-out and dropping it
     * undercounted. The CLI publishes those agents now, each stamped with a
     * `runId`, so the row is a group header and adding it back would count
     * five agents as six. The number this field answers is unchanged: how many
     * workers are out. What changed is that five of them stopped being
     * invisible.
     *
     * NESTED AGENTS COUNT, and they always did (DROVE-185). Every agent at
     * every depth is one entry in `agents`, so this number is unchanged by the
     * tree: a session that showed nine before shows nine now, folded. That is
     * the whole reason the rows stayed flat. They are also real work in
     * flight, and the question this number answers is how much is out.
     */
    sideCount: number;
    /**
     * Main plus every subagent (DROVE-184). Null on a CLI too old to publish
     * it, and the row falls back to the main thread's own count there.
     */
    tally: LiveStatusTally | null;
    /**
     * The token text the row draws when the MAIN thread is not what is running.
     *
     * A fan-out outlives the turn that launched it, so `main` is null while
     * nine agents burn — the exact state Clay was looking at. Without this the
     * row shows a bare agent count and no spend at all. Null when there is
     * nothing to say, so the row is never given furniture.
     */
    sideTokens: string | null;
}

function agentRow(
    agent: LiveStatusAgent,
    now: number,
    depth: number,
    parentId: string | undefined,
    childCount: number,
): LiveStatusRow {
    return {
        kind: 'agent',
        key: `agent:${agent.id}`,
        title: agent.label,
        elapsed: formatElapsed(now - agent.startedAt),
        ...(typeof agent.tokens === 'number' && agent.tokens > 0
            ? { tokens: formatTokens(agent.tokens) }
            : {}),
        ...(agent.toolId ? { toolId: agent.toolId } : {}),
        agentId: agent.id,
        depth,
        ...(parentId ? { parentId } : {}),
        ...(childCount > 0 ? { childCount, groupKey: agent.id } : {}),
    };
}

/**
 * The agents, ordered parent-then-children and stamped with a depth
 * (DROVE-185).
 *
 * Clay: "what if a subagent has lanes in it? Can we visualize that?" A
 * subagent can spawn its own subagents, and every one of them lands in the
 * session's single flat `subagents/` directory, so the sheet was already
 * listing them — indistinguishable from the nine top-level agents around
 * them. The CLI now publishes `parentId` and this is what turns it into a
 * shape.
 *
 * EVERY AGENT COMES BACK, exactly once. This reorders and labels; it never
 * drops. That is load-bearing: `sideCount` is taken off the same agent array
 * and the heartbeat reads `sideCount`, so an agent that vanished here would go
 * quiet on the wrist as well as off the screen.
 *
 * A parent that is NOT in the snapshot promotes its children to top level
 * rather than hiding them. A parent finishes while its child runs on — that is
 * the normal end of a fan-out, not an error — and a running agent filed under
 * an absent parent would be a row nothing could ever reveal. Same treatment
 * for a parent chain that loops: unreachable roots are promoted, so a
 * malformed meta.json costs a wrong indent, never a lost row or a hang.
 */
export function orderAgentRows(agents: LiveStatusAgent[], now: number): LiveStatusRow[] {
    const byId = new Map<string, LiveStatusAgent>();
    for (const agent of agents) byId.set(agent.id, agent);

    // The parent each agent actually renders under: its own when that agent is
    // in this snapshot and the link does not close a loop, else none.
    const parentOf = new Map<string, string | undefined>();
    for (const agent of agents) {
        let parent = agent.parentId;
        if (parent === agent.id || (parent !== undefined && !byId.has(parent))) parent = undefined;
        if (parent !== undefined) {
            // Walk up. A cycle, or a chain longer than the snapshot, means
            // there is no root above this agent, so it becomes one.
            const seen = new Set<string>([agent.id]);
            let cursor: string | undefined = parent;
            while (cursor !== undefined && !seen.has(cursor)) {
                seen.add(cursor);
                cursor = byId.get(cursor)?.parentId;
                if (cursor !== undefined && !byId.has(cursor)) cursor = undefined;
            }
            if (cursor !== undefined) parent = undefined;
        }
        parentOf.set(agent.id, parent);
    }

    const children = new Map<string, LiveStatusAgent[]>();
    const roots: LiveStatusAgent[] = [];
    for (const agent of agents) {
        const parent = parentOf.get(agent.id);
        if (parent === undefined) {
            roots.push(agent);
            continue;
        }
        const list = children.get(parent);
        if (list) list.push(agent);
        else children.set(parent, [agent]);
    }

    const rows: LiveStatusRow[] = [];
    const emit = (agent: LiveStatusAgent, depth: number, parentId: string | undefined) => {
        const kids = children.get(agent.id) ?? [];
        rows.push(agentRow(agent, now, depth, parentId, kids.length));
        for (const kid of kids) emit(kid, depth + 1, agent.id);
    };
    for (const root of roots) emit(root, 0, undefined);
    return rows;
}

/**
 * `4 running · 1 done / 5` — what a run has out, and what it has settled
 * (DROVE-268).
 *
 * `done/total` alone was the whole progress line, and it said the wrong thing
 * twice over: a run of 5 started and 5 failed drew as `0/5`, because only
 * `result` counted; and a run with four agents flat out drew the same `0/5` as
 * a run with four agents dead, because nothing on the line was about NOW.
 * Running leads for that reason — it is the answer to the question Clay
 * actually asked the phone.
 *
 * `quiet` is deliberately not in this string. It is on the row as work this
 * reader cannot see, and it is the difference between the numbers that add up
 * and `total`, which is where a reader will look for it.
 */
function workflowProgress(workflow: LiveStatusWorkflow): string {
    // An older CLI publishes neither `running` nor `failed`, and DROVE-220
    // makes that the common case for a session running right now. It cannot
    // say how many are working, so the row keeps the sentence it always drew
    // rather than saying `0 running` about a run it simply cannot see into.
    if (typeof workflow.running !== 'number') return `${workflow.done}/${workflow.total} agents`;
    const running = workflow.running;
    const failed = workflow.failed ?? 0;
    const parts: string[] = [];
    if (running > 0) parts.push(`${running} running`);
    if (workflow.done > 0) parts.push(`${workflow.done} done`);
    if (failed > 0) parts.push(`${failed} failed`);
    // "launched", not "planned": the journal is append-only and nothing on
    // disk states how many agents a workflow will end up running, so this
    // rises as the run fans out. The terminal counts it the same way.
    if (parts.length === 0) return `0/${workflow.total} agents`;
    return `${parts.join(' · ')} / ${workflow.total}`;
}

function workflowRow(workflow: LiveStatusWorkflow, now: number): LiveStatusRow {
    // The phase TITLES, when the run's script declared them, in place of the
    // newest agent's label (DROVE-268). `Work → Verify` says what the run is
    // made of; the old `detail` was the label of whichever agent started last,
    // which on a fan-out is an arbitrary one of five. There is still no claim
    // about WHICH phase is current, because nothing live states it.
    const phases = workflow.phaseNames ?? [];
    const detail = phases.length > 0 ? phases.join(' → ') : workflow.phase;
    return {
        kind: 'workflow',
        key: `workflow:${workflow.id}`,
        title: workflow.name,
        runId: workflow.id,
        ...(detail ? { detail } : {}),
        progress: workflowProgress(workflow),
        elapsed: formatElapsed(now - workflow.startedAt),
        ...(typeof workflow.tokens === 'number' && workflow.tokens > 0
            ? { tokens: formatTokens(workflow.tokens) }
            : {}),
        depth: 0,
    };
}

/**
 * HOW MUCH IS OUT — the one derivation, read by the strip, the sheet and the
 * wrist (DROVE-155, DROVE-209, DROVE-268).
 *
 * It is the length of `agents`, and nothing else. That array now holds a
 * workflow's agents as well as the pane's, each stamped with a `runId`, so
 * counting the workflows too would count the same fan-out twice — the
 * opposite of the old rule here, and for the opposite reason. Before
 * DROVE-268 a workflow's agents were not in `agents` at all, so the workflow
 * itself had to stand in for them; now they are there, and the workflow row is
 * a group header rather than a worker.
 *
 * The wrist reads THIS, not its own count. DROVE-209 set out to stop the
 * wrist and the screen disagreeing and DROVE-257 found them drifted again, so
 * the derivation is a function rather than an expression repeated twice.
 */
export function liveStatusWorkerCount(status: LiveStatus | null | undefined): number {
    const agents = status?.agents ?? [];
    // A workflow that PUBLISHES its agents is a group header: its workers are
    // in `agents` already, stamped with its `runId`, and counting the run too
    // would count them twice.
    //
    // A workflow from an older CLI publishes none — it collapses its fan-out
    // into a done/total and nothing else on the wire speaks for those agents —
    // so it still stands in for them, worth the one it has always been worth.
    // `running` is the tell, and a run that reports it always reports at least
    // one: the CLI drops a run the moment nothing of it is writing, so
    // `running: 0` never reaches here and cannot silently zero a live fan-out.
    // DROVE-220 means an old CLI is what a session running right now has.
    const opaqueWorkflows = (status?.workflows ?? [])
        .filter((workflow) => typeof workflow.running !== 'number').length;
    return agents.length + opaqueWorkflows;
}

/** Depth-shift a block of rows so it nests under the row above it. */
function indented(rows: LiveStatusRow[], by: number): LiveStatusRow[] {
    return rows.map((row) => ({ ...row, depth: row.depth + by }));
}

function countPhrase(count: number, one: string, many: string): string | null {
    if (count <= 0) return null;
    return `${count} ${count === 1 ? one : many}`;
}

/**
 * The rows to actually draw, given which parents are unfolded (DROVE-185).
 *
 * Collapsed is the default, and that is the whole design. Clay runs nine or
 * more agents at once and some of those spawn their own; a permanently nested
 * tree would push the ninth off the screen to show the second one's children,
 * which is a worse sheet than the flat list it replaced. So the top level
 * stays exactly as it was, a parent carries a count of its children, and the
 * count is what unfolds them in place. Nothing is hidden that was not
 * previously invisible anyway: before this, a nested agent sat in the flat
 * list wearing no sign of whose it was.
 *
 * Folding is a DRAWING decision and touches no number. `sideCount` still
 * counts every agent at every depth, so the row and the wrist say the same
 * thing whether a parent is open or shut.
 *
 * A child of a collapsed parent is hidden along with its own children, so
 * unfolding one level reveals one level.
 */
export function visibleRows(rows: LiveStatusRow[], expanded: ReadonlySet<string>): LiveStatusRow[] {
    const out: LiveStatusRow[] = [];
    const hidden = new Set<string>();
    for (const row of rows) {
        const parent = row.parentId;
        if (parent !== undefined && (hidden.has(parent) || !expanded.has(parent))) {
            if (row.agentId) hidden.add(row.agentId);
            continue;
        }
        out.push(row);
    }
    return out;
}

/**
 * One agent's descendants, re-based so its own children sit at depth 0
 * (DROVE-185).
 *
 * The agent screen asks the same question of an agent that the status row asks
 * of the session — what have you got out — and gets it answered by the same
 * rows, off the session's one snapshot. There is no second fetch and no second
 * derivation: an agent's children are already in `status.agents`, because
 * every agent in the session lands in one flat directory whatever its depth.
 *
 * Re-based, not sliced, so the sheet on an agent screen indents from its own
 * left edge rather than carrying its parent's offset across.
 */
export function agentSubtreeRows(rows: LiveStatusRow[], agentId: string): LiveStatusRow[] {
    const root = rows.find((row) => row.agentId === agentId);
    if (!root) return [];
    const base = root.depth + 1;
    const inside = new Set<string>([agentId]);
    const out: LiveStatusRow[] = [];
    for (const row of rows) {
        if (row.agentId === agentId) continue;
        if (row.parentId === undefined || !inside.has(row.parentId)) continue;
        if (row.agentId) inside.add(row.agentId);
        const { parentId: _dropped, ...rest } = row;
        out.push({
            ...rest,
            depth: row.depth - base,
            // A direct child of this agent has no parent INSIDE this view, so
            // it is a root here and folds like one.
            ...(row.parentId !== agentId ? { parentId: row.parentId } : {}),
        });
    }
    return out;
}

export function summarizeLiveStatus(status: LiveStatus, now: number): LiveStatusSummary {
    const agents = status.agents ?? [];
    const workflows = status.workflows ?? [];
    const rows: LiveStatusRow[] = [];

    if (status.tool) {
        rows.push({
            kind: 'tool',
            key: `tool:${status.tool.id}`,
            title: status.tool.name,
            ...(status.tool.arg ? { detail: status.tool.arg } : {}),
            elapsed: formatElapsed(now - status.tool.startedAt),
            toolId: status.tool.id,
            depth: 0,
        });
    }
    // A workflow, then ITS agents, indented one step under it (DROVE-268) and
    // folded behind the workflow row by default (DROVE-290).
    //
    // DROVE-268 made these rows deliberately unfoldable, because the
    // complaint it answered was invisibility and a silent fold reproduces it.
    // Then Clay, at a workflow drawing six open rows with one truncated label
    // between them: "Shouldn't you be able to collapse this?" The fold is not
    // silent now — the workflow row wears the same chevron-and-count an agent
    // parent wears (DROVE-185), its summary line still carries every count,
    // and the wave screen behind a tap carries the detail — so collapsed is
    // the default, and nothing is hidden without a number saying so.
    const byRun = new Map<string, LiveStatusAgent[]>();
    const paneAgents: LiveStatusAgent[] = [];
    for (const agent of agents) {
        if (!agent.runId) {
            paneAgents.push(agent);
            continue;
        }
        const list = byRun.get(agent.runId);
        if (list) list.push(agent);
        else byRun.set(agent.runId, [agent]);
    }
    for (const workflow of workflows) {
        const header = workflowRow(workflow, now);
        const mine = byRun.get(workflow.id);
        if (!mine) {
            rows.push(header);
            continue;
        }
        byRun.delete(workflow.id);
        const groupKey = `workflow:${workflow.id}`;
        rows.push({ ...header, groupKey, childCount: mine.length });
        for (const row of indented(orderAgentRows(mine, now), 1)) {
            // The run's own agents hang off the workflow's fold; an agent
            // nested under one of them keeps its real parent, and collapses
            // with it the way any nested agent does.
            rows.push(row.parentId ? row : { ...row, parentId: groupKey });
        }
    }
    // An agent whose run is not in this snapshot is NOT dropped: it is drawn at
    // top level beside the pane's own, the same promotion `orderAgentRows`
    // does for a child whose parent has finished. Losing a running agent
    // because its header went missing is the bug this ticket exists to fix,
    // and every count below is taken off these rows.
    for (const orphans of byRun.values()) paneAgents.push(...orphans);
    // Ordered parent-then-child and stamped with a depth (DROVE-185). Same
    // rows, same number of them, in an order that can be drawn as a tree.
    for (const row of orderAgentRows(paneAgents, now)) rows.push(row);

    // The headline is what Clay sees without expanding anything, so it names
    // the most specific thing running. A tool beats a fan-out because the tool
    // is what the turn is blocked on.
    let headline: string;
    if (status.compacting) {
        // COMPACTING BEATS EVERYTHING, including a tool (DROVE-257). The pass
        // rewrites the conversation the session is standing on, and a tool
        // that happens to still be open under it is the smaller fact. It also
        // has its own clock: the pass's, not the turn's, which is what makes
        // the sheet's line agree with the terminal's `(1m 55s, …)`.
        const elapsed = formatElapsed(now - status.compacting.startedAt);
        const percent = typeof status.compacting.percent === 'number'
            ? ` · ${Math.round(status.compacting.percent)}%`
            : '';
        headline = `${LIVE_STATUS_COMPACTING_WORD} · ${elapsed}${percent}`;
    } else if (status.tool) {
        const elapsed = formatElapsed(now - status.tool.startedAt);
        headline = status.tool.arg
            ? `${status.tool.name} · ${status.tool.arg} · ${elapsed}`
            : `${status.tool.name} · ${elapsed}`;
    } else if (workflows.length > 0) {
        const workflow = workflows[0];
        headline = `${workflow.name} · ${workflowProgress(workflow)}`;
    } else if (agents.length > 0) {
        headline = countPhrase(agents.length, 'agent running', 'agents running')!;
    } else {
        // Busy, with nothing on disk to name it: the model is composing a
        // reply, which writes nothing until it is done. This is the
        // "Sketching… 17m 13s" state, and saying "working" is the honest
        // version of it.
        headline = LIVE_STATUS_THINKING_WORD;
    }

    const parts = [
        countPhrase(agents.length, 'agent', 'agents'),
        countPhrase(workflows.length, 'workflow', 'workflows'),
    ].filter((part): part is string => part !== null);

    const tally = liveStatusTally(status);
    const main = liveStatusMain(status, now, tally);
    // Agents, and only agents (DROVE-268) — see `liveStatusWorkerCount`. A
    // workflow used to be added here because its agents were nowhere else;
    // they are in `agents` now, so adding it would count the fan-out twice.
    const sideCount = liveStatusWorkerCount(status);

    return {
        headline,
        ...(status.turnStartedAt ? { turnElapsed: formatElapsed(now - status.turnStartedAt) } : {}),
        rows,
        ...(parts.length > 0 ? { subtitle: parts.join(' · ') } : {}),
        main,
        compacting: status.compacting ?? null,
        sideCount,
        tally,
        // Only when the main thread is NOT carrying the number itself, so the
        // row never shows the tally twice. The SESSION total, the same number
        // `mainReadout` puts in the slot (DROVE-241): a fan-out that outlives
        // its turn is exactly the case where a turn number reads as zero while
        // nine agents burn.
        sideTokens: !main && sideCount > 0 && tally && tally.raw.session > 0 ? tally.session : null,
    };
}

/**
 * The main thread's own line, or null when the main thread is not what is
 * running (DROVE-155).
 *
 * Exported since DROVE-243, because the SESSION DOT is this question and
 * nothing else: `main !== null` is the main thread working, and `!main.working`
 * is it blocked on a tool. Every surface that draws a dot for a session asks it
 * here, so a list row and the strip inside that session cannot answer it
 * differently.
 *
 * The label is the tool it is blocked on, because a tool call IS the main
 * thread waiting, and `working` otherwise — the "Sketching… 17m 13s" state,
 * where the model is composing and writes nothing to disk until it is done.
 * The agent count and a workflow's progress are deliberately not options here;
 * they belong to `sideCount` and to the tree behind the fold.
 *
 * The `main` block is what the CLI publishes for this (DROVE-155). An older
 * CLI has none, so we infer: a running tool is the main thread by definition,
 * and a snapshot with nothing else running must be about the main thread too.
 * A snapshot that is only background agents stays null rather than guessing,
 * which is the one case where the old CLI shows less than the new one.
 */
export function liveStatusMain(status: LiveStatus, now: number, tally: LiveStatusTally | null): LiveStatusMain | null {
    // The label is the tool while one runs, and otherwise the word for what
    // the main thread is actually doing (DROVE-244). It is no longer
    // `working`: the blinking blue dot already says that, which is why
    // DROVE-231 took the word off the line.
    const label = status.tool ? status.tool.name : LIVE_STATUS_THINKING_WORD;
    const working = !status.tool;
    // THE ROW'S NUMBER IS THE SESSION TALLY (DROVE-241, over DROVE-184's
    // turn). It sits in the slot the main-only count used to hold, so the
    // strip gains no term and the width budget is untouched — `tokens` is
    // already a rank on STATUS_ROW_GIVE_WAY (DROVE-223) and this inherits it
    // whole. Falls back to the main thread's own count on a CLI too old to
    // publish a tally, which is the old behaviour exactly; that fallback is a
    // TURN number and it will still reset, which is a floor on what an old
    // CLI can say rather than a second reading of the rule.
    const rowTokens = tally ? tally.raw.session : status.main?.tokens;
    const tokensOf = (tokens: unknown): { tokens?: string } => (
        typeof tokens === 'number' && tokens > 0 ? { tokens: formatTokens(tokens) } : {}
    );
    /**
     * What this thinking is costing (DROVE-244), and ONLY while thinking.
     *
     * Three ways it is absent, and all three draw the same nothing: a tool is
     * running, so the label is that tool and the number would be describing
     * something else; the CLI is too old to publish the figure (DROVE-220 — a
     * session running right now will not have picked up the new one); or the
     * model did no extended thinking this turn, which is honestly zero and a
     * `0` on the strip is furniture.
     */
    const thinkingOf = (): { thinkingTokens?: string } => (
        working && tally && tally.turnThinking > 0
            ? { thinkingTokens: formatTokens(tally.turnThinking) }
            : {}
    );
    if (status.main) {
        return {
            label,
            working,
            elapsed: formatElapsed(now - status.main.startedAt),
            ...tokensOf(rowTokens),
            ...thinkingOf(),
        };
    }
    const sideRunning = (status.agents?.length ?? 0) + (status.workflows?.length ?? 0) > 0;
    if (!status.tool && sideRunning) return null;
    const startedAt = status.turnStartedAt ?? status.tool?.startedAt;
    if (!startedAt) return null;
    return {
        label,
        working,
        elapsed: formatElapsed(now - startedAt),
        ...tokensOf(rowTokens),
        ...thinkingOf(),
    };
}

/**
 * The wrist's one line.
 *
 * A watch row is about 20 characters wide before it truncates, so this is not
 * the header strip with the fat trimmed — it is a different sentence. The
 * running tool's NAME without its argument, then the counts, because on a
 * wrist "how much is out" is the question and "which file" is not.
 *
 * The elapsed time is deliberately absent: the snapshot reaches the watch
 * through WatchConnectivity's application context, which is delivered
 * opportunistically and heartbeats only once a minute, so a duration baked in
 * here would be up to a minute wrong. `liveStatusSince` travels beside it and
 * the watch counts up from that itself.
 */
export function liveStatusWatchLine(status: LiveStatus | null | undefined, now: number): string | undefined {
    if (!isLiveStatusFresh(status, now)) return undefined;
    const live = status!;
    const parts: string[] = [];
    // The compaction leads, and it leads ALONE (DROVE-257). Twenty characters
    // is one fact wide, and while the session is rewriting its own history
    // that fact is not which grep is open.
    if (live.compacting) {
        const percent = typeof live.compacting.percent === 'number'
            ? ` ${Math.round(live.compacting.percent)}%`
            : '';
        return `${LIVE_STATUS_COMPACTING_WORD}${percent}`;
    }
    if (live.tool) parts.push(live.tool.name);
    const workflows = live.workflows ?? [];
    // THE RUN'S NAME, AND NOT ITS NUMBERS (DROVE-268).
    //
    // This segment used to carry `drover-relaunch 3/5` and the line then added
    // an agent count beside it, so the same fan-out was stated twice on a row
    // twenty characters wide — and stated as two different numbers, because
    // the count was `agents.length` and the strip's was `sideCount`, which
    // included the workflow. That is the drift DROVE-209 removed once and
    // DROVE-257 found back. There is one count on this line now and it comes
    // from the same function the strip calls; the run contributes its name,
    // which is the part the number cannot say.
    if (workflows.length > 0) parts.push(workflows[0].name);
    const workerPhrase = countPhrase(liveStatusWorkerCount(live), 'agent', 'agents');
    if (workerPhrase) parts.push(workerPhrase);
    if (parts.length === 0) parts.push(LIVE_STATUS_THINKING_WORD);
    return parts.join(' · ');
}

/**
 * When the thing the wrist line describes started, ISO-8601.
 *
 * The turn, not the tool: the wrist shows one number and the useful one is how
 * long Clay has been waiting, not how long the current grep has been going.
 */
export function liveStatusSince(status: LiveStatus | null | undefined, now: number): string | undefined {
    if (!isLiveStatusFresh(status, now)) return undefined;
    // A compaction gets its OWN clock, because the line above is about the
    // compaction and not about the turn (DROVE-257). The turn began whenever
    // Clay last typed, which on the session he photographed was hours before
    // the pass started; counting from there would put an hour beside the word
    // `compacting` and make the wrist disagree with the terminal's `1m 55s`.
    const started = status!.compacting?.startedAt
        ?? status!.turnStartedAt
        ?? status!.tool?.startedAt;
    return started ? new Date(started).toISOString() : undefined;
}
