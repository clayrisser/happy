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
     * Background agents plus workflows: the number beside the fold, and the
     * only thing on the row that speaks for the agents.
     */
    sideCount: number;
}

function agentRow(agent: LiveStatusAgent, now: number): LiveStatusRow {
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
    };
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
    };
}

function countPhrase(count: number, one: string, many: string): string | null {
    if (count <= 0) return null;
    return `${count} ${count === 1 ? one : many}`;
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
        });
    }
    for (const workflow of workflows) rows.push(workflowRow(workflow, now));
    for (const agent of agents) rows.push(agentRow(agent, now));

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
