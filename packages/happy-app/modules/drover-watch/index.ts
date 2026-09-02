import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

import type { WristNudgeName } from '@/utils/wristNudges';

/**
 * Phone-side WatchConnectivity bridge for the Cattle Drover wrist surface
 * (BASED-98). iOS only; every export degrades to a no-op elsewhere so callers
 * never need a Platform check.
 */

export interface DroverWatchStatus {
    supported: boolean;
    activated?: boolean;
    paired: boolean;
    /** The watch has the drover watch app installed. */
    installed: boolean;
    reachable: boolean;
    /**
     * How many more background wakes of the watch app this phone may spend
     * today (DROVE-62). Absent on a build whose native module predates the
     * key. Zero means the wrist cannot be woken at all — either the budget is
     * spent, or, far more often, the Drover complication is on no watch face,
     * which is the documented condition for the count being zero.
     */
    wakes?: number;
}

export interface DroverAnswerEvent {
    /** The gate id — for Happy sessions, `${sessionId}:${requestId}`. */
    id: string;
    allow: boolean;
    optionId?: string;
    /**
     * A typed or dictated answer, from watchOS's own input sheet.
     *
     * Kept apart from `optionId` so the phone can tell a pick from a typed
     * answer; both leave the phone on the same `updatedInput.optionId` key,
     * because happy-cli decides action=option vs action=text by matching the
     * string against the question's options (see droverWatchFeed's onAnswer).
     */
    text?: string;
    /**
     * EVERY pick on a multi-select question, in tap order (DROVE-53).
     *
     * `optionId` still carries the first, so nothing that only knows that key
     * changes. Absent on a single pick rather than a one-element array — an
     * array where the reader expects one string is how a pick-one answer would
     * start arriving as a list nobody asked for.
     */
    optionIds?: string[];
    /**
     * "Allow, and stop asking this session", from the wrist's third permission
     * button. Only ever 'session'; absent on a plain allow, because a default
     * worth writing down is a default that will drift.
     */
    scope?: 'session';
}

/**
 * One pickable answer on a question gate.
 *
 * `id` is optional because the two producers disagree and both are real. The
 * bus enforces `{id, label}` (schema/event.json), but happy-cli's
 * requestForEvent flattens a mirrored question to `{label, description}` so it
 * can render through the phone's own AskUserQuestion card, and Claude's native
 * cards never carried an id at all. Nothing is lost by sending the label
 * instead: happy-cli matches an answer with `o.id === candidate || o.label ===
 * candidate` (src/drover/droverBridge.ts), so a label comes back to the right
 * option.
 */
export interface DroverGateOption {
    id?: string;
    label: string;
    description?: string;
}

/** One gate waiting on a human, as the watch renders it. */
export interface DroverGate {
    id: string;
    title: string;
    reason: string;
    preview: string;
    /** `todo` is the needs-you record: an ACTION to do, not a decision. */
    kind: 'permission' | 'question' | 'todo';
    /** ISO-8601; Swift's JSONDecoder reads these with .iso8601. */
    createdAt: string;
    account?: string | null;
    /**
     * What a question can be answered WITH. Absent on a permission, and absent
     * on a question whose card carried none — those are answered by typing or
     * dictating instead (GateDetailView's TextFieldLink), not punted to the
     * phone.
     *
     * A question that reaches the watch WITHOUT these is a black hole: the
     * wrist can only send a bare allow, the bus refuses it ("a question needs
     * an option or text", 409) or an older one takes it with no answer at all,
     * and the event stays pending while every surface dismisses. The watch drew
     * these before this field existed, which is why it is here.
     */
    options?: DroverGateOption[];
    /**
     * The human may tick MORE THAN ONE option (DROVE-53).
     *
     * Omitted, never false, so a payload stays as small as it was and an older
     * watch build decodes it unchanged — absent reads as single-select there,
     * which is what every gate was before this existed.
     */
    multiSelect?: boolean;
}

