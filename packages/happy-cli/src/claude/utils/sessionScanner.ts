import { InvalidateSync } from "@/utils/sync";
import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { parseClaudeGoalStatusTranscriptEvent, type ClaudeGoalStatusTranscriptEvent } from "../claudeGoalStatus";
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { logger } from "@/ui/logger";
import { startFileWatcher } from "@/modules/watcher/startFileWatcher";
import { getProjectPath } from "./path";

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

type SessionLogEntry =
    | { kind: 'message'; key: string; message: RawJSONLines }
    | { kind: 'transcript-event'; key: string; event: ScannerTranscriptEvent }
    | { kind: 'custom-title'; key: string; title: string }
    | { kind: 'queued-prompt'; key: string; prompt: ScannerQueuedPrompt };

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
    // Size and mtime of each transcript as of the last pass that actually read
    // it. Per scanner instance, never module-global: a stale entry left by an
    // earlier scanner would make the next one skip a file whose entries it has
    // not marked, and those messages would never reach the app.
    let lastRead = new Map<string, { size: number, mtimeMs: number }>();

    // Mark existing entries as processed and start watching the initial session
    if (opts.sessionId) {
        let entries = await readSessionEntries(projectDir, opts.sessionId);
        logger.debug(`[SESSION_SCANNER] Marking ${entries.length} existing entries as processed from session ${opts.sessionId}`);
        for (let entry of entries) {
            processedEntryKeys.add(entry.key);
        }
        // Messages are marked processed so a reattach does not replay the
        // whole conversation at the app. A TITLE is not a replay — it is the
        // current name of this session, and the reason to read it here is a
        // session renamed in an EARLIER run: its custom-title record is
        // already in the file, so it would be marked processed and never
        // applied, and the app would keep whatever stale title it had. Last
        // one wins, because that is what /rename means.
        const seededTitle = entries.filter((e) => e.kind === 'custom-title').pop();
        if (seededTitle?.kind === 'custom-title') {
            logger.debug(`[SESSION_SCANNER] Seeding title from transcript: ${seededTitle.title}`);
            opts.onCustomTitle?.(seededTitle.title);
        }
        // IMPORTANT: Also start watching the initial session file because Claude Code
        // may continue writing to it even after creating a new session with --resume
        // (agent tasks and other updates can still write to the original session file)
        currentSessionId = opts.sessionId;
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
                    logger.debug(`[SESSION_SCANNER] Session renamed in Claude Code: ${entry.title}`);
                    opts.onCustomTitle?.(entry.title);
                } else if (entry.kind === 'queued-prompt') {
                    logger.debug(`[SESSION_SCANNER] Prompt queued in the terminal (${entry.prompt.carrier})`);
                    opts.onQueuedPrompt?.(entry.prompt);
                } else {
                    logger.debug(`[SESSION_SCANNER] Sending new transcript event: type=${entry.event.type}, uuid=${entry.event.uuid}`);
                    opts.onTranscriptEvent?.(entry.event);
                    sentTranscriptEvents++;
                }
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

    // Public interface
    return {
        cleanup: async () => {
            clearInterval(intervalId);
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
                // the whole of this run — and it never self-heals, because the
                // record is keyed by its own text and Claude Code re-appends
                // the identical line on every turn.
                //
                // This is the path a bare `drover --resume` takes, which is
                // how Clay's "DROVER" showed up on the phone as
                // "[jamrizzi] cattle-drover": the seed never ran, the name
                // stayed default-shaped, and a flip is entitled to restamp a
                // default-shaped name with the account it just moved to.
                const seeded = existing.filter((e) => e.kind === 'custom-title').pop();
                if (seeded?.kind === 'custom-title') {
                    logger.debug(`[SESSION_SCANNER] Seeding title from transcript: ${seeded.title}`);
                    opts.onCustomTitle?.(seeded.title);
                }
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
    for (let l of lines) {
        try {
            if (l.trim() === '') {
                continue;
            }
            let message = JSON.parse(l);
            
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
            
            // Claude Code's /rename. No uuid, so it is keyed by its value:
            // renaming to the same string twice is genuinely nothing to do.
            if (message.type === 'custom-title' && typeof message.customTitle === 'string') {
                entries.push({
                    kind: 'custom-title',
                    key: `custom-title:${message.customTitle}`,
                    title: message.customTitle,
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
