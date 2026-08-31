import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';
import { droverSkipPermissions } from '@/drover/permissionPolicy';

export function shouldForwardDaemonPermissionMode(
  agent: string,
  permissionMode: string | undefined,
): permissionMode is string {
  if (!permissionMode) return false;

  // Claude's "default" means no harness override. Codex's "default" is a
  // concrete ask-first execution policy and differs from its ambient "auto".
  return permissionMode !== 'default' || agent === 'codex';
}

/**
 * Apply the drover permission policy to a daemon launch (BASED-140).
 *
 * The terminal launcher prepends `--dangerously-skip-permissions` on every
 * session start (cattle-drover `bin/drover:212-223`); the daemon passed
 * nothing, so a session started from the phone ran in `default` and raised a
 * permission card for every tool call while the terminal beside it raised
 * none. Same policy, same switch, one source: `droverSkipPermissions` reads
 * `DROVER_SKIP_PERMISSIONS` and, failing that, the default written in
 * cattle-drover `etc/drover.env`.
 *
 * The phone still wins when it asks for something specific. An explicit
 * `permissionMode` on the spawn or resume request is forwarded as
 * `--permission-mode` and the bypass is NOT added on top, so "start this one
 * in plan mode" from the app means plan mode. Claude's `"default"` is not
 * explicit — older app builds send it with every request — so it leaves the
 * policy in charge.
 *
 * Claude only. `--dangerously-skip-permissions` is a Claude flag, and Codex's
 * equivalent (`--permission-mode yolo`) is a policy call the app makes for
 * itself rather than one the daemon should assume.
 *
 * The bus gates are untouched by any of this. The six `ask-*.sh` gates are
 * `preToolUse` hooks (`~/.shotgun/hooks.json`), and Claude Code runs
 * PreToolUse hooks whatever the permission mode is — bypass skips the PROMPT,
 * not the hooks — so a destructive bash or a WhatsApp send still raises a card
 * on the phone.
 */
export function appendDaemonPermissionArgs(
  args: string[],
  agent: string,
  permissionMode: string | undefined,
  skipPermissions: boolean = droverSkipPermissions(),
): void {
  if (shouldForwardDaemonPermissionMode(agent, permissionMode)) {
    args.push('--permission-mode', permissionMode);
    return;
  }
  if (agent === 'claude' && skipPermissions) {
    // Lands in `claudeArgs` (src/index.ts:706-713), which is exactly where
    // `resolveInitialClaudePermissionMode` looks for it.
    args.push('--dangerously-skip-permissions');
  }
}

export function appendDaemonSpawnModeArgs(
  args: string[],
  options: SpawnSessionOptions,
  agent: string,
  skipPermissions: boolean = droverSkipPermissions(),
): void {
  // Cursor takes a model and nothing else (DROVE-57): a `--print` turn has no
  // permission mode to set, and Cursor spells effort inside the model id
  // (`cursor-grok-4.6-xhigh-fast`), so there is no `--effort` to forward.
  // `auto` is a real Cursor model id, so unlike Claude's `default` it is
  // passed through rather than treated as "no override".
  if (agent === 'cursor') {
    if (options.modelMode) {
      args.push('--model', options.modelMode);
    }
    return;
  }
  if (agent !== 'claude' && agent !== 'codex') return;

  appendDaemonPermissionArgs(args, agent, options.permissionMode, skipPermissions);
  if (options.modelMode && options.modelMode !== 'default') {
    args.push('--model', options.modelMode);
  }
  if (options.effortLevel) {
    args.push('--effort', options.effortLevel);
  }
}
