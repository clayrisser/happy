/**
 * Reading a mirrored to-do card, apart from rendering it (DROVE-69).
 *
 * happy-cli's requestForEvent writes this card for a bus event of kind `todo`
 * — `drover needs "push the release" --why … --do …`. It gets its own shape
 * rather than riding the Bash permission card, because on that card every
 * generic approve path in the app could close it: the phone's Allow, the
 * wrist's Allow, the realtime voice tool. Event 4c3f5082 was acked that way
 * with nobody having touched it.
 *
 * Pure, and separate from the view, so the parsing is testable without
 * mounting React — the same split askUserQuestionAnswers has.
 */

export interface DroverTodoOption {
    id: string;
    label: string;
}

export interface DroverTodoCard {
    title: string;
    reason: string;
    /** The command the agent gave, if it gave one. Often there is none. */
    command: string;
    options: DroverTodoOption[];
}

function optionsOf(raw: unknown): DroverTodoOption[] {
    if (!Array.isArray(raw)) return [];
    const out: DroverTodoOption[] = [];
    for (const entry of raw) {
        const option = entry as { id?: unknown; label?: unknown };
        if (!option || typeof option !== 'object') continue;
        if (typeof option.id !== 'string' || !option.id) continue;
        out.push({
            id: option.id,
            label: typeof option.label === 'string' && option.label ? option.label : option.id,
        });
    }
    return out;
}

/**
 * The card, or null when this input is not one.
 *
 * A to-do with no title is not renderable and must not draw an empty card with
 * two buttons on it — pressing one would close a record the screen could not
 * describe.
 */
export function droverTodoCard(input: unknown): DroverTodoCard | null {
    const raw = (input ?? {}) as Record<string, unknown>;
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!title) return null;
    return {
        title,
        reason: typeof raw.reason === 'string' ? raw.reason.trim() : '',
        command: typeof raw.command === 'string' ? raw.command.trim() : '',
        // Falling back to the pair `drover needs` injects at create, so a card
        // written by a bridge that predates the options ever being carried is
        // still answerable rather than a dead end.
        options: optionsOf(raw.options).length
            ? optionsOf(raw.options)
            : [{ id: 'done', label: 'Done' }, { id: 'drop', label: 'Drop it' }],
    };
}