/** A session the wrist may flip onto another account. */
export interface DroverSession {
    id: string;
    title: string;
    account?: string | null;
    active: boolean;
    /** Working directory, shown under the title on the wrist. */
    path?: string;
    /** Subagents running right now; omitted when the session never said. */
    subagents?: number;
    /**
     * One line saying what the session is DOING right now (DROVE-54) — the
     * running tool, the workflow and its progress, how many agents are out.
     * Omitted while the session is idle, which is what makes it disappear.
     *
     * Carries no elapsed time on purpose. The snapshot reaches the watch
     * through WatchConnectivity's application context, delivered
     * opportunistically and heartbeated only once a minute, so a duration
     * baked in here would be up to a minute wrong. `statusSince` travels
     * beside it and the wrist counts up from that itself.
     */
    status?: string;
    /** ISO-8601 start of the turn `status` describes. */
    statusSince?: string;
    /**
     * The phone's own resolved session state (DROVE-129), one of
     * SessionState's five words: `disconnected`, `waiting`, `thinking`,
     * `permission_required`, `input_required`.
     *
     * Sent because the wrist cannot import `resolveSessionState`. The watch
     * used to answer "running"/"idle" off `active` alone, which is whether the
     * PROCESS is alive — a different question from the one the phone's list
     * answers with its dot, and one that says nothing about a session sitting
     * on a permission prompt. `active` still rides along for a watch binary
     * that predates this key; the two are never in conflict because both come
     * off the same publish.
     */
    state?: string;
    /**
     * THE DOT the phone is drawing for this session (DROVE-257), one of
     * StatusDotState's six: `connected`, `working`, `waiting`, `compacting`,
     * `recentlyDisconnected`, `disconnected`.
     *
     * `state` above is a different question with a different answer set: it is
     * about whether a human is wanted, and four other things on the wrist read
     * it. This one is only the dot, and it exists because the two states it
     * adds are the two the wrist had no way to say. `compacting` is the one
     * Clay caught: he photographed a terminal mid-compaction beside a phone
     * drawing the idle colour, and a wrist reading `state` alone would repeat
     * that green one surface further out.
     *
     * Optional, so a watch binary that predates the key falls back to `state`
     * and draws what it always drew.
     */
    dotState?: string;
    /**
     * What the session is still working THROUGH: Claude Code's own task list,
     * unfinished lines only, in the phone's order (DROVE-167).
     *
     * Decided on the phone, like `state` and `status` before it (DROVE-129):
     * `utils/sessionTasks.ts` sorts, trims and picks the subset, and the wrist
     * draws what it is given. Omitted, never empty, so a watch binary that
     * predates this key is unaffected and a session with no list costs nothing
     * on the wire.
     */
    tasks?: string[];
    /** How many of the session's tasks are finished, and how many there are. */
    tasksDone?: number;
    tasksTotal?: number;
}

/**
 * ONE quota window on one account, as the phone's own sheet draws it
 * (DROVE-339).
 *
 * The wrist's first cut carried the binding limit and nothing else
 * (DROVE-131), which is the right glance and a dead end the moment Clay wants
 * to know why: "on the watch app, when I select a specific account to see the
 * limit, it should actually show the full breakdown of all the limits, just
 * like it shows in the mobile app."
 *
 * Every figure here is the phone's, evaluated by `usageAccountBarGroup` — the
 * same function that builds the sheet's rows — and sent, for the reason
 * `tone`, `limit` and `used` are sent (DROVE-129). The watch is Swift and
 * cannot import it, and this binary ships through TestFlight where a drift
 * could not be corrected OTA. So the wrist draws these; it decides nothing
 * about them.
 */
export interface DroverAccountLimitRow {
    /** `five_hour`, `seven_day`, `seven_day_fable` — the sheet's own ids. */
    id: string;
    /** The window's name in the phone's words: "Session", "Week", "Fable week". */
    label: string;
    /**
     * Percent USED, which is what the bar FILLS to (DROVE-230). Omitted when
     * there is no reading — nobody measured it, the window had already reset,
     * or a wider window is spent and this one cannot be spent either. Never
     * zero-for-nothing: a window measured at 0% used is a FRESH window and a
     * real reading, so the two must not share a spelling.
     */
    used?: number;
    /** The fill band for that figure, as the phone's own bars compute it. */
    tone?: 'ample' | 'low' | 'critical' | 'unknown';
    /**
     * What the phone prints behind the row: "Resets 6 PM", "window reset",
     * "Week spent". Empty on a row with nothing to say, and omitted then.
     */
    trailing?: string;
    /**
     * This is the window the account's `headroom` was read off — the one that
     * stops work first (DROVE-230). Omitted, never false.
     */
    binding?: boolean;
}

/**
 * An account the wrist may flip a session ONTO, with the figure that decides
 * which (DROVE-28's watch half).
 *
 * `accounts` carries the same names as bare strings and always will: a watch
 * binary that predates this reads only that key, and the watch cannot be
 * updated OTA. These are the same list with the numbers attached.
 */
