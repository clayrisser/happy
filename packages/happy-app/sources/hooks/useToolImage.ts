/**
 * The picture a tool call has, from whichever end can supply it (DROVE-366).
 *
 * First choice is the result itself: a Read of an image carries its base64,
 * and that costs nothing to draw. When it does not, and the path it read is a
 * picture the phone uploaded, the phone fetches its own copy back instead of
 * showing an empty row. The join is in utils/readImageAttachment.
 */
import * as React from 'react';

import type { Message, ToolCall } from '@/sync/typesMessage';
import { toolResultImage, type ToolResultImage } from '@/utils/imageResult';
import { readImageAttachment, toolReadPath } from '@/utils/readImageAttachment';

import { useAttachmentImage } from './useAttachmentImage';

/** The mime the decrypted blob was sniffed as, off the data URI it came back on. */
function mediaTypeOf(uri: string): string {
    if (!uri.startsWith('data:')) {
        return 'image/png';
    }
    const end = uri.indexOf(';');
    return end > 5 ? uri.slice(5, end) : 'image/png';
}

export function useToolImage(
    tool: ToolCall,
    messages: readonly Message[],
    sessionId: string | undefined,
): ToolResultImage | null {
    const fromResult = React.useMemo(
        () => (tool.state === 'completed' ? toolResultImage(tool.result) : null),
        [tool.state, tool.result],
    );

    // Only asked when the result had nothing. The join reads the filename
    // before it reads the transcript, so a row that is not a landed upload
    // costs one string test and no scan.
    const attachment = React.useMemo(
        () => (fromResult ? null : readImageAttachment(toolReadPath(tool.input), messages)),
        [fromResult, tool.input, messages],
    );

    const { uri } = useAttachmentImage(sessionId ?? '', sessionId ? attachment?.ref : undefined);

    return React.useMemo(() => {
        if (fromResult) {
            return fromResult;
        }
        if (!attachment || !uri) {
            return null;
        }
        return {
            uri,
            mediaType: mediaTypeOf(uri),
            width: attachment.width,
            height: attachment.height,
        };
    }, [fromResult, attachment, uri]);
}
