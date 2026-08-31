import { z } from "zod";

//
// Agent states
//

/**
 * Every Cattle Drover account's headroom, stamped by the CLI from Claude Code's
 * own usage cache (DROVE-47). A pane session has no SDK rate-limit stream, so
 * this is what fills the strip under the composer; the account marked
 * `current` is the one the session is on and the rest are folded beside it.
 * Ephemeral and additive: a malformed block degrades to absent rather than
 * failing the whole metadata parse and dropping the session.
 */
const DroverUsageSchema = z.object({
    capturedAt: z.number(),
    accounts: z.array(z.object({
        name: z.string(),
        current: z.boolean().nullish(),
        loggedIn: z.boolean().nullish(),
        fetchedAt: z.number().nullish(),
        headroom: z.number().nullish(),
        cooling: z.object({
            until: z.number(),
            reason: z.string().nullish(),
            family: z.string().nullish(),
        }).passthrough().nullish(),
        limits: z.array(z.object({
            kind: z.string(),
            percent: z.number(),
            resetsAt: z.number().nullish(),
            scope: z.string().nullish(),
            family: z.string().nullish(),
        }).passthrough()).nullish(),
    }).passthrough()),
}).passthrough().optional().catch(undefined);

/**
 * What a session does when it runs out, and where each value came from
 * (DROVE-3). The store is the bus's per-session settings file on the Mac — the
 * one `drover settings` writes — so this is a READ of live machine state, not
 * app state: closing the app and reopening it re-reads it, and a change typed
 * in the terminal arrives on the CLI's next poll.
 *
 * The three layers are kept apart on purpose. `effective` is what the policy
 * engine will actually do; `overrides` is what this session chose, which is the
 * only thing that tells "you set prompt" from "prompt is simply the default".
 * `unavailable` is set instead of the layers when the bus is not answering, so
 * the screen says so rather than rendering built-ins as though they were live.
 *
 * Every field nullish and the whole block `.catch(undefined)`: a malformed
 * stamp degrades to absent rather than failing the metadata parse and dropping
 * the session.
 */
const PolicyValuesSchema = z.object({
    onLimit: z.enum(['auto', 'prompt']).nullish(),
    onLimitTimeout: z.enum(['auto', 'stop']).nullish(),
    onLimitPromptTtlMs: z.number().nullish(),
    onFamilyExhausted: z.enum(['stop', 'fallback']).nullish(),
    familyFallback: z.record(z.string(), z.array(z.string())).nullish(),
    // The delivery channels ride the same store and the same RPC (DROVE-72):
    // three announce switches, how audio may answer, and the saved modes. A
    // PATCH of `mode` is a macro the bus expands into the four keys.
    announceVisual: z.boolean().nullish(),
    announceHaptic: z.boolean().nullish(),
    announceAudio: z.boolean().nullish(),
    answerAudio: z.enum(['off', 'click', 'speech', 'both']).nullish(),
    mode: z.string().nullish(),
    modes: z.record(z.string(), z.any()).nullish(),
}).passthrough();

const DroverPolicySchema = z.object({
    capturedAt: z.number(),
    sessionId: z.string().nullish(),
    effective: PolicyValuesSchema,
    overrides: PolicyValuesSchema,
    defaults: PolicyValuesSchema,
    machine: PolicyValuesSchema,
    builtIn: PolicyValuesSchema,
    updatedAt: z.number().nullish(),
    updatedBy: z.string().nullish(),
    unavailable: z.string().nullish(),
}).passthrough().optional().catch(undefined);

export type DroverPolicy = NonNullable<z.infer<typeof DroverPolicySchema>>;
export type DroverPolicyValues = z.infer<typeof PolicyValuesSchema>;

/**
 * Clone lineage (DROVE-58). A flip is ONE session moving between accounts, so
 * the app sees one row and nothing needs saying. A CLONE is TWO sessions: no
 * harness but Claude Code can read a Claude Code transcript, so cloning into
 * OpenCode or Cursor starts a new session seeded with a summary of the old
 * one. Two rows, and neither can say on its own what it is — this is what
 * lets the clone show where it came from and the source show where it went.
 *
 * `session` is null on a clone that has not spoken yet: the ledger row is
 * written before the window opens, and the bus fills the id in from the
 * clone's first hook. Rendering "starting…" is the honest answer for those
 * seconds; dropping the entry would make the source look un-cloned.
 *
 * Ephemeral and additive, the same as droverUsage: a malformed block degrades
 * to absent rather than failing the whole metadata parse and dropping the
 * session off the list.
 */
