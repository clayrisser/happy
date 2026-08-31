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
     * The one-line composer row's version (DROVE-82): a state word short
     * enough to share a line with the branch and the quota, and the clock
     * Clay is actually waiting on. `Bash`, `2 agents`, `drover-relaunch 3/5`,
     * or `working` when nothing on disk names the work.
     */
    compact: {
        label: string;
        /** The turn's timer, or the running thing's own when the CLI never saw the prompt. */
        elapsed?: string;
    };
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

    // Same precedence as the headline, minus the argument: the argument is
    // what the tree is for, and the row has a branch name to fit beside it.
    let compactLabel: string;
    if (status.tool) {
        compactLabel = status.tool.name;
    } else if (workflows.length > 0) {
        compactLabel = `${workflows[0].name} ${workflows[0].done}/${workflows[0].total}`;
    } else if (agents.length > 0) {
        compactLabel = countPhrase(agents.length, 'agent', 'agents')!;
    } else {
        compactLabel = 'working';
    }
    const compactStartedAt = status.turnStartedAt
        ?? status.tool?.startedAt
        ?? workflows[0]?.startedAt
        ?? agents[0]?.startedAt;

    return {
        headline,
        ...(status.turnStartedAt ? { turnElapsed: formatElapsed(now - status.turnStartedAt) } : {}),
        rows,
        ...(parts.length > 0 ? { subtitle: parts.join(' · ') } : {}),
        compact: {
            label: compactLabel,
            ...(compactStartedAt ? { elapsed: formatElapsed(now - compactStartedAt) } : {}),
        },
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
