import { InvalidateSync } from "@/utils/sync";
import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { parseClaudeGoalStatusTranscriptEvent, type ClaudeGoalStatusTranscriptEvent } from "../claudeGoalStatus";
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { logger } from "@/ui/logger";
import { startFileWatcher } from "@/modules/watcher/startFileWatcher";
import { getProjectPath } from "./path";
import type { CompactionLatch } from "./compaction";
import { createLiveStatusReader, LiveStatusPublisher, type LiveStatus } from "./liveStatus";
import { createSubagentTranscriptReader, type SubagentTranscriptRequest, type SubagentTranscriptResponse } from "./subagentTranscript";
import { createWorkflowDetailReader } from "./workflowDetail";
import type { WorkflowDetailRequest, WorkflowDetailResponse } from "@slopus/happy-wire";
import { parseAgentNotifications, type AgentNotification } from "./agentNotification";

/**
 * Known internal Claude Code event types that should be silently skipped.
 * These are written to session JSONL files by Claude Code but are not 
 * actual conversation messages - they're internal state/tracking events.
 */
const INTERNAL_CLAUDE_EVENT_TYPES = new Set([
    'file-history-snapshot',
    'change',
]);

export type ScannerTranscriptEvent = ClaudeGoalStatusTranscriptEvent;

/**
 * A prompt typed at the keyboard while Claude was mid-turn (DROVE-41).
 *
 * Claude Code does not start a turn with it. It queues the text and writes
 * two records instead, neither of which is a conversation message:
 *
 *   queue-operation   `{operation:'enqueue', content}` the instant it is typed
 *   attachment        `{attachment:{type:'queued_command', prompt}}` when the
 *                     running turn absorbs it
 *
 * Whether a `user` record ever follows depends on which way it leaves the
 * queue. Counted over Clay's live session: 26 prompts queued, 6 dequeued into
 * a real `user` turn and 20 absorbed mid-turn with no `user` record at all.
 * Those 20 are the messages he typed and never saw on his phone.
 *
 * Both carriers are reported, because pairing them here is not reliable: the
 * absorb record repeats the enqueue timestamp but only to the millisecond,
 * and one of the 23 pairs on disk was 1ms out. The consumer pairs them by
 * text instead, which is exact.
 */
export type ScannerQueuedPrompt = {
    /** What the human typed, before Claude Code wraps it for the model. */
    text: string
    /** When it was queued, ms since epoch. 0 if the record carried no time. */
    at: number
    /** Which record this came from. See the pairing note above. */
    carrier: 'enqueue' | 'absorbed'
    /** Set only on the absorb record — the enqueue record has no uuid. */
    claudeUuid?: string
};

/**
 * What the pane is ACTUALLY running, read off the transcript (DROVE-45).
 *
 * Every real assistant turn carries `message.model` (a full id like
 * `claude-opus-5`) and a top-level `effort` (`xhigh`, `high`, ...). The app's
 * picker used to show its own stored preference instead, so it read "Fable 5"
 * while Opus answered. This is the correction, and it is also the only way a
 * `/model` typed in the terminal ever reaches the phone.
 *
 * `<synthetic>` is excluded: that model id marks a harness notice (a limit
 * warning, an interrupt) rather than a turn the model actually took, and those
 * records carry no effort at all.
 */
export interface ObservedRun {
    model: string;
    effort: string | null;
}

/**
 * Whether Remote Control is on for this session RIGHT NOW (DROVE-63).
 *
 * Nothing on disk answers this outside the transcript. `~/.claude.json` carries
 * `hasUsedRemoteControl`, `remoteControlSurfacesSeen` and
 * `remoteControlReadyPushKey`, and all three are global "ever / how many times"
 * counters for the upsell — measured on Clay's machine, `hasUsedRemoteControl`
 * is true for the whole install while three of the five per-account config dirs
 * do not carry the key at all. A button reading those would say "on" for every
 * session forever.
 *
 * Claude Code does write the real answer, once per transition, as its own
 * record type:
 *
 *     {"type":"bridge-session","sessionId":"…","bridgeSessionId":"cse_01…", …}
 *     {"type":"bridge-session","sessionId":"…","bridgeSessionId":"","lastSequenceNum":0}
 *
 * A non-empty `bridgeSessionId` is a live bridge; the empty one is the teardown.
 * Counted over 14 days of Clay's transcripts: 6649 non-empty, 101 empty. The
 * empty one is written for all three ways it goes off — `/remote-control` typed
 * to disconnect, the process shutting the bridge down, and the DROVE-37 account
 * teardown, which writes `system/informational` ("Remote Control disconnected —
 * signed-in claude.ai account or organization changed on this machine") and then
 * the empty record. So one field covers every case, including the one the button
 * exists to fix.
 *
 * The record fails RawJSONLinesSchema, so the scanner used to drop it.
 */
