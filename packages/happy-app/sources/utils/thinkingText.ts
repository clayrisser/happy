/**
 * The reducer stores a thinking block wrapped in italics markers (`*text*`)
 * so the old markdown path would have rendered it as an aside. The inline
 * "Thought process" row shows the reasoning itself, so strip exactly one
 * wrapper — never a character the model actually wrote.
 */
export function extractThinkingText(stored: string): string {
    const trimmed = stored.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('*') && trimmed.endsWith('*')) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}
