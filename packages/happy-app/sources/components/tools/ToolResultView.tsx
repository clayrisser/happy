/**
 * The result half of a tool card, drawn for what the result actually is
 * (DROVE-51). A Read of an image reached the detail screen as "No output was
 * produced" because the screen only knew how to print strings; a structured
 * MCP result reached it as a JSON blob.
 *
 * What a result IS is decided in utils/toolResult; this file only draws it.
 */
import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { t } from '@/text';
import { CodeView } from '@/components/CodeView';
import { InlineImage } from '@/components/InlineImage';
import { structuredRows } from '@/utils/structuredFields';
import { presentToolResult, type ToolResultPresentation } from '@/utils/toolResult';
import { RowsView } from './StructuredFieldsView';
import { ToolCollapsibleSection } from './ToolCollapsibleSection';

const PresentationView = React.memo<{ presentation: ToolResultPresentation; mono: boolean }>((
    { presentation, mono },
) => {
    switch (presentation.kind) {
        case 'empty':
            return null;
        case 'image':
            // Full width, aspect kept, no black bars. The sizing is in
            // utils/imageResult so both this screen and the transcript row
            // get the same picture (DROVE-151).
            return (
                <InlineImage
                    uri={presentation.uri}
                    width={presentation.width}
                    height={presentation.height}
                    fallback={<Text style={styles.text}>{`[${presentation.mediaType}]`}</Text>}
                />
            );
        case 'text':
            return mono
                ? <CodeView code={presentation.text} />
                : <Text style={styles.text}>{presentation.text}</Text>;
        case 'structured':
            return <RowsView rows={structuredRows(presentation.value)} />;
        case 'mixed':
            return (
                <View style={styles.parts}>
                    {presentation.parts.map((part, index) => (
                        <PresentationView key={index} presentation={part} mono={mono} />
                    ))}
                </View>
            );
    }
});

interface ToolResultViewProps {
    result: unknown;
    /** Terminal-ish output reads better fixed-width; prose does not. */
    mono?: boolean;
    /**
     * Keep a wall of output behind a disclosure. The inline card wants this —
     * the JSON fallback it replaces collapsed anything over 20 lines, and
     * losing that would flood the transcript. The detail screen does not.
     */
    collapseLong?: boolean;
}

/** Past either of these a text result is a wall, not a value to read in place. */
const wallLines = 20;
const wallChars = 1200;

/** Null when there is genuinely nothing, which is the only honest "no output". */
export const ToolResultView = React.memo<ToolResultViewProps>(({ result, mono = true, collapseLong = false }) => {
    const presentation = React.useMemo(() => presentToolResult(result), [result]);
    if (presentation.kind === 'empty') {
        return null;
    }
    if (collapseLong && presentation.kind === 'text') {
        const lineCount = presentation.text.split('\n').length;
        if (lineCount > wallLines || presentation.text.length > wallChars) {
            return (
                <ToolCollapsibleSection title={t('toolView.output')} lineCount={lineCount}>
                    <PresentationView presentation={presentation} mono={mono} />
                </ToolCollapsibleSection>
            );
        }
    }
    return <PresentationView presentation={presentation} mono={mono} />;
});

const styles = StyleSheet.create((theme) => ({
    text: {
        fontSize: 13,
        lineHeight: 19,
        color: theme.colors.text,
    },
    parts: {
        gap: 8,
    },
}));
