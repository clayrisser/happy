/**
 * Codex's file-event download, which is now the shared one (DROVE-378).
 *
 * This was the only copy until every other harness needed the same three
 * lines. It stays as a named export because runCodex and its tests call it,
 * but the body lives in `@/utils/harnessAttachments` so the two cannot drift.
 */
import type { ApiSessionClient } from '@/api/apiSession';
import type { FileEventMessage } from '@/api/types';
import { downloadFileEventAttachment } from '@/utils/harnessAttachments';
import type { PendingAttachment } from '@/utils/MessageQueue2';

type CodexAttachmentDownloader = Pick<ApiSessionClient, 'downloadAndDecryptAttachment'>;

export async function downloadCodexFileEventAttachment(
    session: CodexAttachmentDownloader,
    fileEvent: FileEventMessage,
): Promise<PendingAttachment | null> {
    return downloadFileEventAttachment(session, fileEvent, 'Codex');
}