export interface DroverAccountRow {
    name: string;
    /** Percent LEFT on the fullest limit; omitted when never measured. */
    headroom?: number;
    /** False when the account is not logged in and cannot take a session. */
    loggedIn?: boolean;
    /** ISO-8601; when a cooling account is back. Omitted when it is not out. */
    backAt?: string;
    /**
     * The account the work is on RIGHT NOW. Omitted, never false, on the
     * others (DROVE-131).
     *
     * The wrist had no way to ask this: `sessions[].account` names the account
     * each session runs on, and the picker's list is ordered by headroom, so
     * neither says which one the registry itself calls current. The wrist
     * needs it for the one glance that answers "can I still work".
     */
    current?: boolean;
    /**
     * WHICH limit the headroom figure is about — "Session", "Week", "Fable
     * week" (DROVE-131).
     *
     * `headroom` has always been 100 minus the fullest row, so it has always
     * been the MOST BINDING limit's remaining percentage; the wrist just never
     * knew which window that was, and a bare "4% left" cannot be acted on
     * without it. Decided by the phone (agentInputUsage's droverBindingLimit)
     * rather than by the watch, which cannot import a TypeScript function
     * (DROVE-129). Omitted when the account carries no limit rows.
     */
    limit?: string;
    /** ISO-8601; when THAT limit resets. Omitted when the cache never said. */
    resetsAt?: string;
    /**
     * The fill colour band for `headroom`, as the phone's bars compute it
     * (usageBarTone). Sent rather than recomputed on the wrist so the two
     * surfaces cannot disagree about what counts as nearly out (DROVE-129).
     * A band a watch build has never heard of reads as `unknown` there.
     */
    tone?: 'ample' | 'low' | 'critical' | 'unknown';
    /**
     * How much of the track the wrist's bar FILLS, as a whole percent 0..100 —
     * percent USED, the direction every bar in the product now runs
     * (DROVE-230).
     *
     * The wrist does not compute this. It is `usageBarFraction`, the single
     * function every bar on the phone runs through, evaluated here and sent,
     * for exactly the reason `tone` and `limit` are sent: two implementations
     * of one rule in two languages is two rules (DROVE-129). Reversing the
     * direction then means editing one TypeScript function, and the wrist
     * follows without a rebuild.
     *
     * It is also the figure the wrist PRINTS. `headroom` is still on the wire
     * and still counts the other way, and it survives in exactly one place on
     * each surface: the phone's account heading and the wrist's current-account
     * line, both of which spell the word "left" and name the window. Nothing
     * else on either surface counts down.
     *
     * Omitted when nothing was measured, never zero: zero is now a real and
     * common reading — a fresh session window — and it must not share a
     * spelling with "no reading at all".
     */
    used?: number;
    /**
     * At least one of this account's windows had already RESET when the CLI
     * read the cache (DROVE-204), so `headroom` and `tone` describe a window
     * that no longer exists.
     *
     * Decided here rather than on the wrist for the reason `tone` is: the
     * verdict needs the clock that was in the room when the cache was read,
     * and the watch has only its own (DROVE-129). The wrist draws an empty
     * track and no percentage on it, which is what the phone's own rows do
     * with the same reading. Omitted, never false, so an older watch binary
     * decodes the row unchanged and simply keeps the behaviour it had.
     */
    expired?: boolean;
    /**
     * Every window this account has, in the phone's own order — Session, Week,
     * then one row per model family any account scopes a limit to (DROVE-339).
     *
     * The wrist's Limits screen still shows one bar per account, because a
     * glance is over before you scroll. This is what SELECTING one opens: the
     * same three rows the phone's sheet draws, so the answer to "why is this
     * account nearly out" is on the wrist rather than a pocket away.
     *
     * Omitted when the CLI recorded no windows for the account at all. The
     * phone draws its bare Session and Week rows anyway so its blocks line up
     * in a column; the wrist shows one account at a time and has no column to
     * keep straight, so two dashes would be a table saying nothing.
     */
    limits?: DroverAccountLimitRow[];
    /**
     * The sheet's own heading for this account: "jamrizzi - 51% left on Week",
     * "main - not logged in", with the cooling time on the end when it is out
     * (DROVE-339).
     *
     * Sent rather than composed on the wrist for the reason everything else
     * here is (DROVE-129) — `usageAccountGroupTitle` decides between four
     * different nothings (no login, not measured, window reset, a cursor
     * token's deadline) and a Swift copy of that ladder is a second ladder.
     * The wrist keeps its own one-line fallback for a phone that predates the
     * key.
     */
    title?: string;
    /**
     * A session can be MOVED onto this account: it is not the one in use, it
     * is logged in, its config dir has been through Claude Code's first run,
     * and it is not a cursor account (DROVE-339).
     *
     * The phone's own `switchable`, so the wrist offers a switch exactly where
     * the sheet offers one and refuses it exactly where the sheet refuses it.
     * Omitted, never false.
     */
    switchable?: boolean;
}

