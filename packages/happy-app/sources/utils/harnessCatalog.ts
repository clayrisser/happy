import type { NewSessionAgentType } from '@/sync/persistence';

/**
 * The coding agents Happy can start a session with, and what to call them in
 * the UI. `rig` is the wire/CLI id of Happy's own agent; it is only ever shown
 * as "Happy". `agy` is Antigravity's binary name for the same reason.
 */
export const HARNESS_NAMES: Record<NewSessionAgentType, string> = {
    claude: 'Claude Code',
    codex: 'Codex',
    cursor: 'Cursor',
    rig: 'Cattle Drover',
    agy: 'Antigravity',
    gemini: 'Gemini',
    openclaw: 'OpenClaw',
    // Capitalised, because a row reading "pi" beside "Claude Code" reads as a
    // typo rather than as a product.
    pi: 'Pi',
};

/**
 * Harnesses a session can BE, but that this app cannot start.
 *
 * Kept apart from HARNESS_NAMES rather than folded into it, because that record
 * is keyed by NewSessionAgentType and that type is a promise: everything in it
 * flows into SpawnSessionOptions.agent, so anything named there is something the
 * daemon says it can spawn.
 *
 * EMPTY as of DROVE-316. pi was its only entry, and it is now spawnable — it
 * has a happy-cli runner (`packages/happy-cli/src/pi/runPi.ts`) that creates a
 * Happy session, streams the transcript, renders tool calls as tool calls and
 * raises gates that fail closed. The record stays because the next harness to
 * reach the phone over the drover bus before it has a runner belongs here, and
 * because getHarnessName still falls through it for any flavor a session can
 * carry that this list does not name.
 */
const NON_SPAWNABLE_HARNESS_NAMES: Record<string, string> = {};

/**
 * Harnesses you can no longer start a session with.
 *
 * GEMINI WAS HERE, AND WHY IT LEFT IS THE POINT (DROVE-381). The retirement was
 * measured against an older gemini-cli that refused an individual Google account
 * with "This client is no longer supported […] migrate to the Antigravity
 * suite", which is the `agy` harness. That refusal is gone in @google/gemini-cli
 * 0.58.0: `oauth-personal`, `gemini-api-key`, `vertex-ai` and `cloud-shell` are
 * all still live auth types in the shipped bundle, the only Antigravity strings
 * left in it are about IDE integration and an extension install, and a headless
 * `gemini -p` run against GEMINI_API_KEY answers. So the row comes back. The
 * Google browser login was NOT re-driven, so oauth-personal is
 * present-and-unverified rather than proven; the API-key path is the one with a
 * real run behind it.
 *
 * OpenClaw is shelved for now. Both stay in HARNESS_NAMES so an existing session
 * still shows a real product name, and neither is removed from the CLI, the
 * wire, or the transcript renderers.
 */
export const RETIRED_HARNESSES: ReadonlySet<NewSessionAgentType> = new Set([
    'openclaw',
]);

/**
 * Pick order for every harness list: the ones people reach for come first.
 *
 * `pi` is here as of DROVE-316, and the order of those two events is the whole
 * rule. A tap in this picker spawns `drover <agent>` through the daemon and
 * expects a happy-cli runner on the other end to register a Happy session.
 * Until DROVE-316 pi had none — a `drover pi` pane reached the phone over the
 * DROVER bus and never registered with the Happy server — so listing it would
 * have opened a tmux window and called a session that never appeared a success.
 * The runner landed first; this line is second. Never the other way round.
 *
 * Last, because it is the specialist: pi fronts whatever local runtime is being
 * served on that machine, and a machine with nothing loaded has nothing for it
 * to answer with.
 */
export const HARNESS_ORDER: readonly NewSessionAgentType[] = [
    'claude',
    'codex',
    'cursor',
    // Beside the other first-party vendor CLIs, because that is what it is
    // (DROVE-381). The runner-before-listing rule above is already satisfied
    // here: happy-cli has carried `src/gemini/runGemini.ts` the whole time the
    // row was retired, so un-retiring adds a row to a runner rather than the
    // other way round.
    'gemini',
    'agy',
    'rig',
    'pi',
];

