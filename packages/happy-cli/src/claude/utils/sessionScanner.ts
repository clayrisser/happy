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
    'queue-operation',
]);

export type ScannerTranscriptEvent = ClaudeGoalStatusTranscriptEvent;

type SessionLogEntry =
    | { kind: 'message'; key: string; message: RawJSONLines }
    | { kind: 'transcript-event'; key: string; event: ScannerTranscriptEvent }
    | { kind: 'custom-title'; key: string; title: string };

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
        seedTitleFrom(entries);
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
                    reportTitle(entry.title, 'Session renamed in Claude Code');
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
                // DROVE-15: and seed the name, exactly as the constructor
                // does. This is the resume / continue / picker path, and it
                // used to swallow the rename with the history: Clay renamed a
                // session DROVER, ran `drover --resume`, and the app called it
                // cattle-drover for the rest of the run.
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
            
            // Silently skip known internal Claude Code events
            // These are state/tracking events, not conversation messages
            if (message.type && INTERNAL_CLAUDE_EVENT_TYPES.has(message.type)) {
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
