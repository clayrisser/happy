export type AgentTurnCopyMessage = {
    id: string;
    kind: string;
    text?: string;
    isThinking?: boolean;
};

/**
 * Builds the copy payload for each completed assistant turn and attaches it to
 * that turn's final text block. Messages are newest-first, while copied text
 * should read in chronological order.
 */
export function buildAgentTurnCopyTextByMessageId(
    messages: readonly AgentTurnCopyMessage[],
    options: { currentTurnComplete: boolean },
): Map<string, string> {
    const messagesByTurn = new Map<number, AgentTurnCopyMessage[]>();
    let turn = 0;

    for (const message of messages) {
        if (message.kind === 'agent-text' && !message.isThinking && message.text?.trim()) {
            const turnMessages = messagesByTurn.get(turn) ?? [];
            turnMessages.push(message);
            messagesByTurn.set(turn, turnMessages);
        }
        if (message.kind === 'user-text') {
            turn++;
        }
    }

    const result = new Map<string, string>();
    for (const [turnNumber, turnMessagesNewestFirst] of messagesByTurn) {
        if (turnNumber === 0 && !options.currentTurnComplete) {
            continue;
        }
        const finalMessage = turnMessagesNewestFirst[0];
        const copyText = [...turnMessagesNewestFirst]
            .reverse()
            .map((message) => message.text!.trim())
            .join('\n\n');
        if (finalMessage && copyText) {
            result.set(finalMessage.id, copyText);
        }
    }

    return result;
}

/**
 * What a long press on one assistant block copies (DROVE-121).
 *
 * The copy glyph that used to sit under every reply is gone: it cost a line
 * on every message and duplicated the hold gesture the rest of the transcript
 * already uses. The capability moved onto that gesture, and it copies the
 * same thing the glyph did wherever the glyph existed, which is the whole
 * turn on its final block. Every other block, including one in a turn still
 * being written, copies itself rather than nothing.
 */
export function agentLongPressCopyText(
    turnCopyText: string | undefined,
    messageText: string,
): string | null {
    const turn = turnCopyText?.trim();
    if (turn) return turn;
    const own = messageText.trim();
    return own ? own : null;
}