const DroverCloneLinkSchema = z.object({
    session: z.string().nullish(),
    harness: z.string().nullish(),
    at: z.string().nullish(),
}).passthrough();

const DroverCloneSchema = z.object({
    from: DroverCloneLinkSchema.optional(),
    to: z.array(DroverCloneLinkSchema).optional(),
}).passthrough().optional().catch(undefined);

export const MetadataSchema = z.object({
    models: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullish(),
        id: z.string().optional(),
        name: z.string().optional(),
        providerId: z.string().optional(),
        providerKind: z.string().optional(),
        providerName: z.string().optional(),
        provider: z.object({
            id: z.string(),
            kind: z.string(),
            name: z.string(),
        }).passthrough().optional(),
        contextWindow: z.number().optional(),
        serviceTiers: z.array(z.string()).optional(),
        thinkingLevels: z.array(z.string()).optional(),
        defaultThinkingLevel: z.string().optional(),
    }).passthrough()).optional(),
    currentModelCode: z.string().optional(),
    operatingModes: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullish(),
        kind: z.string().optional(),
    }).passthrough()).optional(),
    currentOperatingModeCode: z.string().optional(),
    thoughtLevels: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullish(),
    })).optional(),
    currentThoughtLevelCode: z.string().optional(),
    rigMetadataVersion: z.number().int().positive().optional(),
    client: z.object({
        id: z.string(),
        name: z.string(),
        version: z.string(),
    }).passthrough().optional(),
    provider: z.object({
        id: z.string(),
        kind: z.string(),
        name: z.string(),
    }).passthrough().optional(),
    providers: z.array(z.object({
        id: z.string(),
        kind: z.string(),
        name: z.string(),
    }).passthrough()).optional(),
    model: z.object({
        providerId: z.string(),
        id: z.string(),
    }).passthrough().optional(),
    currentModelProviderId: z.string().optional(),
    reasoning: z.object({
        current: z.string().nullable(),
        levels: z.array(z.string()),
    }).passthrough().optional(),
    session: z.object({
        status: z.string(),
        permissionMode: z.string(),
        modelLocked: z.boolean(),
        serviceTier: z.string().optional(),
    }).passthrough().optional(),
    capabilities: z.object({
        abort: z.boolean(),
        attachments: z.object({
            enabled: z.boolean(),
            maxBytes: z.number(),
            mediaTypes: z.array(z.string()),
        }).passthrough(),
        files: z.object({
            browse: z.boolean(),
            read: z.boolean(),
            search: z.boolean(),
            write: z.boolean(),
        }).passthrough(),
        modelSelection: z.boolean(),
        reasoningSelection: z.boolean(),
        permissionModeSelection: z.boolean(),
        resume: z.boolean(),
        rpcMethods: z.array(z.string()),
        shell: z.boolean(),
        steering: z.boolean(),
    }).passthrough().optional(),
    activity: z.object({
        subagents: z.object({
            running: z.number(),
            queued: z.number(),
            total: z.number(),
        }).passthrough(),
        workflows: z.object({
            running: z.number(),
            total: z.number(),
        }).passthrough(),
        processes: z.object({ running: z.number() }).passthrough(),
        tasks: z.object({
            pending: z.number(),
            inProgress: z.number(),
            completed: z.number(),
            total: z.number(),
        }).passthrough(),
    }).passthrough().optional(),
    path: z.string(),
    host: z.string(),
    version: z.string().optional(),
    name: z.string().optional(),
    os: z.string().optional(),
    summary: z.object({
        text: z.string(),
        updatedAt: z.number()
    }).optional(),
    /**
     * When the session last did something a person would call activity: the
     * newest visible user message, visible agent text, or user-facing question.
     * Tool calls, tool results, reasoning, permission prompts, heartbeats and
     * metadata writes deliberately do not advance it, so a long tool-only tail
     * cannot float a session to the top of the list.
     *
     * The agent publishes it, so every device sorts the same way — unlike
     * `Session.lastMessageSentAt`, which only knows what this device sent.
     */
    lastMeaningfulMessageAt: z.number().optional(),
    /** Rig's branch/worktree comparison against its merge base with origin/main. */
    git: z.object({
        changedFiles: z.number().int().nonnegative(),
        countsExact: z.boolean(),
        deletions: z.number().int().nonnegative(),
        insertions: z.number().int().nonnegative(),
    }).passthrough().optional(),
    machineId: z.string().optional(),
    // Cattle Drover account this session runs under (one CLAUDE_CONFIG_DIR per
    // account; claude-acct exports it, the CLI stamps it — BASED-98).
    droverAccount: z.string().optional(),
    droverUsage: DroverUsageSchema,
    droverPolicy: DroverPolicySchema,
    droverClone: DroverCloneSchema,
    claudeSessionId: z.string().optional(), // Claude Code session ID
    codexThreadId: z.string().optional(), // Codex app-server thread ID
    tools: z.array(z.string()).optional(),
    slashCommands: z.array(z.string()).optional(),
    mcpServers: z.array(z.object({ name: z.string(), status: z.string() })).optional(),
    skills: z.array(z.string()).optional(),
    homeDir: z.string().optional(), // User's home directory on the machine
    happyHomeDir: z.string().optional(), // Happy configuration directory 
    startedFromDaemon: z.boolean().optional(),
    hostPid: z.number().optional(), // Process ID of the session
    startedBy: z.enum(['daemon', 'terminal']).optional(),
    // The session is a live Claude in a tmux pane ($TMUX_PANE was set when the
    // CLI started). The terminal IS the session, so the phone is a window on
    // it: messages go straight into the pane and there is no control to take
    // over or hand back (BASED-113).
    hasPane: z.boolean().optional(),
    flavor: z.string().nullish(), // Session flavor/variant identifier
    /**
     * Rig's project / worktree identity. Every worktree of the same repo
     * reports the same `project.id`, and `workspace` names the individual git
     * worktree (absent when the session runs in the primary tree). `kind` is a
     * plain string so newer Rig builds can add values without failing here.
     */
    project: z.object({
        id: z.string(),
        kind: z.string(),
        name: z.string(),
    }).passthrough().optional(),
    workspace: z.object({
        id: z.string(),
        kind: z.string(),
        name: z.string(),
    }).passthrough().optional(),
    sandbox: z.any().nullish(), // Sandbox config metadata from CLI (or null when disabled)
    dangerouslySkipPermissions: z.boolean().nullish(), // Claude --dangerously-skip-permissions mode (or null when unknown)
    lifecycleState: z.string().optional(),
    lifecycleStateSince: z.number().optional(),
    archivedBy: z.string().optional(),
    archiveReason: z.string().optional(),
    /**
     * Lineage for sessions created via the fork / duplicate flow.
     * `parentSessionId` is the Happy session this one was branched from.
     * `forkedFromMessageId` is the in-app message id used as the rewind
     * point (only set for "duplicate from message", not for plain fork).
     * Both ride inside encrypted metadata so the server stays oblivious.
     */
    parentSessionId: z.string().optional(),
    forkedFromMessageId: z.string().optional(),
    /**
     * Marks this session as a hidden "side chat" forked from `parentSessionId`.
     * Side chats never appear in the top-level session list — they render only
     * inside the parent session's sidebar panel (see `useSideChatSession`).
     */
    isSideChat: z.boolean().optional(),
    /**
     * Per-session permission / model / effort picks made in any client.
     * Synced through session metadata so every device shows the same
     * selection (#1492). Explicit null means "reset to default"; absent
     * means "never picked".
     */
    permissionMode: z.string().nullish(),
    modelMode: z.string().nullish(),
    effortLevel: z.string().nullish(),
    /**
     * Remote Control asked for on this session: `'on'` | `'off'`, null when the
     * ask is withdrawn (DROVE-63). A string, not a boolean, because it rides
     * the same per-session pick transport as the three above — one carrier, the
     * one DROVE-45 built.
     */
    remoteControl: z.string().nullish(),
    /**
     * Sessions that lost Remote Control when this one flipped account
     * (DROVE-37, made actionable by DROVE-63).
     *
     * Claude Code binds Remote Control to one account per machine, so landing
     * on a new account tears down the binding every OTHER live session held.
     * The flip already SAID which ones went quiet; this is the same list in a
     * shape the app can put a button on, so the message that names four dead
     * sessions can also turn them back on.
     */
    remoteControlAtRisk: z.array(z.object({
        id: z.string(),
        label: z.string(),
        account: z.string(),
    }).passthrough()).nullish(),
    /** When that list was written, ms since epoch. Used to age the banner out. */
    remoteControlAtRiskAt: z.number().nullish(),
    /**
     * What a `hasPane` session is ACTUALLY running, read off the transcript by
     * the CLI's session scanner and republished here (DROVE-45).
     *
     * The three picks above are a REQUEST — what someone chose in some client.
     * For a session that is a real Claude Code TUI in a tmux pane there was
     * nothing to hold them to it, so the composer showed "Fable 5 · Ultracode"
     * while /status in the pane read claude-opus-5[1m]. These two are the
     * answer, and they are also the only way a `/model` typed in the terminal
     * reaches the phone. Absent for a session with no pane.
     */
    paneModel: z.string().nullish(),
    paneEffort: z.string().nullish(),
    /**
     * The permission mode the pane is actually in (DROVE-36). Same rule again:
     * `permissionMode` above is the pick, this is the terminal's answer. It is
     * how a shift+tab at the keyboard reaches the composer, and how the Yolo
     * chip stops claiming a mode the pane never took.
     */
    panePermissionMode: z.string().nullish(),
    /**
     * Whether Claude Code's Remote Control is on for this pane RIGHT NOW
     * (DROVE-63). Same split as the pair above: `remoteControl` is the request,
     * this is the truth, and the toggle shows THIS so it cannot lie about a tap
     * that never landed or about `/remote-control` typed in the terminal.
     *
     * The CLI reads it off the transcript's `bridge-session` records, which is
     * the only place on disk that says it. `~/.claude.json`'s
     * `hasUsedRemoteControl` / `remoteControlSurfacesSeen` are install-wide
     * "ever" counters and would report on for every session forever.
     */
    paneRemoteControl: z.boolean().nullish(),
    /**
     * What the pane is doing RIGHT NOW (DROVE-54).
     *
     * The terminal showed a live task tree — background agents with elapsed
     * times and token counts, a workflow's phase and how many of its agents
     * were done, the running command and its own timer — and this app showed a
     * green dot and the word "online" for the same session. The CLI derives
     * this from the files Claude Code writes as it works (see happy-cli's
     * claude/utils/liveStatus.ts) and publishes it here, throttled to at most
     * one write a second and cleared to `null` the moment the turn ends.
     *
     * Every time is absolute epoch ms, never a duration: the strip ticks its
     * own clocks off `startedAt`, so a snapshot that is a few seconds old
     * still draws a correct timer and the CLI does not have to publish at
     * 1Hz to make the numbers move.
     *
     * `.passthrough()` on every object, and every field but the required ones
     * optional, so a newer CLI can add a fact without the whole metadata
     * record failing safeParse and vanishing off the phone.
     */
    liveStatus: z.object({
        at: z.number(),
        turnStartedAt: z.number().optional(),
        // The MAIN thread's own turn (DROVE-155), written only while the main
        // thread is actually working. Absent while a fan-out of background
        // agents runs on past the turn that launched it, which is what lets
        // the status row's dot mean the main session and nothing else.
        main: z.object({
            startedAt: z.number(),
            tokens: z.number().optional(),
        }).passthrough().optional(),
        tool: z.object({
            id: z.string(),
            name: z.string(),
            arg: z.string().optional(),
            startedAt: z.number(),
        }).passthrough().optional(),
        agents: z.array(z.object({
            id: z.string(),
            label: z.string(),
            startedAt: z.number(),
            tokens: z.number().optional(),
            toolId: z.string().optional(),
        }).passthrough()).optional(),
        workflows: z.array(z.object({
            id: z.string(),
            name: z.string(),
            phase: z.string().optional(),
            done: z.number(),
            total: z.number(),
            startedAt: z.number(),
            tokens: z.number().optional(),
        }).passthrough()).optional(),
        // `.catch` for the same reason droverUsage has one: a malformed block
        // must degrade to "no live status", never fail the whole metadata
        // safeParse. That failure drops the entire record — path, host, name,
        // summary and all — off the phone, which is a far worse outcome than
        // a missing strip.
    }).passthrough().nullish().catch(undefined),
    // Passthrough so read-modify-write metadata updates from this app never
    // drop fields written by newer CLI or app versions.
}).passthrough();