/**
 * One row of a session's transcript, sized for a wrist (DROVE-91).
 *
 * The phone folds the session's message list into these: a user message, an
 * assistant reply, a run of tool calls collapsed to one line the way the
 * phone's own list folds them (DROVE-84, `Ran 4 shell commands`), or a gate
 * where it happened in the conversation. `text` is already trimmed to
 * `droverWristTextLimit` with a "more on the phone" tail, so the watch never
 * has to decide what to cut.
 */
export interface DroverTranscriptRow {
    id: string;
    kind: 'user' | 'assistant' | 'tools' | 'gate';
    text: string;
    /**
     * Still being written: the turn is running and this is its newest row, or
     * a tool in the run has not finished. Omitted when false, so an older
     * watch build decodes the row unchanged.
     */
    streaming?: boolean;
    /** ISO-8601; when the row was created on the session. */
    at: string;
    /**
     * For a `gate` row, the id in `DroverSnapshot.gates` it belongs to, so
     * the wrist can open the same GateDetailView the wall opens. Absent once
     * the gate has been answered.
     */
    gateId?: string;
}

/**
 * The last rows of ONE session, the one the watch says it is looking at.
 *
 * Carried on the snapshot so a watch launched later, or looking at a stale
 * snapshot with the phone out of reach, still has the conversation it last
 * saw. Rows are OLDEST FIRST, so the watch appends and reads the bottom as
 * newest.
 */
export interface DroverTranscript {
    sessionId: string;
    rows: DroverTranscriptRow[];
    /** The turn is running: the wrist shows a streaming row at the bottom. */
    streaming: boolean;
}

/**
 * What the phone sends by `sendMessage` while the watch is reachable, instead
 * of republishing the whole snapshot for every token (DROVE-91).
 *
 * `ids` is the whole window in order, so the watch can drop rows that fell
 * off the top; `rows` carries only the rows that changed since the last delta
 * the watch acknowledged by being reachable. A watch that finds an id it has
 * no row for asks for a snapshot, which carries the full transcript.
 */
export interface DroverTranscriptDelta {
    kind: 'transcript';
    sessionId: string;
    streaming: boolean;
    ids: string[];
    rows: DroverTranscriptRow[];
    /** ISO-8601, stamped at send; the watch restamps its freshness off it. */
    updatedAt: string;
}

/**
 * What read-aloud is doing, for the wrist (DROVE-275).
 *
 * The wrist was the one surface with NO half of the player on it: no reading
 * state on the wire and no transport handler in either direction. The lock
 * screen, the headphones and the in-app control have shared one state since
 * DROVE-233, and this is the fourth reader of it rather than a second copy.
 *
 * OMITTED WHEN READ-ALOUD IS OFF, never sent as a false or as an 'off' string.
 * That is the rule every optional key on this wire follows, and it is what
 * lets a watch binary that predates the key behave exactly as it does today:
 * no field, no indicator, no control.
 *
 * THE SENTENCE IS NOT ON THE WIRE, deliberately. The wrist already draws the
 * transcript, so a copy of the sentence in flight would be a second and slower
 * one — and a snapshot rides `sendMessage` whenever the watch is reachable,
 * which WatchConnectivity caps near 64KB (pinned by droverWatchTranscript.spec
 * .ts). This carries the state and the session, which is a few dozen bytes.
 */
export interface DroverReading {
    /**
     * 'reading' or 'paused'. Off is this whole object being absent, so there
     * is no third spelling here to keep in step with the native ReadingState.
     */
    state: 'reading' | 'paused';
    /**
     * The session the reader is following. The wrist offers the control on
     * that session's screen and nowhere else: a pause pressed on another
     * session's transcript would stop a voice reading something he is not
     * looking at, which is the same guard the phone's sentence tap has
     * (readAloudTap.ts `steers`).
     */
    sessionId?: string;
}

