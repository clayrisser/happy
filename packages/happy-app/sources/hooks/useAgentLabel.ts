/**
 * The agent's name for an envelope card, off the store (DROVE-392).
 *
 * A selector that returns a STRING, so the card rides zustand's identity
 * check and re-renders only when the name itself changes: an agent that was
 * a bare id when its message landed picks up its label the moment the live
 * tree or the transcript can supply one, and nothing else about the
 * transcript re-draws the card.
 */
import { storage } from '@/sync/storage';
import { agentLabelFrom } from '@/utils/agentLabel';

export function useAgentLabel(sessionId: string, agentId: string | null): string | null {
    return storage((state) => {
        if (!agentId) return null;
        const session = state.sessions[sessionId];
        const messages = state.sessionMessages[sessionId]?.messages;
        return agentLabelFrom(session?.metadata?.liveStatus?.agents, messages, agentId);
    });
}