export type Metadata = z.infer<typeof MetadataSchema>;

export const AgentGoalSourceSchema = z.enum(['claude', 'codex']);

export const AgentGoalProgressStepSchema = z.object({
    text: z.string().trim().min(1),
    status: z.enum(['pending', 'in_progress', 'completed']),
}).strict();

export const AgentGoalProgressSchema = z.object({
    currentStep: z.number().int().positive().optional(),
    totalSteps: z.number().int().positive().optional(),
    steps: z.array(AgentGoalProgressStepSchema).optional(),
}).strict();

export const AgentGoalCapabilitiesSchema = z.object({
    clear: z.boolean().optional(),
    stop: z.boolean().optional(),
    edit: z.boolean().optional(),
}).strict();

const AgentGoalStatusBaseSchema = z.object({
    source: AgentGoalSourceSchema,
    observedAt: z.number().int().nonnegative(),
    sourceSessionId: z.string().trim().min(1).optional(),
    sourceRevision: z.union([z.string().trim().min(1), z.number()]).optional(),
});

export const AgentGoalStatusSchema = z.discriminatedUnion('status', [
    AgentGoalStatusBaseSchema.extend({
        status: z.literal('unavailable'),
        reason: z.enum(['unsupported', 'not_loaded', 'stale', 'malformed', 'error', 'unknown']).optional(),
    }).strict(),
    AgentGoalStatusBaseSchema.extend({
        status: z.literal('inactive'),
        reason: z.enum(['none', 'cleared', 'completed', 'unknown']).optional(),
    }).strict(),
    AgentGoalStatusBaseSchema.extend({
        status: z.literal('active'),
        sourceSessionId: z.string().trim().min(1),
        text: z.string().trim().min(1),
        capabilities: AgentGoalCapabilitiesSchema.optional(),
        progress: AgentGoalProgressSchema.optional(),
    }).strict(),
]);

