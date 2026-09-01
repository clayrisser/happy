/**
 * The argv a pi session is spawned with (DROVE-316).
 *
 * A pure function with its own file for one reason: `--no-extensions` must
 * never appear in it, and "must never" is only true if something asserts it.
 * Building the array inside the backend would leave that assertion to a test
 * that has to spawn a process to make it.
 *
 * WHY THE FLAG IS BANNED, measured on pi 0.80.3 by DROVE-295. The local model
 * PROVIDERS are extensions. `lmstudio` and `glm` are packages listed in
 * ~/.pi/agent/settings.json, so `--no-extensions` (`-ne`) does not merely turn
 * off some plugins — it takes the models with it, and pi answers
 * `Unknown provider "lmstudio"` and refuses to start. pi is the LOCAL-model
 * harness; that flag turns it into no harness at all.
 *
 * The gate is loaded with `--extension` ON TOP of normal discovery, which is
 * exactly why the two flags cannot be confused: `-e` adds, `-ne` replaces
 * discovery with nothing.
 *
 * A banned flag arriving in PASSTHROUGH is refused rather than filtered out.
 * Silently dropping a flag somebody typed is how you get a session that is not
 * the one they asked for; refusing names the reason.
 */

/** `--mode rpc` IS the channel, so it is drover's to choose, never passed in. */
export const PI_RPC_MODE_ARGS: readonly string[] = ['--mode', 'rpc'];

/**
 * The flags that would disable extension discovery, in every spelling pi
 * accepts. `pi --help` lists `--no-extensions, -ne`.
 */
export const PI_EXTENSION_KILLING_FLAGS: readonly string[] = ['--no-extensions', '-ne'];

export class PiBannedFlagError extends Error {
    readonly flag: string;
    constructor(flag: string) {
        super(
            `drover pi: ${flag} takes the LOCAL MODELS down with it.\n`
            + '  The lmstudio and glm providers are pi extensions (settings.json\n'
            + "  packages), so pi answers 'Unknown provider' and refuses to start.\n"
            + '  The drover gate is loaded with --extension, on top of discovery,\n'
            + '  never instead of it.',
        );
        this.name = 'PiBannedFlagError';
        this.flag = flag;
    }
}

export interface PiSpawnArgsOptions {
    /** Absolute path to adapters/pi-gate.mjs, or null for an ungated session. */
    gateExtension?: string | null;
    /** A full `provider/id` ref, already resolved by piModels.resolvePiModel. */
    model?: string | null;
    /** off | minimal | low | medium | high | xhigh */
    thinking?: string | null;
    /** A pi session file path or a partial uuid, for --session. */
    resumeSessionId?: string | null;
    /** pi's own arguments, verbatim. Checked for banned flags. */
    passthrough?: readonly string[];
}

/** Throws PiBannedFlagError if the caller tried to disable extensions. */
export function assertNoExtensionKill(args: readonly string[]): void {
    for (const arg of args) {
        if (PI_EXTENSION_KILLING_FLAGS.includes(arg)) throw new PiBannedFlagError(arg);
    }
}

/**
 * The full argv for `pi --mode rpc`, gate included.
 *
 * Built one flag at a time, in a fixed order, so a model id or a path that
 * contains a space stays ONE argument. The shell half of drover learned this
 * the hard way; there is no shell here, but the ordering guarantee is still
 * what a test can pin.
 */
export function buildPiRpcArgs(opts: PiSpawnArgsOptions = {}): string[] {
    const passthrough = opts.passthrough ?? [];
    assertNoExtensionKill(passthrough);

    const args: string[] = [...PI_RPC_MODE_ARGS];
    if (opts.gateExtension) args.push('--extension', opts.gateExtension);
    if (opts.model) args.push('--model', opts.model);
    if (opts.thinking) args.push('--thinking', opts.thinking);
    if (opts.resumeSessionId) args.push('--session', opts.resumeSessionId);
    args.push(...passthrough);

    // Belt and braces: nothing above can produce a banned flag, and this is the
    // line that stays true when somebody adds a branch that could.
    assertNoExtensionKill(args);
    return args;
}