export interface DroverSnapshot {
    gates: DroverGate[];
    /**
     * ISO-8601, stamped at publish. The wrist's ONLY liveness signal, which is
     * why the feed heartbeats rather than publishing on change alone.
     */
    updatedAt: string;
    /**
     * The wrist is being FED: this phone has an activated WatchConnectivity
     * session, a paired watch, and the drover app installed on it.
     *
     * It is NOT "the bridge is connected to the bus", which is what this used
     * to claim on the watch side. The flag is only ever written BY a publish,
     * so the one failure it was written for — the phone stops feeding the
     * wrist — is precisely the one it can never report: no publish, no false.
     * That failure is caught by comparing `updatedAt` against the watch's own
     * clock (DroverSnapshot.isStale on the watch), not by this.
     */
    connected: boolean;
    sessions: DroverSession[];
    /**
     * Account names the wrist can offer by name. Gathered from the sessions
     * themselves, not from the drover registry: the phone only ever sees an
     * account because the CLI stamped `metadata.droverAccount` on a session,
     * so an account with nothing running on it cannot appear here.
     */
    accounts: string[];
    /**
     * The same accounts with their headroom, most first. Read by a watch that
     * knows the key; the bare `accounts` list is what an older one falls back
     * to, which is why both are sent.
     */
    accountRows?: DroverAccountRow[];
    /**
     * The transcript of the session the watch is showing, when it has said
     * which (DROVE-91). Absent until it does, and absent on a phone that
     * predates the key; the watch treats both as "nothing to show yet".
     */
    transcript?: DroverTranscript;
    /**
     * What read-aloud is doing (DROVE-275). Absent when it is off, and absent
     * from a phone that predates the key; the wrist reads both as "no reader
     * here", which is what it did before this existed.
     */
    reading?: DroverReading;
    /**
     * The synced `droverAnnounceHaptic` channel switch, as this phone read it
     * at publish (DROVE-384).
     *
     * The wrist has always been the surface this switch is ABOUT — DROVE-190
     * says the watch rides `droverAnnounceHaptic` and never the handset's own
     * `phoneHaptics` — and until now it never reached the watch. The phone
     * gated the background WAKE on it and nothing gated the pattern the watch
     * plays for itself, so a wrist with the channel off still buzzed the
     * moment the app was on screen. Absent from a phone that predates the key,
     * and the watch reads absent as ON: it was buzzing yesterday.
     */
    announceHaptic?: boolean;
    /**
     * Cue ids some OTHER path already carried to this wrist (DROVE-384).
     *
     * The dedupe only the phone can make. A todo can reach the watch twice —
     * as the push iOS mirrors onto it, and as this snapshot — and the two
     * wires cannot see each other. The phone sees both, because every path
     * claims a cue id in one on-disk ledger before carrying it, so it names
     * here the ids whose claim this publish did not win. The watch marks them
     * played before it diffs.
     */
    alreadyDelivered?: string[];
}

/**
 * The wrist asking for a current snapshot (DROVE-22).
 *
 * Carries nothing: there is one thing to ask for. It arrives as a
 * WatchConnectivity `sendMessage`, which is the one call on that wire that
 * wakes this app in the background — everything else has to be initiated by a
 * phone app that is already running, and iOS suspends a backgrounded app within
 * seconds, which is why the wrist's snapshot was stale by definition every time
 * Clay raised his wrist. The native side holds the watch's reply open until the
 * next `publishDroverSnapshot`, so answering this promptly is what makes the
 * wall read fresh.
 */
export interface DroverRefreshEvent {}

/**
 * The wrist saying which session it has OPEN (DROVE-91), or that it closed the
 * one it had. The phone feeds the transcript of exactly that session and no
 * other: thirty rows of every session in the application context would be
 * most of the WatchConnectivity budget spent on screens nobody is looking at.
 */
export interface DroverOpenedEvent {
    /** Omitted when the watch left the transcript screen. */
    sessionId?: string;
}

/** The wrist asking for an account flip (BASED-98). */
export interface DroverFlipEvent {
    sessionId: string;
    /** Omitted for "next account with headroom". */
    account?: string;
}

/**
 * A message dictated on the wrist for a session (DROVE-92). The phone sends
 * it through the same path the composer uses, so it reaches the session, and
 * the transcript on both devices, exactly as a phone-typed message does.
 */
export interface DroverSayEvent {
    sessionId: string;
    text: string;
}

/**
 * The wrist opening or closing its held-open recorder (DROVE-130).
 *
 * ONLY THE CONTROL COMES THROUGH JS. The audio itself goes straight from the
 * watch bridge to the speech module inside the native process: it arrives
 * about five times a second and JS has no use for PCM. What JS decides is
 * which session the words are for and whether the recogniser should be
 * running, which is the part worth being able to change without a native
 * build.
 *
 * `capture` identifies one press-to-press recording. It is echoed back on
 * every `heard` so the wrist can drop a straggler from a capture that has
 * already ended.
 */
export interface DroverListenEvent {
    sessionId: string;
    capture: string;
    /** 'start', 'stop' or 'cancel'. */
    state: string;
}

/**
 * Whether the wrist's own audio route has headphones on it (DROVE-92). Sent
 * when a transcript is opened and on every route change, so the phone can
 * pick which device speaks a reply.
 */
