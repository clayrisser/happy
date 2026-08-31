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

/**
 * How long a snapshot may sit before we stop drawing timers off it.
 *
 * The CLI republishes whenever anything moves and, at the very least, the
 * token counts of a running agent move constantly. A gap this wide means the
 * CLI stopped talking — the process died, the phone lost the socket — and a
 * timer that keeps counting past that is a lie dressed as live data. Same
 * argument as the wrist's own staleness check.
 */
export const LIVE_STATUS_STALE_MS = 120_000;

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

/** `851.9k`, `1.5M`, `940` — the terminal's own shape again. */
export function formatTokens(tokens: number): string {
    if (!Number.isFinite(tokens) || tokens <= 0) return '0';
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
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
    /** What the main thread is blocked on: the tool's name, or `working`. */
    label: string;
    /** The turn's clock, ticking on this device. */
    elapsed: string;
    /** `251.2k`, absent until the turn has spent anything. */
    tokens?: string;
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
     * Background agents plus workflows: the number beside the fold, the only
     * thing on the row that speaks for the agents, and THE ONE DERIVATION any
     * surface that counts agents reads (DROVE-155, DROVE-209, DROVE-185).
     *
     * The Morse heartbeat reads this field. It used to re-count by filtering
     * `rows` for `kind === 'agent'`, which is agents WITHOUT workflows, so the
     * wrist said two while the screen said three for as long as a workflow was
     * running — the exact disagreement DROVE-209 set out to remove, surviving
     * because its spec never put a workflow in the fixture. A workflow's own
     * agents are not in `agents` at all (the CLI collapses them into
     * done/total), so the workflow row IS those agents on this row; dropping
     * it undercounts the fan-out rather than tidying it.
     *
     * NESTED AGENTS COUNT, and they always did (DROVE-185). Every agent at
     * every depth is one entry in `agents`, so this number is unchanged by the
     * tree: a session that showed nine before shows nine now, folded. That is
     * the whole reason the rows stayed flat. They are also real work in
     * flight, and the question this number answers is how much is out.
     */
    sideCount: number;
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
        ...(childCount > 0 ? { childCount } : {}),
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

function workflowRow(workflow: LiveStatusWorkflow, now: number): LiveStatusRow {
    return {
        kind: 'workflow',
        key: `workflow:${workflow.id}`,
        title: workflow.name,
        ...(workflow.phase ? { detail: workflow.phase } : {}),
        // "launched", not "planned": the journal is append-only and nothing on
        // disk states how many agents a workflow will end up running, so this
        // rises as the run fans out. The terminal counts it the same way.
        progress: `${workflow.done}/${workflow.total} agents`,
        elapsed: formatElapsed(now - workflow.startedAt),
        ...(typeof workflow.tokens === 'number' && workflow.tokens > 0
            ? { tokens: formatTokens(workflow.tokens) }
            : {}),
        depth: 0,
    };
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
    for (const workflow of workflows) rows.push(workflowRow(workflow, now));
    // Ordered parent-then-child and stamped with a depth (DROVE-185). Same
    // rows, same number of them, in an order that can be drawn as a tree.
    for (const row of orderAgentRows(agents, now)) rows.push(row);

    // The headline is what Clay sees without expanding anything, so it names
    // the most specific thing running. A tool beats a fan-out because the tool
    // is what the turn is blocked on.
    let headline: string;
    if (status.tool) {
        const elapsed = formatElapsed(now - status.tool.startedAt);
        headline = status.tool.arg
            ? `${status.tool.name} · ${status.tool.arg} · ${elapsed}`
            : `${status.tool.name} · ${elapsed}`;
    } else if (workflows.length > 0) {
        const workflow = workflows[0];
        headline = `${workflow.name} · ${workflow.done}/${workflow.total} agents`;
    } else if (agents.length > 0) {
        headline = countPhrase(agents.length, 'agent running', 'agents running')!;
    } else {
        // Busy, with nothing on disk to name it: the model is composing a
        // reply, which writes nothing until it is done. This is the
        // "Sketching… 17m 13s" state, and saying "working" is the honest
        // version of it.
        headline = 'working';
    }

    const parts = [
        countPhrase(agents.length, 'agent', 'agents'),
        countPhrase(workflows.length, 'workflow', 'workflows'),
    ].filter((part): part is string => part !== null);

    return {
        headline,
        ...(status.turnStartedAt ? { turnElapsed: formatElapsed(now - status.turnStartedAt) } : {}),
        rows,
        ...(parts.length > 0 ? { subtitle: parts.join(' · ') } : {}),
        main: mainReadout(status, now),
        sideCount: agents.length + workflows.length,
    };
}

/**
 * The main thread's own line, or null when the main thread is not what is
 * running (DROVE-155).
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
function mainReadout(status: LiveStatus, now: number): LiveStatusMain | null {
    const label = status.tool ? status.tool.name : 'working';
    const tokensOf = (tokens: unknown): { tokens?: string } => (
        typeof tokens === 'number' && tokens > 0 ? { tokens: formatTokens(tokens) } : {}
    );
    if (status.main) {
        return {
            label,
            elapsed: formatElapsed(now - status.main.startedAt),
            ...tokensOf(status.main.tokens),
        };
    }
    const sideRunning = (status.agents?.length ?? 0) + (status.workflows?.length ?? 0) > 0;
    if (!status.tool && sideRunning) return null;
    const startedAt = status.turnStartedAt ?? status.tool?.startedAt;
    if (!startedAt) return null;
    return { label, elapsed: formatElapsed(now - startedAt) };
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
    if (live.tool) parts.push(live.tool.name);
    const workflows = live.workflows ?? [];
    if (workflows.length > 0) {
        const workflow = workflows[0];
        parts.push(`${workflow.name} ${workflow.done}/${workflow.total}`);
    }
    const agents = live.agents ?? [];
    const agentPhrase = countPhrase(agents.length, 'agent', 'agents');
    if (agentPhrase) parts.push(agentPhrase);
    if (parts.length === 0) parts.push('working');
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
    const started = status!.turnStartedAt ?? status!.tool?.startedAt;
    return started ? new Date(started).toISOString() : undefined;
}
