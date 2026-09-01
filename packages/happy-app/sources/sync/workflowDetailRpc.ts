/**
 * The one socket call behind the wave screen (DROVE-290). The shapes live in
 * @slopus/happy-wire, the same module the CLI folds them with, so neither end
 * can drift from the other.
 */
import type { WorkflowDetailRequest, WorkflowDetailResponse } from '@slopus/happy-wire';

import { apiSocket } from './apiSocket';

export async function fetchWorkflowDetail(
    sessionId: string,
    runId: string,
    wave?: number,
): Promise<WorkflowDetailResponse> {
    return await apiSocket.sessionRPC<WorkflowDetailResponse, WorkflowDetailRequest>(
        sessionId,
        'workflowDetail',
        { runId, ...(wave !== undefined ? { wave } : {}) },
    );
}