export interface DroverRouteEvent {
    headphones: boolean;
}

/**
 * The wrist finished, or cut, a sentence the phone sent it to speak
 * (DROVE-92). `id` is the one the phone sent with the sentence; the
 * read-aloud queue paces on it the way it paces on the phone's own
 * synthesiser settling.
 */
export interface DroverSpokenEvent {
    id: string;
    finished: boolean;
}

/**
 * The wrist pressing pause or resume on the reading (DROVE-275).
 *
 * EXPLICIT, NEVER A TOGGLE. The wrist draws from the last snapshot it was
 * given, and a snapshot can be a minute old — the phone publishes on change
 * and heartbeats every 60s, and neither reaches a watch that is out of range.
 * A toggle sent off a stale screen resumes exactly the reading he had just
 * paused. Naming the destination makes a stale press a no-op instead, which
 * is the failure worth having.
 *
 * IT NEVER TURNS READ-ALOUD ON. DROVE-189's rule, kept verbatim for a fourth
 * surface: "a squeeze that turned the voice back on for a session he had
 * walked away from would be a surprise, and the button is one tap away".
 * `resume` lifts a pause and does nothing else.
 */
export interface DroverTransportEvent {
    /** 'pause' or 'resume'. */
    action: string;
}

/**
 * What the phone sends a reachable watch by `sendMessage` for the voice half
 * (DROVE-92): a sentence to speak with an id to acknowledge, a stop, or the
 * reply-start cue that buzzes the wrist whichever device speaks.
 */
export type DroverWatchVoiceMessage =
    | { kind: 'speak'; id: string; text: string }
    | { kind: 'speak'; stop: true }
    /**
     * One in-app nudge the PHONE is the only thing that can see: a reply
     * starting to be spoken here or on the wrist, the reader pausing, the
     * reader skipping ahead (DROVE-384). `cue` is a `WristNudgeName`; `reply`
     * is DROVE-92's original spelling for `readingStarted` and a watch already
     * on Clay's wrist still answers to it, which matters because TestFlight is
     * not OTA and the phone can be a build ahead for days.
     */
    | { kind: 'cue'; cue: WristNudgeName | 'reply' }
    /**
     * What the phone has heard so far on an open wrist capture (DROVE-130).
     *
     * `text` is the WHOLE transcript since the recorder opened, not a delta:
     * the phone's `absorb()` has already banked the utterances before any
     * pause, so the wrist draws this rather than accumulating it. `seq` is
     * monotonic within a capture because `sendMessage` promises no ordering
     * and the wrist cannot tell a stale duplicate from a legitimate revision
     * by reading the words — a revision is often shorter and correct.
     */
    | { kind: 'heard'; capture: string; seq: number; text: string; final: boolean };

// The emitter members are declared explicitly rather than by extending
// NativeModule<…>: that generic resolves to a stub without them under this
// project's moduleResolution, and an inaccurate type is worse than a written
// one.
type DroverWatchModuleType = {
    status: () => DroverWatchStatus;
    publish: (json: string) => Promise<boolean>;
    /**
     * Optional: builds up to 7 have no such native function. Called through a
     * feature check rather than a runtimeVersion bump, so an OTA carrying this
     * file still runs on those builds — they simply never wake the wrist,
     * which is what they did before this existed.
     */
    wake?: (json: string) => Promise<boolean>;
    /**
     * Optional for the same reason: builds up to 10 have no such function.
     * Sends a transcript delta by `sendMessage` while the watch is reachable
     * and resolves false, doing nothing, when it is not (DROVE-91).
     */
    sendTranscript?: (json: string) => Promise<boolean>;
    /**
     * Optional for the same reason: builds up to 11 have no such function.
     * Sends one voice message to a reachable watch and resolves false, doing
     * nothing, when it is not (DROVE-92).
     */
    sendToWatch?: (json: string) => Promise<boolean>;
    /**
     * Optional for the same reason: no build before the one that adds the
     * phone widget target has it. Writes the widget's face into the app group
     * and, when told to, reloads the widget's timelines (DROVE-260). An OTA
     * carrying this file onto an older binary simply never writes a face, and
     * the widget those builds do not have stays the widget they do not have.
     */
    publishWidgetFace?: (json: string, reload: boolean) => Promise<boolean>;
    addListener: {
        (eventName: 'onAnswer', listener: (event: DroverAnswerEvent) => void): EventSubscription;
        (eventName: 'onFlip', listener: (event: DroverFlipEvent) => void): EventSubscription;
        (eventName: 'onRefresh', listener: (event: DroverRefreshEvent) => void): EventSubscription;
        (eventName: 'onOpened', listener: (event: DroverOpenedEvent) => void): EventSubscription;
        (eventName: 'onSay', listener: (event: DroverSayEvent) => void): EventSubscription;
        (eventName: 'onRoute', listener: (event: DroverRouteEvent) => void): EventSubscription;
        (eventName: 'onSpoken', listener: (event: DroverSpokenEvent) => void): EventSubscription;
        (eventName: 'onListen', listener: (event: DroverListenEvent) => void): EventSubscription;
        (eventName: 'onTransport', listener: (event: DroverTransportEvent) => void): EventSubscription;
    };
};