export type AgentGoalStatus = z.infer<typeof AgentGoalStatusSchema>;

const UsageLimitsSchema = z.object({
    capturedAt: z.number(),
    windows: z.array(z.object({
        id: z.string(),
        label: z.string().optional(),
        // Plain string so statuses introduced by newer CLIs degrade safely.
        status: z.string().optional(),
        utilization: z.number().nullish(),
        resetsAt: z.number().nullish(),
    }).passthrough()),
}).passthrough().optional().catch(undefined);

/**
 * Agent-to-user communication, kept deliberately separate from permissions.
 * A permission gates an action the agent wants to take; a communication asks
 * the user for information the agent does not have.
 *
 * The top-level `kind` selects the payload and is an open string rather than an
 * enum, so newer agents can introduce other kinds (a notice, a file pick, a
 * diff to review) without older clients failing to parse the session. A client
 * that does not know a kind still sees the communication and tells the user it
 * cannot be answered here, rather than silently dropping it and leaving the
 * agent waiting forever.
 *
 * Today the only kind is `form`, whose payload is a list of questions.
 */
export const AgentQuestionOptionSchema = z.object({
    label: z.string(),
    description: z.string().nullish(),
}).passthrough();

export const AgentQuestionSchema = z.object({
    id: z.string(),
    header: z.string(),
    question: z.string(),
    options: z.array(AgentQuestionOptionSchema).default([]),
    multiSelect: z.boolean().nullish(),
    // Lets the user write an answer the agent did not offer.
    allowCustom: z.boolean().nullish(),
    // When false the user may submit without choosing anything.
    required: z.boolean().nullish(),
}).passthrough();

