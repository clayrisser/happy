/**
 * The one socket call behind the agent screen (DROVE-93). Kept apart from
 * subagentTranscript.ts so that file stays importable under vitest.
 */
import { apiSocket } from './apiSocket';
import type { SubagentTranscriptRequest, SubagentTranscriptResponse } from './subagentTranscript';

export async function fetchSubagentTranscript(
    sessionId: string,
    agentId: string,
    since: number,
): Promise<SubagentTranscriptResponse> {
    return await apiSocket.sessionRPC<SubagentTranscriptResponse, SubagentTranscriptRequest>(
        sessionId,
        'subagentTranscript',
        { agentId, ...(since > 0 ? { since } : {}) },
    );
}