// Optional: Android, web and any build without the module still import this
// file. A missing native module is not an error, it is "no wrist here".
const native = requireOptionalNativeModule<DroverWatchModuleType>('DroverWatch');

export const isDroverWatchAvailable = () => native !== null;

/**
 * How many background wakes WatchConnectivity grants a phone per day
 * (`remainingComplicationUserInfoTransfers` starts here each morning). Apple's
 * figure, not ours; it is the denominator of the "wake budget 37/50 today"
 * line and nothing else reads it.
 */
export const droverWatchWakesPerDay = 50;

/**
 * One line for the phone's session info screen and the feed's log, so the
 * two agree on what a spent budget looks like (DROVE-86). Absent `wakes`
 * (a native module that predates the key) is said as such rather than as 0,
 * because 0 has a specific meaning: no complication on any face, or the day's
 * budget spent, and in either case the wrist cannot be woken.
 */
export function describeDroverWakeBudget(status: DroverWatchStatus): string {
    if (typeof status.wakes !== 'number') return 'wake budget unknown';
    return `wake budget ${status.wakes}/${droverWatchWakesPerDay} today`;
}

export function getDroverWatchStatus(): DroverWatchStatus {
    if (!native) return { supported: false, paired: false, installed: false, reachable: false };
    try {
        return native.status();
    } catch {
        return { supported: false, paired: false, installed: false, reachable: false };
    }
}

export async function publishDroverSnapshot(snapshot: DroverSnapshot): Promise<boolean> {
    if (!native) return false;
    try {
        return await native.publish(JSON.stringify(snapshot));
    } catch {
        // A failed publish must never take the app down: the wrist is a
        // convenience surface and the phone UI still shows every gate.
        return false;
    }
}

/**
 * Wake the watch app in the background and hand it this snapshot (DROVE-62).
 *
 * Resolves true when the wake was actually spent as a background launch, false
 * when it was downgraded to an ordinary queued transfer — which is what
 * happens with no budget left and, far more commonly, with the Drover
 * complication on no watch face. False therefore means "the wrist will find
 * out when Clay next opens the app", which is worth reporting rather than
 * treating as success.
 *
 * Costs one of a limited daily budget, so call it only for an arrival that
 * deserves a buzz. Never for the heartbeat.
 */
export async function wakeDroverWatch(snapshot: DroverSnapshot): Promise<boolean> {
    if (!native || typeof native.wake !== 'function') return false;
    try {
        return await native.wake(JSON.stringify(snapshot));
    } catch {
        // Same rule as publish: the wrist is a convenience surface and a
        // failed wake must never take the app down.
        return false;
    }
}

export function addDroverAnswerListener(listener: (event: DroverAnswerEvent) => void) {
    if (!native) return { remove: () => {} };
    return native.addListener('onAnswer', listener);
}

export function addDroverFlipListener(listener: (event: DroverFlipEvent) => void) {
    if (!native) return { remove: () => {} };
    return native.addListener('onFlip', listener);
}

/**
 * The wrist asking for a snapshot (DROVE-22). The listener must publish one:
 * the native side is holding the watch's reply open, and it falls back to the
 * last snapshot this phone published — timestamp and all — once its deadline
 * runs out.
 */
export function addDroverRefreshListener(listener: (event: DroverRefreshEvent) => void) {
    if (!native) return { remove: () => {} };
    try {
        return native.addListener('onRefresh', listener);
    } catch {
        // Build 7's binary declares onAnswer and onFlip and nothing else, and
        // this file can reach that binary as an OTA update — the JS ships in a
        // minute, the Swift beside it cannot ship at all (docs/wrist-install.md).
        // Subscribing to an event a module never declared must therefore cost
        // nothing: the wrist on that build simply never asks, which is exactly
        // what it did before DROVE-22.
        return { remove: () => {} };
    }
}