/** Payload for `kind: 'form'`. */
export const AgentFormSchema = z.object({
    questions: z.array(AgentQuestionSchema).default([]),
}).passthrough();

export const AgentCommunicationSchema = z.object({
    kind: z.string(),
    createdAt: z.number().nullish(),
    // Joins the communication to the tool call that raised it, when there is one.
    toolUseId: z.string().nullish(),
    // Shown when the client does not understand `kind`, so the user learns what
    // is being asked even though this build cannot render the payload.
    title: z.string().nullish(),
    // Present when kind === 'form'.
    form: AgentFormSchema.nullish(),
}).passthrough();

export const AgentQuestionAnswerSchema = z.object({
    options: z.array(z.string()).default([]),
    custom: z.string().nullish(),
}).passthrough();

export const CompletedAgentCommunicationSchema = AgentCommunicationSchema.extend({
    completedAt: z.number().nullish(),
    status: z.enum(['answered', 'cancelled']),
    answers: z.record(z.string(), AgentQuestionAnswerSchema).nullish(),
});

export type AgentQuestionOption = z.infer<typeof AgentQuestionOptionSchema>;
export type AgentQuestion = z.infer<typeof AgentQuestionSchema>;
export type AgentForm = z.infer<typeof AgentFormSchema>;
export type AgentCommunication = z.infer<typeof AgentCommunicationSchema>;
export type AgentQuestionAnswer = z.infer<typeof AgentQuestionAnswerSchema>;
export type CompletedAgentCommunication = z.infer<typeof CompletedAgentCommunicationSchema>;

