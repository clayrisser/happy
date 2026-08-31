/**
 * View for 'file' tool calls (image attachments sent by user).
 * Downloads and decrypts the encrypted blob via apiAttachments + sessionBlobKey,
 * then renders the full image inline with the thumbhash as placeholder.
 *
 * Always renders inline when a ref is present — if dimensions are missing
 * (older messages, iOS picker that didn't report w/h), a default 4:3 aspect
 * ratio is used until the actual image lands and contentFit shows it.
 *
 * Sizing and the tap-to-zoom live in components/InlineImage, shared with the
 * picture a tool read (DROVE-151). The thumbnail used to cap at 280pt and sit
 * left of a half-empty row; it now takes the message column.
 */
import * as React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolViewProps } from './_all';
import { z } from 'zod';
import { InlineImage } from '@/components/InlineImage';
import { useAttachmentImage } from '@/hooks/useAttachmentImage';
import { thumbhashToDataUri } from '@/utils/thumbhash';

const fileInputSchema = z.object({
    ref: z.string(),
    name: z.string(),
    size: z.number().optional(),
    image: z.object({
        width: z.number(),
        height: z.number(),
        thumbhash: z.string().optional(),
    }).optional(),
});

export const FileView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const { theme } = useUnistyles();
    const parsed = fileInputSchema.safeParse(tool.input);
    if (!parsed.success) return null;

    const { name, image, ref } = parsed.data;

    const placeholder = React.useMemo(() => {
        if (!image?.thumbhash) return undefined;
        const uri = thumbhashToDataUri(image.thumbhash);
        return uri ? { uri } : undefined;
    }, [image?.thumbhash]);

    const { uri, error } = useAttachmentImage(sessionId ?? '', sessionId ? ref : undefined);

    // A blob that will not decrypt degrades to a warning beside the filename
    // row below, never an empty frame.
    const broken = (
        <Ionicons name="alert-circle-outline" size={18} color={theme.colors.textSecondary} />
    );

    return (
        <View style={styles.inlineContainer}>
            {error && !uri ? broken : (
                <InlineImage
                    uri={uri ?? undefined}
                    width={image?.width}
                    height={image?.height}
                    placeholder={placeholder}
                    fallback={broken}
                />
            )}
            <Text style={[styles.filename, { color: theme.colors.textSecondary }]} numberOfLines={1}>{name}</Text>
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    inlineContainer: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 4,
    },
    filename: {
        fontSize: 13,
        fontWeight: '500',
    },
}));
