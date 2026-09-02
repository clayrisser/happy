/**
 * `drover providers` — OpenCode's custom model providers, from a terminal
 * (DROVE-276, DROVE-296), in node (DROVE-315 wave 4).
 *
 * The shell file this replaces, cattle-drover/libexec/drover-providers, was two
 * things and nothing else: a help text, and
 * `exec node "$root/engine/opencode-providers.js" "$@"`. Both are kept exactly,
 * the same way `drover mcps` kept them — providers is the WRITE half of that
 * read, and the two verbs are the same shape.
 *
 * HELP ANSWERS HERE, before the engine is imported. cattle-drover's
 * tests/libexec-loadtime.bats treats a subprocess spawned on `--help` as a
 * load-time side effect and fails it; the shell answered its own heredoc before
 * it ever reached the exec. The port keeps that: this returns before
 * `await import('./engine')`, so asking for help never loads the engine, never
 * reads a config and never copies a file aside.
 *
 * ONE WRITER, still. `engine/opencode-providers.js` stays in the cattle-drover
 * checkout and is the same module the bus's /v1/providers routes call, so the
 * terminal and the phone cannot disagree about what was written. Its own rules
 * — writes only between drover's markers, one backup before the first edit, and
 * the refusal to carry an API key rather than the NAME of an env var — are the
 * engine's, and are proved where the engine is, in cattle-drover's
 * tests/providers.bats.
 *
 * The engine writes its own stdout and ends the process itself on a refusal
 * (`fail()` is a `process.exit(1)`), exactly as it did under `exec node`. A
 * clean run returns, and that is this verb's 0.
 */

const HELP = `drover providers — OpenCode's custom model providers.

USAGE
  drover providers                      what drover has written into the config
  drover providers add <id> [options]   add or replace one
  drover providers rm <id>              take one back out
  drover providers set <id> <model> [options]
                                        configure one model

OPTIONS for add
  --name <text>            display name
  --base-url <url>         the endpoint. No query string: that is where a token
                           ends up, so it is refused.
  --key-env <NAME>         the NAME of the environment variable holding the API
                           key. NEVER the key.
  --npm <package>          the SDK, e.g. @ai-sdk/openai-compatible
  --model <id>             a model id; repeatable

OPTIONS for add and set
  --model-name <text>      display name for the model
  --context <n>            context window. Needs --max-output too.
  --max-output <n>         max output tokens
  --temperature <n>        the VALUE, into the model's options
  --accepts-temperature    the model's \`temperature\` BOOLEAN, a capability flag
  --reasoning              this model reasons
  --option <k=v>           anything else OpenCode's model options take;
                           repeatable. A key naming a credential is refused.

  --json                   the object /v1/providers serves

A provider you wrote by hand is yours: drover will not remove or configure one
it did not add.

OpenCode reads its config at start, so a pane already running keeps the models
it had.
`;

interface ProvidersEngine {
    main: (argv: string[]) => unknown;
}

export async function run(args: string[]): Promise<number> {
    const first = args[0];
    if (first === '--help' || first === '-h' || first === 'help') {
        process.stdout.write(HELP);
        return 0;
    }
    const { loadEngine } = await import('./engine');
    const engine = await loadEngine<ProvidersEngine>('opencode-providers.js');
    engine.main(args);
    return 0;
}