export function isRetiredHarness(key: NewSessionAgentType | string): boolean {
    return RETIRED_HARNESSES.has(key as NewSessionAgentType);
}

export type HarnessAvailability = Partial<Record<NewSessionAgentType, boolean>>;

export type HarnessOption = {
    key: NewSessionAgentType;
    name: string;
};

export function getHarnessName(key: NewSessionAgentType | string): string {
    return HARNESS_NAMES[key as NewSessionAgentType] ?? NON_SPAWNABLE_HARNESS_NAMES[key] ?? key;
}

/** Whether this machine has given the app enough evidence to offer a harness. */
export function isHarnessAvailable({
    availability,
    happyAgentAvailable,
    key,
}: {
    availability?: HarnessAvailability | null;
    happyAgentAvailable: boolean;
    key: NewSessionAgentType;
}): boolean {
    if (key === 'rig') return happyAgentAvailable;
    // Antigravity is niche enough that an old or incomplete capability report
    // must not advertise it speculatively. Its daemon has to say it is installed.
    if (key === 'agy') return availability?.agy === true;
    // Cursor for the same reason (DROVE-57): a daemon predating its detection
    // reports nothing for it, and offering a harness on a machine that has no
    // cursor-agent produces a spawn that fails after the tmux window opens.
    if (key === 'cursor') return availability?.cursor === true;
    // Gemini for the same reason, on the way back in (DROVE-381). `npm install
    // -g @google/gemini-cli` lands in the npm global prefix, which is not on a
    // launchd daemon's PATH, so the report has to be explicit and it has to be
    // trustworthy — geminiBin.ts resolves that install the way piBin.ts does.
    if (key === 'gemini') return availability?.gemini === true;
    // pi, for the same reason as Cursor and Antigravity, and with one of its
    // own (DROVE-316): it is the LOCAL-model harness, so offering it on a
    // machine with no pi is a spawn that fails after the window opens, and the
    // daemon has to have said so. The report is trustworthy — piBin.ts resolves
    // the /opt/homebrew/bin install a launchd PATH cannot see, which is the bug
    // that hid Codex from the phone for weeks.
    if (key === 'pi') return availability?.pi === true;
    return !availability || availability[key] === true;
}

/**
 * The harnesses a machine actually has set up, in pick order.
 *
 * A harness with no CLI on the machine is left out rather than shown disabled:
 * a greyed-out row reads as something you can turn on from here, and you
 * cannot. Two things keep the list from ever being empty — the current
 * selection is usually included, and a machine that reports no capabilities at
 * all (an older daemon, or none selected yet) falls back to the familiar
 * catalog. Antigravity is the exception to both fallbacks: it is only listed
 * after an explicit installation report. A retired harness is also exempt from
 * the first rule, because keeping it listed would strand someone on it.
 */
export function listAvailableHarnesses({
    availability,
    happyAgentAvailable,
    selected,
}: {
    availability?: HarnessAvailability | null;
    happyAgentAvailable: boolean;
    selected?: NewSessionAgentType | null;
}): HarnessOption[] {
    const keys = HARNESS_ORDER.filter((key) => (
        (key === selected && key !== 'agy' && key !== 'pi')
        || isHarnessAvailable({ availability, happyAgentAvailable, key })
    ));
    // pi and gemini join agy and cursor in being excluded from the fallback:
    // all four are only offered on an explicit installation report, so a machine
    // with an older daemon (or none picked yet) gets the familiar catalog rather
    // than a speculative row that fails on tap. Gemini's case is sharper than
    // most, because a daemon old enough to report nothing is also old enough to
    // predate geminiBin.ts, and its answer would have been wrong anyway.
    const fallback = HARNESS_ORDER.filter((key) => (
        key !== 'agy' && key !== 'cursor' && key !== 'gemini' && key !== 'pi'
    ));
    return (keys.length > 0 ? keys : fallback).map((key) => ({
        key,
        name: HARNESS_NAMES[key],
    }));
}