export const AgentStateSchema = z.object({
    controlledByUser: z.boolean().nullish(),
    // The Cattle Drover machine settings, mirrored by the drover bridge from
    // the bus's `settings` frame after every write (DROVE-72). The channel
    // sheet reads its toggles out of this when a bridge is up, so a switch
    // moved in a terminal shows here without polling a bus the phone cannot
    // reach. Loose on purpose: the keys are the bus's and it may grow them.
    droverSettings: z.object({
        capturedAt: z.number(),
    }).passthrough().nullish(),
    // Ephemeral runtime state. A malformed snapshot must not invalidate
    // permission requests or the rest of the agent state.
    usageLimits: UsageLimitsSchema,
    // Pending agent-to-user communications, keyed by request id.
    communications: z.record(z.string(), AgentCommunicationSchema).nullish(),
    completedCommunications: z.record(z.string(), CompletedAgentCommunicationSchema).nullish(),
    requests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.any(),
        createdAt: z.number().nullish(),
        // Raw provider tool-use id when the request id is scoped (e.g. claude
        // subagent ids are `agentID:toolUseID`); used to join the permission
        // to its tool call, while the request id stays the response key.
        toolUseId: z.string().nullish(),
        // Which agent raised this, on a card the drover bridge mirrored
        // (DROVE-19). The bridge owns ONE session per machine, so every gate
        // from every local agent lands in that one session's requests; this is
        // the only thing that says which of them stopped, and it is what lets
        // a session view present its own prompt in place instead of sending
        // you to the home screen to find it. Matching is on `sessionId`
        // against the pane session's `metadata.claudeSessionId`; `cwd` is for
        // reading only, because several lanes share one checkout.
        droverOrigin: z.object({
            sessionId: z.string().nullish(),
            cwd: z.string().nullish(),
        }).nullish(),
        // The bus event's own facts, on a card the drover bridge mirrored
        // (DROVE-71). The card SHAPES are chosen to render — a Bash card packs
        // title and reason into one `description`, a question card puts the
        // title in a header — so the inbox, which has to group prompts apart
        // from to-dos and print a real age, had only a display string to read.
        // `kind` is also what tells "a session is stopped waiting on you" from
        // "you must DO something", which the card alone cannot say.
        //
        // `createdAt` here is the BUS's, not the card's: the bridge re-mirrors
        // every pending event on restart and stamps the card fresh each time,
        // so a to-do — the one kind that never expires — read as new after
        // every launchd roll.
        droverEvent: z.object({
            kind: z.enum(['permission', 'question', 'idle', 'expiry', 'todo']).nullish(),
            title: z.string().nullish(),
            reason: z.string().nullish(),
            command: z.string().nullish(),
            createdAt: z.number().nullish(),
            // Which channels ANNOUNCE this prompt and which may ANSWER it,
            // stamped by the bus (DROVE-72). The phone buzzes and speaks off
            // this field, never off a setting of its own. Absent on a card
            // from a bus older than the field; see droverChannels.deliveryOf.
            delivery: z.object({
                announce: z.array(z.string()),
                answer: z.array(z.string()),
                audioInput: z.string().nullish(),
            }).nullish(),
        }).nullish()
    })).nullish(),
    completedRequests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.any(),
        createdAt: z.number().nullish(),
        completedAt: z.number().nullish(),
        status: z.enum(['canceled', 'denied', 'approved']),
        reason: z.string().nullish(),
        mode: z.string().nullish(),
        allowedTools: z.array(z.string()).nullish(),
        // The CLI completes a request by echoing the RPC's own field name,
        // `allowTools`, so every deployed CLI reports the "don't ask again"
        // grant under this key. Declared here so parsing keeps it; the
        // reducer folds it into `allowedTools` when reading.
        allowTools: z.array(z.string()).nullish(),
        decision: z.enum(['approved', 'approved_for_session', 'denied', 'abort']).nullish(),
        toolUseId: z.string().nullish()
    })).nullish(),
    agentGoalStatus: AgentGoalStatusSchema.optional(),
});