/**
 * Send a transcript delta straight to a reachable watch (DROVE-91).
 *
 * Resolves false when the watch is not reachable, and sends nothing then: an
 * unreachable watch is not looking, and the next snapshot publish carries the
 * full transcript in the application context anyway. False is also what a
 * native module without the function returns, so an OTA carrying this file
 * still runs on builds 9 and 10 and simply never sends a delta.
 */
export async function sendDroverTranscript(delta: DroverTranscriptDelta): Promise<boolean> {
    if (!native || typeof native.sendTranscript !== 'function') return false;
    try {
        return await native.sendTranscript(JSON.stringify(delta));
    } catch {
        return false;
    }
}

/**
 * The wrist saying which session it is showing (DROVE-91). Same guard as
 * onRefresh: a binary that never declared the event must cost nothing.
 */
export function addDroverOpenedListener(listener: (event: DroverOpenedEvent) => void) {
    if (!native) return { remove: () => {} };
    try {
        return native.addListener('onOpened', listener);
    } catch {
        return { remove: () => {} };
    }
}

/**
 * Send one voice message to a reachable watch (DROVE-92). False when the
 * watch is not reachable or the binary predates the function, and nothing is
 * sent then: the caller speaks on the phone instead, which is what every
 * build before this did.
 */
export async function sendDroverWatchVoice(message: DroverWatchVoiceMessage): Promise<boolean> {
    if (!native || typeof native.sendToWatch !== 'function') return false;
    try {
        return await native.sendToWatch(JSON.stringify(message));
    } catch {
        return false;
    }
}

/**
 * Whether this binary can write the phone widget's face at all (DROVE-260).
 *
 * Exported so a caller can tell "no widget on this build" from "the write
 * failed", which `writeDroverWidgetFace` folds into one false. The two want
 * different logging: the first is every build before the widget shipped, the
 * second is an app group the profile did not carry.
 */
export const isDroverWidgetAvailable = () =>
    !!native && typeof native.publishWidgetFace === 'function';

/**
 * Write the phone widget's face into the app group (DROVE-260).
 *
 * `reload` spends one of WidgetKit's roughly 40-70 daily timeline reloads, so
 * the caller decides — see `shouldReloadWidget`. The write itself is free and
 * unconditional: the blob is what the widget reads on its NEXT reload from any
 * cause, so keeping it current costs nothing and keeps a system-scheduled
 * refresh from drawing something older than the phone knows.
 *
 * False on any failure, and never throws. A home-screen convenience must not
 * be able to take down the publish path it rides on.
 */
export async function writeDroverWidgetFace(face: unknown, reload: boolean): Promise<boolean> {
    if (!native || typeof native.publishWidgetFace !== 'function') return false;
    try {
        return await native.publishWidgetFace(JSON.stringify(face), reload);
    } catch {
        return false;
    }
}

/** A message dictated on the wrist (DROVE-92). Same guard as onRefresh. */
/**
 * The wrist's recorder opening or closing (DROVE-130). Wrapped like the rest:
 * a build older than this feature has no such event and must not throw on
 * subscribing, because this file ships OTA and the native binary does not.
 */
export function addDroverListenListener(listener: (event: DroverListenEvent) => void) {
    if (!native) return { remove: () => {} };
    try {
        return native.addListener('onListen', listener);
    } catch {
        return { remove: () => {} };
    }
}

export function addDroverSayListener(listener: (event: DroverSayEvent) => void) {
    if (!native) return { remove: () => {} };
    try {
        return native.addListener('onSay', listener);
    } catch {
        return { remove: () => {} };
    }
}

/** The wrist's audio route, headphones or not (DROVE-92). Same guard as onRefresh. */
export function addDroverRouteListener(listener: (event: DroverRouteEvent) => void) {
    if (!native) return { remove: () => {} };
    try {
        return native.addListener('onRoute', listener);
    } catch {
        return { remove: () => {} };
    }
}

/** The wrist finished a sentence the phone sent it (DROVE-92). Same guard as onRefresh. */
export function addDroverSpokenListener(listener: (event: DroverSpokenEvent) => void) {
    if (!native) return { remove: () => {} };
    try {
        return native.addListener('onSpoken', listener);
    } catch {
        return { remove: () => {} };
    }
}

/**
 * The wrist pausing or resuming the reading (DROVE-275). Same guard as the
 * rest: this file ships OTA and the native binary does not, so a build older
 * than the event must not throw on subscribing — it simply never fires, and a
 * watch that old has no control to fire it with.
 */
export function addDroverTransportListener(listener: (event: DroverTransportEvent) => void) {
    if (!native) return { remove: () => {} };
    try {
        return native.addListener('onTransport', listener);
    } catch {
        return { remove: () => {} };
    }
}