type SessionLogEntry =
    | { kind: 'message'; key: string; message: RawJSONLines }
    | { kind: 'transcript-event'; key: string; event: ScannerTranscriptEvent }
    | { kind: 'custom-title'; key: string; title: string }
    | { kind: 'permission-mode'; key: string; mode: string }
    | { kind: 'queued-prompt'; key: string; prompt: ScannerQueuedPrompt }
    | { kind: 'bridge-session'; key: string; active: boolean }
    | { kind: 'agent-notification'; key: string; notification: AgentNotification };

export async function createSessionScanner(opts: {
    sessionId: string | null,
    workingDirectory: string
    /**
     * Which account's config dir the transcripts live in. Omitted means the
     * one this process was started on. A Cattle Drover flip changes it mid
     * session via setClaudeConfigDir below.
     */
    claudeConfigDir?: string | null
    onMessage: (message: RawJSONLines) => void
    /**
     * A background agent has stopped (DROVE-115).
     *
     * Fires once per agent per status, whichever of the three records carried
     * the `<task-notification>` — and two of the three never reach onMessage
     * at all, which is the whole reason this is its own callback rather than
     * something the message stream could be read for. See agentNotification.ts.
     */
    onAgentNotification?: (notification: AgentNotification) => void
    onTranscriptEvent?: (event: ScannerTranscriptEvent) => void
    /**
     * Claude Code's own `/rename`, mirrored into the Happy session title.
     *
     * These are two different names for one session and nothing used to
     * connect them: `/rename zap` writes a `custom-title` record into the
     * transcript and relabels the TUI, while the phone reads
     * metadata.summary.text, which only the happy__change_title MCP tool ever
     * wrote. So Clay renamed a session to "zap", looked at the app, and saw
     * "Greeting / no task yet" — the rename appeared to do nothing, and the
     * session he was staring at looked like a different one.
     *
     * The record is right there in the file the scanner already reads, and it
     * failed RawJSONLinesSchema, so it was dropped as an unknown type.
     */
    onCustomTitle?: (title: string) => void
    /**
     * A prompt typed at the terminal while Claude was busy (DROVE-41). Fires
     * once per carrier record; see ScannerQueuedPrompt for why both are
     * reported and who pairs them.
     */
    onQueuedPrompt?: (prompt: ScannerQueuedPrompt) => void
    /**
     * The model and effort the newest real assistant turn ran under, reported
     * whenever it changes (DROVE-45). Fires once on startup with whatever the
     * transcript already says, so a session resumed on the phone shows the
     * right model without waiting for a new turn — the same last-one-wins rule
     * `onCustomTitle` follows, and for the same reason.
     */
    onRunObserved?: (run: ObservedRun) => void
    /**
     * The permission mode the pane is ACTUALLY in, reported whenever it
     * changes (DROVE-36).
     *
     * Claude Code writes a `{"type":"permission-mode","permissionMode":...}`
     * record into the transcript as part of the state block it appends around
     * every prompt — 123 of them in one of Clay's sessions, one per turn,
     * always reading the mode in force at that point. So this is the same
     * last-one-wins shape onRunObserved uses, and for the same reason: the app
     * showed a stored PICK where the terminal had its own answer.
     *
     * It is a per-turn snapshot, not a keystroke feed. A shift+tab at an idle
     * prompt does not append one, so this is the right source for what to SHOW
     * on the phone and the wrong one for driving a mode change — that reads
     * the pane's own footer instead (panePermissionSync.ts).
     */
    onPermissionModeObserved?: (mode: string) => void
    /**
     * Whether Remote Control is on for this session, reported whenever it
     * changes and once at startup with whatever the transcript already says
     * (DROVE-63). Same last-one-wins rule as `onRunObserved`, and for the same
     * reason: the answer is a level, not an event, so on -> off -> on has to
     * report `on` the second time.
     */
    onRemoteControlObserved?: (active: boolean) => void
    /**
     * What the pane is doing RIGHT NOW, throttled (DROVE-54).
     *
     * Lives here rather than in the launcher because the scanner is already
     * the thing that knows WHICH transcript to read: it owns the project dir,
     * it follows a flip into another account's config dir, and it is told the
     * session id by the SessionStart hook. A second copy of that plumbing is
     * how the flip left the old scanner reading a dead file for a whole
     * session.
     *
     * Fires with `null` exactly once when the session goes idle, and not at
     * all while it stays idle. See liveStatus.ts.
     */
    onLiveStatus?: (status: LiveStatus | null) => void
    /** How often the live status is re-read off disk. Defaults to 1s. */
    liveStatusIntervalMs?: number
    /**
     * The process's own "an API call is in flight" flag, when the caller has
     * one (claudeLocal watches fd 3 for it). Disk cannot see the model
     * thinking — nothing is written while it composes — so without this the
     * turn timer stops during exactly the "Sketching… 17m 13s" state Clay
     * photographed.
     */
    isThinking?: () => boolean
    /**
     * The compaction pass in flight, when the caller is tracking one
     * (DROVE-257). Opened by the `PreCompact` hook, closed by the
     * `compact_boundary` record the live status reader already tails.
     */
    compaction?: CompactionLatch
    /**
     * How long a session transcript may stay absent before its watcher gives
     * up and the session is dropped. Defaults to the startFileWatcher default
     * (60s). Exposed mainly so tests can exercise the drop path quickly.
     */
    missingFileTimeoutMs?: number
}) {

    // Resolve project directory. `let`, not `const`: a Cattle Drover flip
    // (BASED-98) carries the transcript into another account's config dir and
    // relaunches the child there, so the directory we poll has to move with
    // it. Snapshotting it here is what left the scanner reading the old
    // account's file forever after a flip, which muted the session in the app.
    let projectDir = getProjectPath(opts.workingDirectory, opts.claudeConfigDir);

    // Finished, pending finishing and current session
    let finishedSessions = new Set<string>();
    let pendingSessions = new Set<string>();
    let currentSessionId: string | null = null;
    let watchers = new Map<string, (() => void)>();
    let processedEntryKeys = new Set<string>();
    // Sessions whose transcript file never appeared. Their watcher gave up,
    // so we must stop re-reading them and never re-create a watcher for them
    // — otherwise a phantom session id (e.g. a remote launch whose .jsonl is
    // never written) keeps itself alive forever via the watchers map below
    // and spins the CPU / floods the log (the "dead Happy instance" bug).
    let deadSessions = new Set<string>();
    // The last model/effort we told the caller about. NOT keyed through
    // processedEntryKeys like a message is: a run is a level, not an event, so
    // switching opus -> sonnet -> opus has to report opus the second time, and
    // a per-uuid key would swallow it. Last one wins, compared by value.
    let lastObservedRun: ObservedRun | null = null;
    // Same shape, same argument, for the permission mode (DROVE-36). Claude
    // Code re-appends the record every turn even when nothing changed, so the
    // repetition is filtered on the way out rather than by keying the entry.
    let lastObservedPermissionMode: string | null = null;
    // Same shape as lastObservedRun, for the same reason (DROVE-63). null means
    // nothing has been read yet, which is NOT the same as off — the launcher
    // refuses to type the toggle while the answer is unknown.
    let lastObservedRemoteControl: boolean | null = null;
    // Size and mtime of each transcript as of the last pass that actually read
    // it. Per scanner instance, never module-global: a stale entry left by an
    // earlier scanner would make the next one skip a file whose entries it has
    // not marked, and those messages would never reach the app.
    let lastRead = new Map<string, { size: number, mtimeMs: number }>();

    // The title last handed to the caller. Claude Code re-appends the same
    // custom-title record on every start — 69 copies of "DROVER" in one of
    // Clay's transcripts — and each report is a metadata write that reaches
    // the phone, so the repetition is filtered HERE rather than by keying the
    // entry on its text. Keying on the text is what made renaming back to a
    // title used earlier in the run a permanent no-op (DROVE-15).
    let lastReportedTitle: string | null = null;
    const reportTitle = (title: string, why: string) => {
        if (title === lastReportedTitle) return;
        lastReportedTitle = title;
        logger.debug(`[SESSION_SCANNER] ${why}: ${title}`);
        opts.onCustomTitle?.(title);
    };

    /**
     * Apply the newest title in a transcript we are about to mark as history.
     *
     * Messages are marked processed so a reattach does not replay the whole
     * conversation at the app. A TITLE is not a replay — it is the current
     * NAME of this session — so it has to survive the mark, or a session
     * renamed in an EARLIER run comes back under whatever stale title the app
     * had. Last one wins, because that is what /rename means.
     */
    const seedTitleFrom = (entries: SessionLogEntry[]) => {
        const seeded = entries.filter((e) => e.kind === 'custom-title').pop();
        if (seeded?.kind === 'custom-title') {
            reportTitle(seeded.title, 'Seeding title from transcript');
        }
    };

    // Mark existing entries as processed and start watching the initial session
    if (opts.sessionId) {
        let entries = await readSessionEntries(projectDir, opts.sessionId);
        logger.debug(`[SESSION_SCANNER] Marking ${entries.length} existing entries as processed from session ${opts.sessionId}`);
        for (let entry of entries) {
            processedEntryKeys.add(entry.key);
        }
        // Same argument as the title, for the same reason: the model this
        // session is running is its CURRENT state, already on disk, and
        // marking it processed would leave the app showing a stale pick until
        // the next turn (DROVE-45).
        reportRun(latestRunFromEntries(entries));
        reportPermissionMode(latestPermissionModeFromEntries(entries));
        reportRemoteControl(latestRemoteControlFromEntries(entries));
        seedTitleFrom(entries);
        // IMPORTANT: Also start watching the initial session file because Claude Code
        // may continue writing to it even after creating a new session with --resume
        // (agent tasks and other updates can still write to the original session file)
        currentSessionId = opts.sessionId;
    }

    /** Tell the caller about a run only when it is genuinely different. */
    function reportRun(run: ObservedRun | null): void {
        if (!run) return;
        if (lastObservedRun && lastObservedRun.model === run.model && lastObservedRun.effort === run.effort) {
            return;
        }
        lastObservedRun = run;
        logger.debug(`[SESSION_SCANNER] Pane is running ${run.model} at effort ${run.effort ?? 'unset'}`);
        opts.onRunObserved?.(run);
    }

    /** Tell the caller about a permission mode only when it actually moved. */
    function reportPermissionMode(mode: string | null): void {
        if (!mode) return;
        if (lastObservedPermissionMode === mode) return;
        lastObservedPermissionMode = mode;
        logger.debug(`[SESSION_SCANNER] Pane is in permission mode ${mode}`);
        opts.onPermissionModeObserved?.(mode);
    }

    /** Same, for Remote Control (DROVE-63). Unknown stays unknown. */
    function reportRemoteControl(active: boolean | null): void {
        if (active === null) return;
        if (lastObservedRemoteControl === active) return;
        lastObservedRemoteControl = active;
        logger.debug(`[SESSION_SCANNER] Remote Control is ${active ? 'on' : 'off'} for this session`);
        opts.onRemoteControlObserved?.(active);
    }

    // Main sync function
    const sync = new InvalidateSync(async () => {

        // Collect session ids - include ALL sessions that have watchers
        // This ensures we continue processing sessions that Claude Code may still write to
        let sessions: string[] = [];
        for (let p of pendingSessions) {
            if (!deadSessions.has(p)) {
                sessions.push(p);
            }
        }
        if (currentSessionId && !pendingSessions.has(currentSessionId) && !deadSessions.has(currentSessionId)) {
            sessions.push(currentSessionId);
        }
        // Also process sessions that have active watchers (they may still receive updates)
        for (let [sessionId] of watchers) {
            if (!sessions.includes(sessionId) && !deadSessions.has(sessionId)) {
                sessions.push(sessionId);
            }
        }

        // Process sessions
        for (let session of sessions) {
            // A transcript that has not changed a byte cannot hold anything
            // new, and re-reading one is not cheap. readSessionEntries pulls
            // the WHOLE file into a string, splits it and JSON.parses every
            // line; on Clay's live session — 182MB, 63k lines — that is 701ms
            // measured, and InvalidateSync fires it every ~1.4s for as long as
            // the session is open. The result was `found=19266, skipped=19266`
            // over and over and one core pinned at 99% for five and a half
            // hours on a session doing NOTHING. stat() is 0ms.
            //
            // The stat is taken BEFORE the read and stored after, so a write
            // that lands mid-read records the pre-read size and is picked up
            // next pass. Erring toward one redundant read, never toward a lost
            // message.
            const transcript = join(projectDir, `${session}.jsonl`);
            let seen: { size: number, mtimeMs: number } | null = null;
            try {
                const st = await stat(transcript);
                seen = { size: st.size, mtimeMs: st.mtimeMs };
            } catch {
                seen = null;
            }
            const prev = lastRead.get(transcript);
            if (seen && prev && prev.size === seen.size && prev.mtimeMs === seen.mtimeMs) {
                continue;
            }
            const sessionEntries = await readSessionEntries(projectDir, session);
            if (seen) {
                lastRead.set(transcript, seen);
            }
            let skipped = 0;
            let sentMessages = 0;
            let sentTranscriptEvents = 0;
            for (let entry of sessionEntries) {
                if (processedEntryKeys.has(entry.key)) {
                    skipped++;
                    continue;
                }
                processedEntryKeys.add(entry.key);
                if (entry.kind === 'message') {
                    logger.debug(`[SESSION_SCANNER] Sending new message: type=${entry.message.type}, uuid=${entry.message.type === 'summary' ? entry.message.leafUuid : entry.message.uuid}`);
                    opts.onMessage(entry.message);
                    sentMessages++;
                } else if (entry.kind === 'custom-title') {
                    reportTitle(entry.title, 'Session renamed in Claude Code');
                } else if (entry.kind === 'permission-mode') {
                    // Reported from the same last-one-wins pass below, so
                    // nothing to do per entry — marking it processed is what
                    // this branch is for. Without it the record falls through
                    // to the transcript-event branch and asks for a uuid it
                    // does not have.
                } else if (entry.kind === 'queued-prompt') {
                    logger.debug(`[SESSION_SCANNER] Prompt queued in the terminal (${entry.prompt.carrier})`);
                    opts.onQueuedPrompt?.(entry.prompt);
                } else if (entry.kind === 'agent-notification') {
                    logger.debug(`[SESSION_SCANNER] Agent ${entry.notification.agentId} reported ${entry.notification.status}`);
                    opts.onAgentNotification?.(entry.notification);
                } else if (entry.kind === 'bridge-session') {
                    // Nothing per-record: Remote Control is a level, and the
                    // newest record for the whole file is reported below. This
                    // branch exists so the record does not fall through to the
                    // transcript-event else and get sent with an undefined
                    // event (DROVE-63).
                } else {
                    logger.debug(`[SESSION_SCANNER] Sending new transcript event: type=${entry.event.type}, uuid=${entry.event.uuid}`);
                    opts.onTranscriptEvent?.(entry.event);
                    sentTranscriptEvents++;
                }
            }
            // Only the session on screen says what the pane is running. A
            // still-watched older transcript can gain a late subagent record
            // long after its Claude is gone, and letting that overwrite the
            // current model is exactly the stale reading DROVE-45 is about.
            if (!currentSessionId || session === currentSessionId) {
                reportRun(latestRunFromEntries(sessionEntries));
                reportPermissionMode(latestPermissionModeFromEntries(sessionEntries));
                reportRemoteControl(latestRemoteControlFromEntries(sessionEntries));
            }
            if (sessionEntries.length > 0) {
                logger.debug(`[SESSION_SCANNER] Session ${session}: found=${sessionEntries.length}, skipped=${skipped}, sentMessages=${sentMessages}, sentTranscriptEvents=${sentTranscriptEvents}`);
            }
        }

        // Move pending sessions to finished sessions (but keep processing them via watchers)
        for (let p of sessions) {
            if (pendingSessions.has(p)) {
                pendingSessions.delete(p);
                finishedSessions.add(p);
            }
        }

        // Update watchers for all sessions
        for (let p of sessions) {
            if (!watchers.has(p) && !deadSessions.has(p)) {
                logger.debug(`[SESSION_SCANNER] Starting watcher for session: ${p}`);
                watchers.set(p, startFileWatcher(
                    join(projectDir, `${p}.jsonl`),
                    () => { sync.invalidate(); },
                    {
                        missingFileTimeoutMs: opts.missingFileTimeoutMs,
                        onGaveUp: () => {
                            // The transcript for this session never appeared.
                            // Tear the watcher down and blacklist the session
                            // so the collection loop above stops resurrecting
                            // it. Without this the phantom session would keep
                            // itself in `watchers` forever.
                            logger.debug(`[SESSION_SCANNER] Session ${p} transcript never appeared — dropping it`);
                            watchers.get(p)?.();
                            watchers.delete(p);
                            deadSessions.add(p);
                            pendingSessions.delete(p);
                        },
                    },
                ));
            }
        }
    });
    await sync.invalidateAndAwait();

    // Periodic sync
    const intervalId = setInterval(() => { sync.invalidate(); }, 3000);

    // DROVE-54: the live task tree. Only wired when a caller asked for it, so
    // the remote launcher and runClaude's own scanners cost nothing.
    let liveStatusTimer: ReturnType<typeof setInterval> | null = null;
    let liveStatusPublisher: LiveStatusPublisher | null = null;
    if (opts.onLiveStatus) {
        const onLiveStatus = opts.onLiveStatus;
        const reader = createLiveStatusReader({
            projectDir,
            sessionId: currentSessionId,
            isThinking: opts.isThinking,
            compaction: opts.compaction,
        });
        liveStatusPublisher = new LiveStatusPublisher((status) => {
            try {
                onLiveStatus(status);
            } catch (error) {
                logger.debug('[SESSION_SCANNER] live status consumer threw', error);
            }
        });
        liveStatusTimer = setInterval(() => {
            try {
                // Re-stated every tick rather than pushed on change: both move
                // for reasons this block does not observe (the hook names the
                // session, a flip re-points the dir), and both are cheap
                // no-ops when nothing moved.
                reader.setProjectDir(projectDir);
                reader.setSessionId(currentSessionId);
                liveStatusPublisher?.sync(reader.read());
            } catch (error) {
                logger.debug('[SESSION_SCANNER] live status read failed', error);
            }
        }, opts.liveStatusIntervalMs ?? 1000);
        liveStatusTimer.unref?.();
    }

    // DROVE-93: a subagent's transcript on demand. Lives on the scanner for
    // the same reason the live status does: this is the thing that knows
    // which project dir and which session id to read, flip included.
    const subagentTranscripts = createSubagentTranscriptReader({
        getProjectDir: () => projectDir,
        getSessionId: () => currentSessionId,
    });

    // DROVE-290: a workflow run's wave view on demand, same ownership rule.
    const workflowDetails = createWorkflowDetailReader({
        getProjectDir: () => projectDir,
        getSessionId: () => currentSessionId,
    });

    // Public interface
    return {
        /** The agent's transcript rows appended since `since`. See subagentTranscript.ts. */
        readSubagentTranscript: (request: SubagentTranscriptRequest): SubagentTranscriptResponse =>
            subagentTranscripts.read(request),
        /** One workflow run folded into waves. See workflowDetail.ts (DROVE-290). */
        readWorkflowDetail: (request: WorkflowDetailRequest): WorkflowDetailResponse =>
            workflowDetails.read(request),
        cleanup: async () => {
            clearInterval(intervalId);
            if (liveStatusTimer) {
                clearInterval(liveStatusTimer);
                liveStatusTimer = null;
            }
            // One last write so a session that ends mid-turn does not leave a
            // running timer on the phone forever.
            liveStatusPublisher?.sync(null);
            liveStatusPublisher?.dispose();
            liveStatusPublisher = null;
            for (let w of watchers.values()) {
                w();
            }
            watchers.clear();
            await sync.invalidateAndAwait();
            sync.stop();
        },
        /**
         * Follow the session into another account's config dir after a Cattle
         * Drover flip carried its transcript there.
         *
         * We re-read the carried file from the top and keep processedEntryKeys
         * instead of resuming at an offset or pre-marking the new file as
         * processed. Three reasons, in order of how much they cost when you
         * get them wrong:
         *
         *   - Nothing is duplicated to the phone. Dedupe is by message uuid,
         *     not by byte offset, and carryTranscript copies the file verbatim,
         *     so every entry we already sent keeps the key we already hold.
         *   - Nothing is lost. Anything Claude appended between our last poll
         *     and the kill is in the carried copy and still unsent, so it goes
         *     out now. Pre-marking the file as processed (what
         *     treatExistingAsProcessed does on the first hook of a run) would
         *     silently eat exactly those last messages. This is why the two
         *     have to stay distinguishable however far that guard is widened:
         *     a flip carries OUR unsent tail, a resume carries only history.
         *     The launcher keeps them apart by firing the guard on the first
         *     SessionStart hook of a run only, and a flip always relaunches
         *     past that point.
         *   - Byte offsets do not survive the move anyway. The resumed child
         *     rewrites the tail of the transcript, so the same logical entry
         *     can sit at a different offset in the new file.
         */
        setClaudeConfigDir: (claudeConfigDir: string | null | undefined) => {
            const next = getProjectPath(opts.workingDirectory, claudeConfigDir);
            if (next === projectDir) {
                return;
            }
            logger.debug(`[SESSION_SCANNER] Re-pointing scanner: ${projectDir} -> ${next}`);
            projectDir = next;
            // Watchers hold absolute paths under the old dir, so they are dead
            // to us now. Drop them and let the sync loop below rebuild one per
            // session against the new dir.
            for (const w of watchers.values()) {
                w();
            }
            watchers.clear();
            // "The transcript never appeared" was a verdict about the OLD
            // account. The carried copy exists here, so it no longer holds.
            deadSessions.clear();
            sync.invalidate();
        },
        onNewSession: async (sessionId: string, options?: { treatExistingAsProcessed?: boolean }) => {
            if (currentSessionId === sessionId) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is the same as the current session, skipping`);
                return;
            }
            // The caller explicitly re-announces this session, so give a
            // previously-dropped id another chance (its file may exist now).
            if (deadSessions.delete(sessionId)) {
                logger.debug(`[SESSION_SCANNER] Reviving previously-dropped session: ${sessionId}`);
            }
            if (finishedSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already finished, skipping`);
                return;
            }
            if (pendingSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already pending, skipping`);
                return;
            }
            // When what is on disk is history rather than activity, pre-mark
            // it so the first invalidate() does not replay the entire file as
            // fresh user prompts. Without this, every previous user message
            // re-appears in the chat after a reconnect, and on a resume of a
            // long transcript the app streams days of old messages — Clay's
            // 190 MB session, restreamed on every `drover --resume`.
            //
            // Callers: the remote path always sets it (every prompt there
            // reaches the server before it hits disk), and the local launcher
            // sets it on the FIRST SessionStart hook of a run pointed at an
            // existing transcript. See the entry-path table in
            // claudeLocalLauncher.ts for which of those are which.
            if (options?.treatExistingAsProcessed) {
                const existing = await readSessionEntries(projectDir, sessionId);
                logger.debug(`[SESSION_SCANNER] Pre-marking ${existing.length} existing entries as processed for new session ${sessionId}`);
                for (const entry of existing) {
                    processedEntryKeys.add(entry.key);
                }
                // ...but NOT the title. Same reasoning as the constructor
                // above, and the constructor was the only half that had it
                // (DROVE-44). A title is the session's current NAME, not a
                // message to replay, so pre-marking it means a session renamed
                // in an earlier run keeps the start-up default in the app for
                // the whole of this run.
                //
                // This is the path a bare `drover --resume` takes, which is
                // how Clay's "DROVER" showed up on the phone as
                // "[jamrizzi] cattle-drover": the seed never ran, the name
                // stayed default-shaped, and a flip is entitled to restamp a
                // default-shaped name with the account it just moved to.
                seedTitleFrom(existing);
            }
            if (currentSessionId) {
                pendingSessions.add(currentSessionId);
            }
            logger.debug(`[SESSION_SCANNER] New session: ${sessionId}`)
            currentSessionId = sessionId;
            sync.invalidate();
        },
    }
}

export type SessionScanner = ReturnType<typeof createSessionScanner>;


//
// Helpers
//

function messageKey(message: RawJSONLines): string {
    if (message.type === 'user') {
        return message.uuid;
    } else if (message.type === 'assistant') {
        return message.uuid;
    } else if (message.type === 'summary') {
        return 'summary: ' + message.leafUuid + ': ' + message.summary;
    } else if (message.type === 'system') {
        return message.uuid;
    } else {
        throw Error() // Impossible
    }
}

/**
 * The model and effort of the newest REAL assistant turn in `entries`, or null
 * when there is none (DROVE-45).
 *
 * Walks backwards and stops at the first hit, because the answer is a level and
 * only the newest one is current. `<synthetic>` is skipped: Claude Code stamps
 * that model id on harness notices — a usage-limit warning, an interrupt — and
 * those are not turns any model took. Measured on a live transcript: real
 * entries read `claude-opus-5` / `claude-fable-5` with `effort: "xhigh"`, the
 * one synthetic entry reads `<synthetic>` with no effort at all.
 *
 * `effort` sits at the TOP level of the record, not inside `message`, and it
 * survives here only because RawJSONLinesSchema passes unknown keys through.
 */
function latestRunFromEntries(entries: SessionLogEntry[]): ObservedRun | null {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.kind !== 'message' || entry.message.type !== 'assistant') continue;
        const raw = entry.message as { message?: { model?: unknown }, effort?: unknown };
        const model = raw.message?.model;
        if (typeof model !== 'string' || model.length === 0 || model === '<synthetic>') continue;
        return { model, effort: typeof raw.effort === 'string' ? raw.effort : null };
    }
    return null;
}

/**
 * The newest permission mode in `entries`, or null when the transcript has not
 * recorded one yet (DROVE-36).
 *
 * Backwards to the first hit, like latestRunFromEntries and for the same
 * reason: a mode is a level, and only the newest one is current.
 */
function latestPermissionModeFromEntries(entries: SessionLogEntry[]): string | null {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.kind === 'permission-mode') return entry.mode;
    }
    return null;
}

/**
 * Whether Remote Control is on, per the newest `bridge-session` record, or null
 * when the transcript has none (DROVE-63).
 *
 * Null is deliberately not `false`. A transcript that has never carried a
 * bridge record is one this scanner has no opinion about — it may simply not
 * have been read yet — and the launcher must not type a toggle on a guess. The
 * caller that wants "no record means off" has to say so itself.
 *
 * A reconnect writes the empty record and the new one back to back (measured:
 * lines 1829/1830 of one of Clay's transcripts, same millisecond bracket), so
 * reading the newest rather than the first is what stops a reconnect looking
 * like a disconnect. The scanner reads whole files, so both land in one pass
 * almost always.
 */
function latestRemoteControlFromEntries(entries: SessionLogEntry[]): boolean | null {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.kind === 'bridge-session') return entry.active;
    }
    return null;
}

function transcriptEventKey(event: ScannerTranscriptEvent): string {
    return `event:${event.uuid}`;
}

/**
 * Read and parse session log file
 * Returns only valid conversation messages and recognized side-channel events,
 * silently skipping internal events.
 */
async function readSessionEntries(projectDir: string, sessionId: string): Promise<SessionLogEntry[]> {
    const expectedSessionFile = join(projectDir, `${sessionId}.jsonl`);
    logger.debug(`[SESSION_SCANNER] Reading session file: ${expectedSessionFile}`);
    let file: string;
    try {
        file = await readFile(expectedSessionFile, 'utf-8');
    } catch (error) {
        logger.debug(`[SESSION_SCANNER] Session file not found: ${expectedSessionFile}`);
        return [];
    }
    let lines = file.split('\n');
    let entries: SessionLogEntry[] = [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const l = lines[lineIndex];
        try {
            if (l.trim() === '') {
                continue;
            }
            let message = JSON.parse(l);

            // DROVE-115: before every skip below, because Claude Code writes
            // the notification onto a queue-operation and an attachment as
            // well as a user turn, and the first two are dropped further down.
            // Keyed by agent and status so the same completion arriving on all
            // three carriers is reported exactly once. Deliberately NOT a
            // `continue`: the record it rode in on is still whatever it was.
            // The substring guard matters: this runs on every line of a
            // transcript that reaches 13 MB, re-read on every poll, and the
            // tags survive JSON encoding, so one scan of the raw line keeps
            // the parser off 99.9% of records.
            for (const notification of l.includes('<task-notification>') ? parseAgentNotifications(message) : []) {
                entries.push({
                    kind: 'agent-notification',
                    key: `agent-notification:${notification.agentId}:${notification.status}`,
                    notification,
                });
            }

            // Silently skip known internal Claude Code events
            // These are state/tracking events, not conversation messages
            if (message.type && INTERNAL_CLAUDE_EVENT_TYPES.has(message.type)) {
                continue;
            }

            // DROVE-41: before the internal-type skip below, because the
            // enqueue record IS a queue-operation and is the only sighting of
            // a typed message until the turn that swallows it ends.
            const queuedPrompt = parseQueuedPrompt(message);
            if (queuedPrompt) {
                entries.push({
                    kind: 'queued-prompt',
                    // Keyed per carrier so both are reported once each. The
                    // enqueue record has no uuid, so its time and text are all
                    // there is to key it by; two identical prompts queued in
                    // the same millisecond are one message as far as we can
                    // tell, and collapsing them is the safe way round.
                    key: `queued:${queuedPrompt.carrier}:${queuedPrompt.at}:${queuedPrompt.text}`,
                    prompt: queuedPrompt,
                });
                continue;
            }
            // DROVE-63: the only record that says whether Remote Control is on.
            // Keyed by line index like custom-title, because it has no uuid and
            // the same state repeats — a bridge that stays up rewrites the same
            // id, and two identical records must both be seen or the state
            // machine below stalls on the first one.
            if (message.type === 'bridge-session') {
                entries.push({
                    kind: 'bridge-session',
                    key: `bridge-session:${lineIndex}`,
                    active: typeof message.bridgeSessionId === 'string' && message.bridgeSessionId.length > 0,
                });
                continue;
            }

            const transcriptEvent = parseClaudeGoalStatusTranscriptEvent(message);
            if (transcriptEvent) {
                entries.push({
                    kind: 'transcript-event',
                    key: transcriptEventKey(transcriptEvent),
                    event: transcriptEvent,
                });
                continue;
            }

            // Everything else these two types carry is bookkeeping. dequeue
            // says a prompt left the queue and remove says the running turn
            // took it — neither is a new message, and remove repeats the
            // content, so reporting it would double every queued prompt. The
            // other attachment kinds are skill listings, hook results and
            // token reminders, and only goal_status above is worth surfacing.
            if (message.type === 'queue-operation' || message.type === 'attachment') {
                continue;
            }
            
            // Claude Code's /rename. No uuid, so it is keyed by WHERE it is
            // in the file. It used to be keyed by its value, which made a
            // rename back to a title already used this run a silent no-op —
            // and worse, once `custom-title:hi` had been pre-marked as
            // history, every one of Claude Code's re-appends of that same
            // record was skipped too, so the seed never healed itself
            // (DROVE-15). The transcript is append-only, so a line index is
            // stable, and reporting the same title twice in a row is filtered
            // where the report is made rather than here.
            if (message.type === 'custom-title' && typeof message.customTitle === 'string') {
                entries.push({
                    kind: 'custom-title',
                    key: `custom-title:${lineIndex}:${message.customTitle}`,
                    title: message.customTitle,
                });
                continue;
            }

            // DROVE-36. Keyed by line index for the same reason custom-title
            // is: the record has no uuid and repeats verbatim every turn, so a
            // value key would mark `bypassPermissions` as history the first
            // time it appeared and never report a switch back to it.
            if (message.type === 'permission-mode' && typeof message.permissionMode === 'string'
                && message.permissionMode.length > 0) {
                entries.push({
                    kind: 'permission-mode',
                    key: `permission-mode:${lineIndex}:${message.permissionMode}`,
                    mode: message.permissionMode,
                });
                continue;
            }

            let parsed = RawJSONLinesSchema.safeParse(message);
            if (!parsed.success) {
                // Unknown message types are silently skipped
                continue;
            }
            entries.push({
                kind: 'message',
                key: messageKey(parsed.data),
                message: parsed.data,
            });
        } catch (e) {
            logger.debug(`[SESSION_SCANNER] Error processing message: ${e}`);
            continue;
        }
    }
    return entries;
}

function timestampMs(value: unknown): number {
    if (typeof value !== 'string') {
        return 0;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * The two records Claude Code writes for a prompt typed mid-turn, or null for
 * everything else that shares their `type`. See ScannerQueuedPrompt.
 */
function parseQueuedPrompt(message: any): ScannerQueuedPrompt | null {
    if (message?.type === 'queue-operation') {
        if (message.operation !== 'enqueue' || typeof message.content !== 'string') {
            return null;
        }
        return {
            text: message.content,
            at: timestampMs(message.timestamp),
            carrier: 'enqueue',
        };
    }
    if (message?.type === 'attachment') {
        // `attachment` is a busy channel — skill listings, hook results, token
        // reminders and eight other kinds ride it. Only queued_command is a
        // human talking.
        const attachment = message.attachment;
        if (!attachment || attachment.type !== 'queued_command' || typeof attachment.prompt !== 'string') {
            return null;
        }
        return {
            text: attachment.prompt,
            at: timestampMs(attachment.timestamp ?? message.timestamp),
            carrier: 'absorbed',
            ...(typeof message.uuid === 'string' && message.uuid.length > 0
                ? { claudeUuid: message.uuid }
                : {}),
        };
    }
    return null;
}