export type AgentState = z.infer<typeof AgentStateSchema>;

export const TodoItemSchema = z.object({
    content: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed']),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    id: z.string().optional(),
});

export const TodoItemsSchema = z.array(TodoItemSchema);

export type TodoItem = z.infer<typeof TodoItemSchema>;

/**
 * Per-session agent mode picks that sync across devices via session metadata (#1492).
 * null clears a pick back to defaults, undefined leaves the field untouched.
 */
export interface SessionAgentModesPatch {
    permissionMode?: string | null;
    modelMode?: string | null;
    effortLevel?: string | null;
    /** `'on'` | `'off'` | null — Cattle Drover's Remote Control toggle (DROVE-63). */
    remoteControl?: string | null;
}

export interface Session {
    id: string,
    seq: number,
    createdAt: number,
    updatedAt: number,
    active: boolean,
    activeAt: number,
    /** Account-scoped Project linkage supplied beside the encrypted session. */
    projectId?: string | null,
    metadata: Metadata | null,
    metadataVersion: number,
    agentState: AgentState | null,
    agentStateVersion: number,
    thinking: boolean,
    thinkingAt: number,
    presence: "online" | number, // "online" when active, timestamp when last seen
    todos?: TodoItem[];
    draft?: string | null; // Local draft message, not synced to server
    permissionMode?: string | null; // Permission pick; local mirror of synced metadata.permissionMode (#1492)
    modelMode?: string | null; // Model pick; local mirror of synced metadata.modelMode (#1492)
    effortLevel?: string | null; // Effort pick; local mirror of synced metadata.effortLevel (#1492)
    remoteControl?: string | null; // Remote Control ask; local mirror of synced metadata.remoteControl (DROVE-63)
    lastMessageSentAt?: number; // Local timestamp of last user-sent message, not synced to server; used for activity-based sort
    // IMPORTANT: latestUsage is extracted from reducerState.latestUsage after message processing.
    // We store it directly on Session to ensure it's available immediately on load.
    // Do NOT store reducerState itself on Session - it's mutable and should only exist in SessionMessages.
    latestUsage?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
        contextWindow?: number;
        timestamp: number;
    } | null;
}

export interface DecryptedMessage {
    id: string,
    seq: number | null,
    localId: string | null,
    content: any,
    createdAt: number,
}

//
// Machine states
//

