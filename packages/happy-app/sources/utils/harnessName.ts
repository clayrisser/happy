/**
 * The display name for a session's harness (DROVE-57).
 *
 * This was an inline chain of ifs inside session/[id]/info.tsx, which is why
 * it fell behind: the fork gained agy and openclaw runners and the info screen
 * kept rendering the raw flavor slug for them, so a session said "agy" where
 * every other one said "Claude". Adding a harness should be one line in one
 * place, and it should be testable without mounting a screen.
 *
 * The fallback is the slug itself rather than "Unknown". A slug is at least
 * true, and a session labelled Unknown is indistinguishable from a bug.
 */

const names: Record<string, string> = {
    claude: 'Claude',
    // Codex has shipped under two flavor slugs and both are still on real
    // sessions, so both are kept rather than migrated.
    gpt: 'Codex',
    openai: 'Codex',
    codex: 'Codex',
    gemini: 'Gemini',
    openclaw: 'OpenClaw',
    agy: 'Antigravity',
    cursor: 'Cursor',
    // DROVE-56. Two ways a session arrives with this flavor: `happy acp
    // opencode`, whose runAcp already stamps it, and a `drover opencode` pane.
    // Both are the same agent, so both read as one name here.
    opencode: 'OpenCode',
};

/**
 * `flavor` is optional on Metadata and absent on every session written before
 * the field existed. Those are all Claude Code sessions, which is why the
 * empty case resolves to Claude rather than to nothing.
 */
export function harnessName(flavor?: string | null): string {
    const key = flavor || 'claude';
    return names[key] ?? key;
}
