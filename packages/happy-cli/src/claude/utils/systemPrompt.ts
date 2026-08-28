import { trimIdent } from "@/utils/trimIdent";
import { shouldIncludeCoAuthoredBy } from "./claudeSettings";

/**
 * Base system prompt shared across all configurations
 */
const BASE_SYSTEM_PROMPT = (() => trimIdent(`
    ALWAYS when you start a new chat - you must call a tool "mcp__happy__change_title" to set a chat title. When you think chat title is not relevant anymore - call the tool again to change it. When chat name is too generic and you have a change to make it more specific - call the tool again to change it. This title is needed to easily find the chat in the future. Help human.
`))();

/**
 * Co-authored-by credits to append when enabled
 */
// Upstream appended a second trailer here advertising the tool itself:
// `via [Happy](https://happy.engineering)` and
// `Co-Authored-By: Happy <yesreply@happy.engineering>`, on by default.
//
// That is dropped rather than rebranded (BASED-98). A Co-Authored-By trailer
// records who WROTE the change, and the wrapper that relayed the keystrokes
// did not. Leaving it in would stamp a foreign identity into every commit made
// from a phone — exactly the drift Clay's one-author rule exists to prevent,
// and it would need a .mailmap line in six repos to undo. Claude's own trailer
// stays, because Claude did write the code.
const CO_AUTHORED_CREDITS = (() => trimIdent(`
    When making commit messages, give co-credit to Claude like so:

    <main commit message>

    Generated with [Claude Code](https://claude.ai/code)

    Co-Authored-By: Claude <noreply@anthropic.com>
`))();

/**
 * System prompt with conditional Co-Authored-By lines based on Claude's settings.json configuration.
 * Settings are read once on startup for performance.
 */
export const systemPrompt = (() => {
  const includeCoAuthored = shouldIncludeCoAuthoredBy();
  
  if (includeCoAuthored) {
    return BASE_SYSTEM_PROMPT + '\n\n' + CO_AUTHORED_CREDITS;
  } else {
    return BASE_SYSTEM_PROMPT;
  }
})();