export const MachineMetadataSchema = z.object({
    host: z.string(),
    platform: z.string(),
    happyCliVersion: z.string(),
    happyHomeDir: z.string(), // Directory for Happy auth, settings, logs (usually .happy/ or .happy-dev/)
    homeDir: z.string(), // User's home directory (matches CLI field name)
    // Optional fields that may be added in future versions
    username: z.string().optional(),
    arch: z.string().optional(),
    displayName: z.string().optional(), // Custom display name for the machine
    // Daemon status fields
    daemonLastKnownStatus: z.enum(['running', 'shutting-down']).optional(),
    daemonLastKnownPid: z.number().optional(),
    shutdownRequestedAt: z.number().optional(),
    shutdownSource: z.enum(['happy-app', 'happy-cli', 'os-signal', 'unknown']).optional(),
    cliAvailability: z.object({
        claude: z.boolean(),
        codex: z.boolean(),
        gemini: z.boolean(),
        openclaw: z.boolean(),
        agy: z.boolean().optional(), // optional: older CLIs don't report agy
        rig: z.boolean().optional(), // Rig runs its own Happy-connected daemon
        detectedAt: z.number(),
    }).optional(),
    // Rig registers as its own machine instead of being launched by happy-cli.
    // Keep its creation catalog so the new-session UI can send Rig-native
    // provider/model identifiers to the machine RPC.
    machineKind: z.string().optional(),
    rigOnly: z.boolean().optional(),
    rigMetadataVersion: z.number().int().positive().optional(),
    client: z.object({
        id: z.string(),
        name: z.string(),
        version: z.string(),
    }).passthrough().optional(),
    capabilities: z.object({
        newSession: z.boolean().optional(),
        resume: z.boolean().optional(),
        worktrees: z.boolean().optional(),
    }).passthrough().optional(),
    // The Rig catalog below mirrors the optionality of MetadataSchema at the top
    // of this file, which models the same payload for a session. Rig is a
    // separate codebase shipping on its own schedule, so a field it omits or
    // sends as null must not fail the parse: a rejected parse returns null for
    // the ENTIRE machine metadata (see machineEncryption.ts), which would strip
    // host, platform and CLI availability over an unread reasoning level.
    // Each block also catches independently, so an unforeseen shape degrades to
    // "no Rig session creation" rather than "no machine".
    defaults: z.object({
        effort: z.string().optional(),
        modelId: z.string().optional(),
        permissionMode: z.string().optional(),
        providerId: z.string().optional(),
    }).passthrough().optional().catch(undefined),
    providers: z.array(z.object({
        id: z.string(),
        kind: z.string().optional(),
        name: z.string().optional(),
    }).passthrough()).optional().catch(undefined),
    models: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullish(),
        id: z.string().optional(),
        name: z.string().optional(),
        providerId: z.string().optional(),
        providerKind: z.string().optional(),
        providerName: z.string().optional(),
        provider: z.object({
            id: z.string(),
            kind: z.string(),
            name: z.string(),
        }).passthrough().optional(),
        contextWindow: z.number().optional(),
        serviceTiers: z.array(z.string()).optional(),
        thinkingLevels: z.array(z.string()).optional(),
        defaultThinkingLevel: z.string().nullish(),
    }).passthrough()).optional().catch(undefined),
    operatingModes: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullish(),
        kind: z.string().optional(),
    }).passthrough()).optional().catch(undefined),
    sessionCreation: z.object({
        idempotencyKey: z.string().optional(),
        pendingRetryAfterMs: z.number().optional(),
        resultKinds: z.array(z.string()).optional(),
    }).passthrough().optional().catch(undefined),
    resumeSupport: z.object({
        rpcAvailable: z.boolean().optional(),
        requiresSameMachine: z.boolean().optional(),
        requiresHappyAgentAuth: z.boolean().optional(),
        happyAgentAuthenticated: z.boolean().optional(),
        detectedAt: z.number().optional(),
    }).passthrough().optional().catch(undefined),
}).passthrough();

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>;

export interface Machine {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;  // Changed from lastActiveAt to activeAt for consistency
    metadata: MachineMetadata | null;
    metadataVersion: number;
    daemonState: any | null;  // Dynamic daemon state (runtime info)
    daemonStateVersion: number;
}

//
// Git Status
//

export interface GitStatus {
    branch: string | null;
    isDirty: boolean;
    modifiedCount: number;
    untrackedCount: number;
    stagedCount: number;
    lastUpdatedAt: number;
    // Line change statistics - separated by staged vs unstaged
    stagedLinesAdded: number;
    stagedLinesRemoved: number;
    unstagedLinesAdded: number;
    unstagedLinesRemoved: number;
    // Computed totals
    linesAdded: number;      // stagedLinesAdded + unstagedLinesAdded
    linesRemoved: number;    // stagedLinesRemoved + unstagedLinesRemoved
    linesChanged: number;    // Total lines that were modified (added + removed)
    // Branch tracking information (from porcelain v2)
    upstreamBranch?: string | null; // Name of upstream branch
    aheadCount?: number; // Commits ahead of upstream
    behindCount?: number; // Commits behind upstream
    stashCount?: number; // Number of stash entries
}
