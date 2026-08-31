import { MarkdownSpan, parseMarkdown } from './parseMarkdown';
import { type HighlightedSpan, highlightSpans } from './sentenceHighlight';
import { type SentenceRun, splitIntoSentenceRuns } from './sentenceTargets';
import * as React from 'react';
import { Image, Pressable, View, Platform } from 'react-native';
import { HorizontalScrollView } from '../HorizontalScrollView';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { DoubleTap, WrapGlyph, useDoubleTapPress } from '../CodeWrapToggle';
import { useCodeWrap } from '../useCodeWrap';
import { Text } from '../StyledText';
import { Typography } from '@/constants/Typography';
import { SimpleSyntaxHighlighter } from '../SimpleSyntaxHighlighter';
import { Modal } from '@/modal';
import { useLocalSetting } from '@/sync/storage';
import { storeTempText } from '@/sync/persistence';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { MermaidRenderer } from './MermaidRenderer';
import { t } from '@/text';
import { isHttpMarkdownLink } from './linkUtils';
import { openExternalUrl } from '@/utils/openExternalUrl';

// Option type for callback
export type Option = {
    title: string;
};

export const MarkdownView = React.memo((props: { 
    markdown: string;
    onOptionPress?: (option: Option) => void;
    sessionId?: string;
    /**
     * The parent owns long-press copy (see LongPressCopyable). Suppresses native
     * selection and the built-in copy gesture so only one of them fires.
     */
    externalCopyHandler?: boolean;
    /**
     * The sentence read-aloud is speaking out of this message right now
     * (DROVE-114). Marked where it is found and ignored where it is not; it
     * changes colour only, never layout, so it cannot move the viewport.
     */
    highlightSentence?: string | null;
    /**
     * A sentence of prose was tapped (DROVE-163), with its rendered text.
     *
     * Given, every prose block is cut into one pressable run per sentence, so
     * the layout engine does the hit test and the caller is told which
     * sentence the finger was inside. Left out, blocks render exactly as they
     * did — one Text, no extra nesting — which is what a user bubble, a
     * preview or a tool card wants.
     */
    onSentencePress?: (sentence: string) => void;
}) => {
    const blocks = React.useMemo(() => parseMarkdown(props.markdown), [props.markdown]);
    
    // Backwards compatibility: The original version just returned the view, wrapping the list of blocks.
    // It made each of the individual text elements selectable. When we enable the markdownCopyV2 feature,
    // we disable the selectable property on individual text segments on mobile only. Instead, the long press
    // will be handled by a wrapper Pressable. If we don't disable the selectable property, then you will see
    // the native copy modal come up at the same time as the long press handler is fired.
    const markdownCopyV2 = useLocalSetting('markdownCopyV2');
    const selectable = Platform.OS === 'web' || !(markdownCopyV2 || props.externalCopyHandler);
    const router = useRouter();

    const handleLinkPress = React.useCallback((url: string) => {
        if (!isHttpMarkdownLink(url)) {
            return;
        }

        void openExternalUrl(url);
    }, []);

    const handleLongPress = React.useCallback(() => {
        try {
            const textId = storeTempText(props.markdown);
            router.push(`/text-selection?textId=${textId}`);
        } catch (error) {
            console.error('Error storing text for selection:', error);
            Modal.alert('Error', 'Failed to open text selection. Please try again.');
        }
    }, [props.markdown, router]);
    const renderContent = () => {
        return (
            <View style={{ width: '100%' }}>
                {blocks.map((block, index) => {
                    if (block.type === 'text') {
                        return <RenderTextBlock spans={block.content} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} onLinkPress={handleLinkPress} highlightSentence={props.highlightSentence} onSentencePress={props.onSentencePress} />;
                    } else if (block.type === 'header') {
                        return <RenderHeaderBlock level={block.level} spans={block.content} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} onLinkPress={handleLinkPress} highlightSentence={props.highlightSentence} onSentencePress={props.onSentencePress} />;
                    } else if (block.type === 'horizontal-rule') {
                        return <View style={style.horizontalRule} key={index} />;
                    } else if (block.type === 'list') {
                        return <RenderListBlock items={block.items} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} onLinkPress={handleLinkPress} highlightSentence={props.highlightSentence} onSentencePress={props.onSentencePress} />;
                    } else if (block.type === 'numbered-list') {
                        return <RenderNumberedListBlock items={block.items} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} onLinkPress={handleLinkPress} highlightSentence={props.highlightSentence} onSentencePress={props.onSentencePress} />;
                    } else if (block.type === 'code-block') {
                        return <RenderCodeBlock content={block.content} language={block.language} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} />;
                    } else if (block.type === 'mermaid') {
                        return <MermaidRenderer content={block.content} key={index} />;
                    } else if (block.type === 'options') {
                        return <RenderOptionsBlock items={block.items} key={index} first={index === 0} last={index === blocks.length - 1} selectable={selectable} onOptionPress={props.onOptionPress} />;
                    } else if (block.type === 'table') {
                        return <RenderTableBlock headers={block.headers} rows={block.rows} onLinkPress={handleLinkPress} selectable={selectable} key={index} first={index === 0} last={index === blocks.length - 1} />;
                    } else if (block.type === 'image') {
                        return <RenderImageBlock url={block.url} alt={block.alt} key={index} first={index === 0} last={index === blocks.length - 1} />;
                    } else {
                        return null;
                    }
                })}
            </View>
        );
    }

    if (props.externalCopyHandler || !markdownCopyV2) {
        return renderContent();
    }
    
    if (Platform.OS === 'web') {
        return renderContent();
    }
    
    // Use GestureDetector with LongPress gesture - it doesn't block pan gestures
    // so horizontal scrolling in code blocks and tables still works
    const longPressGesture = Gesture.LongPress()
        .minDuration(500)
        .onStart(() => {
            handleLongPress();
        })
        .runOnJS(true);

    return (
        <GestureDetector gesture={longPressGesture}>
            <View style={{ width: '100%' }}>
                {renderContent()}
            </View>
        </GestureDetector>
    );
});

type RenderSpanProps = {
    spans: (MarkdownSpan | HighlightedSpan)[];
    baseStyle?: any;
    selectable: boolean;
    onLinkPress: (url: string) => void;
};

function RenderTextBlock(props: { spans: MarkdownSpan[], first: boolean, last: boolean, selectable: boolean, onLinkPress: (url: string) => void, highlightSentence?: string | null, onSentencePress?: (sentence: string) => void }) {
    return (
        <Text selectable={props.selectable} style={[style.text, props.first && style.first, props.last && style.last]}>
            <RenderBody
                spans={props.spans}
                baseStyle={style.text}
                selectable={props.selectable}
                onLinkPress={props.onLinkPress}
                highlightSentence={props.highlightSentence}
                onSentencePress={props.onSentencePress}
            />
        </Text>
    );
}

/** Split the spans around the spoken sentence, or leave them exactly as they were. */
function useHighlightedSpans(spans: MarkdownSpan[], sentence: string | null | undefined): (MarkdownSpan | HighlightedSpan)[] {
    return React.useMemo(
        () => highlightSpans(spans, sentence ?? null) ?? spans,
        [spans, sentence],
    );
}

/**
 * A block's spans, marked for the voice and cut for the finger.
 *
 * With no `onSentencePress` this is exactly the old single list of spans. With
 * one, the block becomes one pressable Text per sentence (DROVE-163) and the
 * spoken-sentence mark is applied inside each run, so the two splits do not
 * have to know about each other: at most one run contains the spoken sentence
 * and the rest come back unchanged.
 *
 * The press is a DOUBLE tap (DROVE-235). A single tap on prose does nothing,
 * which is what it did before the seek existed.
 */
function RenderBody(props: {
    spans: MarkdownSpan[],
    baseStyle: any,
    selectable: boolean,
    onLinkPress: (url: string) => void,
    highlightSentence?: string | null,
    onSentencePress?: (sentence: string) => void,
}) {
    const { onSentencePress } = props;
    const runs = React.useMemo(
        () => (onSentencePress ? splitIntoSentenceRuns(props.spans) : null),
        [props.spans, onSentencePress],
    );
    const plain = useHighlightedSpans(props.spans, props.highlightSentence);
    if (runs === null || onSentencePress === undefined) {
        return <RenderSpans spans={plain} baseStyle={props.baseStyle} selectable={props.selectable} onLinkPress={props.onLinkPress} />;
    }
    return (<>
        {runs.map((run, index) => (
            <TappableSentence
                key={index}
                run={run}
                baseStyle={props.baseStyle}
                selectable={props.selectable}
                onLinkPress={props.onLinkPress}
                highlightSentence={props.highlightSentence}
                onSentencePress={onSentencePress}
            />
        ))}
    </>);
}

/**
 * One sentence of prose, and the double tap that reads from it (DROVE-235).
 *
 * Clay asked for two taps, and two is also the safer count: a single tap on
 * body text is what a finger does by accident, dismissing the keyboard or
 * stopping a scroll, and moving the read head is deliberate.
 *
 * Counted by hand rather than with `Gesture.Tap().numberOfTaps(2)`, because a
 * GestureDetector renders a View and this Text is inline inside the paragraph
 * Text above it. See `doubleTapPress.ts`. Each sentence keeps its own pending
 * tap, so a tap on one sentence followed by a tap on the next seeks to
 * neither.
 *
 * A link inside the run keeps its own single press: the innermost Text with an
 * onPress wins, so one tap still opens a link and never seeks.
 *
 * Known cost: VoiceOver activates with one double tap that arrives as a single
 * onPress, so a screen reader cannot seek this way. Nobody has asked for it
 * yet, and the fix is an accessibilityAction rather than a different count.
 */
function TappableSentence(props: {
    run: SentenceRun,
    baseStyle: any,
    selectable: boolean,
    onLinkPress: (url: string) => void,
    highlightSentence?: string | null,
    onSentencePress: (sentence: string) => void,
}) {
    const { onSentencePress, run } = props;
    const seek = React.useCallback(() => onSentencePress(run.sentence), [onSentencePress, run.sentence]);
    const onPress = useDoubleTapPress(seek);
    return (
        <Text
            selectable={props.selectable}
            style={props.baseStyle}
            onPress={onPress}
        >
            <RenderSpans
                spans={highlightSpans(run.spans, props.highlightSentence ?? null) ?? run.spans}
                baseStyle={props.baseStyle}
                selectable={props.selectable}
                onLinkPress={props.onLinkPress}
            />
        </Text>
    );
}

function RenderHeaderBlock(props: { level: 1 | 2 | 3 | 4 | 5 | 6, spans: MarkdownSpan[], first: boolean, last: boolean, selectable: boolean, onLinkPress: (url: string) => void, highlightSentence?: string | null, onSentencePress?: (sentence: string) => void }) {
    const s = (style as any)[`header${props.level}`];
    const headerStyle = [style.header, s, props.first && style.first, props.last && style.last];
    return (
        <Text selectable={props.selectable} style={headerStyle}>
            <RenderBody
                spans={props.spans}
                baseStyle={headerStyle}
                selectable={props.selectable}
                onLinkPress={props.onLinkPress}
                highlightSentence={props.highlightSentence}
                onSentencePress={props.onSentencePress}
            />
        </Text>
    );
}

const BULLETS = ['•', '◦', '▪'] as const;

function RenderListBlock(props: { items: { depth: number, spans: MarkdownSpan[] }[], first: boolean, last: boolean, selectable: boolean, onLinkPress: (url: string) => void, highlightSentence?: string | null, onSentencePress?: (sentence: string) => void }) {
    const listStyle = [style.text, style.list];
    return (
        <View style={{ flexDirection: 'column', marginBottom: 8, gap: 6 }}>
            {props.items.map((item, index) => (
                <View key={index} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingLeft: item.depth * 16 }}>
                    <Text selectable={false} style={[listStyle, { marginRight: 8, marginTop: 1 }]}>{BULLETS[Math.min(item.depth, BULLETS.length - 1)]}</Text>
                    <Text selectable={props.selectable} style={[listStyle, { flex: 1 }]}>
                        <RenderBody spans={item.spans} baseStyle={listStyle} selectable={props.selectable} onLinkPress={props.onLinkPress} highlightSentence={props.highlightSentence} onSentencePress={props.onSentencePress} />
                    </Text>
                </View>
            ))}
        </View>
    );
}

function RenderNumberedListBlock(props: { items: { number: number, depth: number, spans: MarkdownSpan[] }[], first: boolean, last: boolean, selectable: boolean, onLinkPress: (url: string) => void, highlightSentence?: string | null, onSentencePress?: (sentence: string) => void }) {
    const listStyle = [style.text, style.list];
    return (
        <View style={{ flexDirection: 'column', marginBottom: 8, gap: 6 }}>
            {props.items.map((item, index) => (
                <View key={index} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingLeft: item.depth * 16 }}>
                    <Text selectable={false} style={[listStyle, { marginRight: 8, marginTop: 1 }]}>{item.number}.</Text>
                    <Text selectable={props.selectable} style={[listStyle, { flex: 1 }]}>
                        <RenderBody spans={item.spans} baseStyle={listStyle} selectable={props.selectable} onLinkPress={props.onLinkPress} highlightSentence={props.highlightSentence} onSentencePress={props.onSentencePress} />
                    </Text>
                </View>
            ))}
        </View>
    );
}

function RenderCodeBlock(props: { content: string, language: string | null, first: boolean, last: boolean, selectable: boolean }) {
    const [isHovered, setIsHovered] = React.useState(false);
    // Code blocks arrive wrapped (DROVE-149): the text breaks inside the
    // block. A double-tap flips every code block back to the horizontal
    // ScrollView, for a table or a diff that wrapping ruins.
    //
    // This block takes no `onSentencePress` and never has, so the sentence
    // seek's own double tap (DROVE-235) cannot reach inside a code fence:
    // there are no sentence runs here to land on. The wrap toggle keeps the
    // gesture, which is the right way round. Its double tap is older and more
    // local, and a code block is not something Clay asks to be read aloud.
    const [wrap, toggleWrap] = useCodeWrap('code');
    const { theme } = useUnistyles();

    const copyCode = React.useCallback(async () => {
        try {
            await Clipboard.setStringAsync(props.content);
            Modal.alert(t('common.success'), t('markdown.codeCopied'), [{ text: t('common.ok'), style: 'cancel' }]);
        } catch (error) {
            console.error('Failed to copy code:', error);
            Modal.alert(t('common.error'), t('markdown.copyFailed'), [{ text: t('common.ok'), style: 'cancel' }]);
        }
    }, [props.content]);

    return (
        <View
            style={[style.codeBlock, props.first && style.first, props.last && style.last]}
            // @ts-ignore - Web only events
            onMouseEnter={() => setIsHovered(true)}
            // @ts-ignore - Web only events
            onMouseLeave={() => setIsHovered(false)}
        >
            <DoubleTap onDoubleTap={toggleWrap}>
                {props.language && <Text selectable={props.selectable} style={style.codeLanguage}>{props.language}</Text>}
                {wrap ? (
                    <View style={style.codeWrapped}>
                        <SimpleSyntaxHighlighter
                            code={props.content}
                            language={props.language}
                            selectable={props.selectable}
                        />
                    </View>
                ) : (
                    <HorizontalScrollView
                        contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 16 }}
                    >
                        <SimpleSyntaxHighlighter
                            code={props.content}
                            language={props.language}
                            selectable={props.selectable}
                        />
                    </HorizontalScrollView>
                )}
                <WrapGlyph on={wrap} color={theme.colors.textSecondary} style={style.codeWrapGlyph} />
            </DoubleTap>
            <View
                style={[style.copyButtonWrapper, isHovered && style.copyButtonWrapperVisible]}
                {...(Platform.OS === 'web' ? ({ className: 'copy-button-wrapper' } as any) : {})}
            >
                <Pressable
                    style={style.copyButton}
                    onPress={copyCode}
                >
                    <Text style={style.copyButtonText}>{t('common.copy')}</Text>
                </Pressable>
            </View>
        </View>
    );
}

function RenderImageBlock(props: { url: string, alt: string, first: boolean, last: boolean }) {
    const accessibleLabel = props.alt || 'Markdown image';

    return (
        <View style={[style.imageBlock, props.first && style.first, props.last && style.last]}>
            <Image
                source={{ uri: props.url }}
                style={style.image}
                accessibilityLabel={accessibleLabel}
                resizeMode="contain"
            />
            {props.alt ? (
                <Text style={style.imageCaption}>{props.alt}</Text>
            ) : null}
        </View>
    );
}

function RenderOptionsBlock(props: { 
    items: string[], 
    first: boolean, 
    last: boolean, 
    selectable: boolean,
    onOptionPress?: (option: Option) => void 
}) {
    return (
        <View style={[style.optionsContainer, props.first && style.first, props.last && style.last]}>
            {props.items.map((item, index) => {
                if (props.onOptionPress) {
                    return (
                        <Pressable
                            key={index}
                            style={({ pressed }) => [
                                style.optionPressable,
                                style.optionButton,
                                pressed && style.optionButtonPressed
                            ]}
                            onPress={() => props.onOptionPress?.({ title: item })}
                        >
                            <Text selectable={props.selectable} style={style.optionButtonText}>{item}</Text>
                        </Pressable>
                    );
                } else {
                    return (
                        <View key={index} style={style.optionItem}>
                            <Text selectable={props.selectable} style={style.optionText}>{item}</Text>
                        </View>
                    );
                }
            })}
        </View>
    );
}

function isHighlighted(span: MarkdownSpan | HighlightedSpan): boolean {
    return 'highlighted' in span && span.highlighted === true;
}

function RenderSpans(props: RenderSpanProps) {
    return (<>
        {props.spans.map((span, index) => {
            if (span.url) {
                const isExternalLink = isHttpMarkdownLink(span.url);
                return (
                    <Text
                        key={index}
                        selectable={props.selectable}
                        accessibilityRole={isExternalLink ? 'link' : undefined}
                        style={[props.baseStyle, isExternalLink && style.link, span.styles.map(s => style[s]), isHighlighted(span) && style.spoken]}
                        {...(isExternalLink && Platform.OS === 'web' ? { onClick: () => props.onLinkPress(span.url!) } as any : {})}
                        onPress={isExternalLink && Platform.OS !== 'web'
                            ? () => props.onLinkPress(span.url!)
                            : undefined}
                    >
                        {span.text}
                    </Text>
                );
            } else {
                return <Text key={index} selectable={props.selectable} style={[props.baseStyle, span.styles.map(s => style[s]), isHighlighted(span) && style.spoken]}>{span.text}</Text>
            }
        })}
    </>)
}

// Plain-text length of a span array — used to estimate column widths.
function spansLength(spans: MarkdownSpan[]): number {
    let n = 0;
    for (const s of spans) n += s.text.length;
    return n;
}

const TABLE_MIN_COL_WIDTH = 80;
const TABLE_MAX_COL_WIDTH = 360;
const TABLE_CHAR_WIDTH = 8.5;  // approx px per char at 16px default font
const TABLE_CELL_H_PADDING = 24;

// Row-first layout with content-estimated column widths.
//
// - Each column's width is picked from the widest text in that column (header +
//   rows), clamped to [MIN, MAX]. This gives column-alignment across rows and
//   lets narrow columns (like "1, 2, 3") stay narrow.
// - Each row is a flex row — default `alignItems: 'stretch'` makes all cells in
//   a row match the tallest cell's height.
// - Wrapped in a horizontal ScrollView so wide tables still scroll instead of
//   being squashed unreadably.
function RenderTableBlock(props: {
    headers: MarkdownSpan[][],
    rows: MarkdownSpan[][][],
    onLinkPress: (url: string) => void,
    selectable: boolean,
    first: boolean,
    last: boolean
}) {
    const columnCount = props.headers.length;
    const rowCount = props.rows.length;
    const isLastCol = (colIndex: number) => colIndex === columnCount - 1;
    const isLastRow = (rowIndex: number) => rowIndex === rowCount - 1;

    const columnWidths = React.useMemo(() => {
        const widths = new Array(columnCount).fill(0);
        for (let c = 0; c < columnCount; c++) {
            widths[c] = Math.max(widths[c], spansLength(props.headers[c] ?? []));
        }
        for (const row of props.rows) {
            for (let c = 0; c < columnCount; c++) {
                widths[c] = Math.max(widths[c], spansLength(row[c] ?? []));
            }
        }
        return widths.map(len => Math.min(TABLE_MAX_COL_WIDTH, Math.max(TABLE_MIN_COL_WIDTH, len * TABLE_CHAR_WIDTH + TABLE_CELL_H_PADDING)));
    }, [props.headers, props.rows, columnCount]);

    return (
        <View style={[style.tableContainer, props.first && style.first, props.last && style.last]}>
            {/* flexGrow:0 stops iOS from stretching the horizontal ScrollView
                vertically to fill the parent — the cause of the table's frame
                extending down past the last row into empty space. */}
            <HorizontalScrollView style={{ flexGrow: 0 }}>
                <View>
                    {/* Header row */}
                    <View style={[style.tableRow, style.tableHeaderRow]}>
                        {props.headers.map((header, colIndex) => (
                            <View
                                key={`header-${colIndex}`}
                                style={[style.tableCell, style.tableHeaderCell, { width: columnWidths[colIndex] }, !isLastCol(colIndex) && style.tableCellBorderRight]}
                            >
                                <Text style={style.tableHeaderText}>
                                    <RenderSpans spans={header} baseStyle={style.tableHeaderText} onLinkPress={props.onLinkPress} selectable={props.selectable} />
                                </Text>
                            </View>
                        ))}
                    </View>
                    {/* Data rows */}
                    {props.rows.map((row, rowIndex) => (
                        <View
                            key={`row-${rowIndex}`}
                            style={[style.tableRow, !isLastRow(rowIndex) && style.tableRowBorderBottom]}
                        >
                            {props.headers.map((_, colIndex) => (
                                <View
                                    key={`cell-${rowIndex}-${colIndex}`}
                                    style={[style.tableCell, { width: columnWidths[colIndex] }, !isLastCol(colIndex) && style.tableCellBorderRight]}
                                >
                                    <Text style={style.tableCellText}>
                                        <RenderSpans spans={row[colIndex] ?? []} baseStyle={style.tableCellText} onLinkPress={props.onLinkPress} selectable={props.selectable} />
                                    </Text>
                                </View>
                            ))}
                        </View>
                    ))}
                </View>
            </HorizontalScrollView>
        </View>
    );
}


const style = StyleSheet.create((theme) => ({

    // Plain text

    text: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 25,
        marginTop: 8,
        marginBottom: 10,
        color: theme.colors.text,
        fontWeight: '400',
    },

    // The sentence read-aloud is on right now (DROVE-114), coloured rather
    // than highlighted (DROVE-125): the grey block read as selected text, and
    // on a dark theme it was heavy. COLOUR ONLY, and this is the constraint
    // that matters rather than a preference. The mark may not change the text
    // metrics, because a reflow is a new viewport, and a new viewport seeks
    // the reader, which would move the mark. Colour does not reflow. Weight,
    // size, style and family all would, so none of them may be added here.
    spoken: {
        color: theme.colors.spokenSentence,
    },
    italic: {
        fontStyle: 'italic',
    },
    bold: {
        ...Typography.default('semiBold'),
        fontWeight: '700',
    },
    semibold: {
        ...Typography.default('semiBold'),
        fontWeight: '600',
    },
    code: {
        ...Typography.mono(),
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.text,
    },
    link: {
        ...Typography.default(),
        color: theme.colors.text,
        fontWeight: '400',
        textDecorationLine: 'underline',
        cursor: 'pointer',
    },

    // Headers

    header: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    header1: {
        fontSize: 16,
        lineHeight: 24,  // Reduced from 36 to 24
        fontWeight: '900',
        marginTop: 16,
        marginBottom: 8
    },
    header2: {
        fontSize: 20,
        lineHeight: 24,  // Reduced from 36 to 32
        fontWeight: '600',
        marginTop: 16,
        marginBottom: 8
    },
    header3: {
        fontSize: 16,
        lineHeight: 28,  // Reduced from 32 to 28
        fontWeight: '600',
        marginTop: 16,
        marginBottom: 8,
    },
    header4: {
        fontSize: 16,
        lineHeight: 24,
        fontWeight: '600',
        marginTop: 8,
        marginBottom: 8,
    },
    header5: {
        fontSize: 16,
        lineHeight: 24,  // Reduced from 28 to 24
        fontWeight: '600'
    },
    header6: {
        fontSize: 16,
        lineHeight: 24, // Reduced from 28 to 24
        fontWeight: '600'
    },

    //
    // List
    //

    list: {
        ...Typography.default(),
        color: theme.colors.text,
        marginTop: 0,
        marginBottom: 0,
    },

    //
    // Common
    //

    first: {
        // marginTop: 0
    },
    last: {
        // marginBottom: 0
    },

    //
    // Code Block
    //

    codeBlock: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
        marginVertical: 8,
        position: 'relative',
        zIndex: 1,
        width: '100%',
    },
    copyButtonWrapper: {
        position: 'absolute',
        top: 8,
        right: 8,
        opacity: 0,
        zIndex: 10,
        elevation: 10,
        pointerEvents: 'none',
    },
    copyButtonWrapperVisible: {
        opacity: 1,
        pointerEvents: 'auto',
    },
    codeLanguage: {
        ...Typography.mono(),
        color: theme.colors.textSecondary,
        fontSize: 12,
        marginTop: 8,
        paddingHorizontal: 16,
        marginBottom: 0,
    },
    codeWrapped: {
        paddingHorizontal: 16,
        paddingVertical: 16,
        width: '100%',
    },
    codeWrapGlyph: {
        top: undefined,
        bottom: 6,
        right: 8,
    },
    codeText: {
        ...Typography.mono(),
        color: theme.colors.text,
        fontSize: 14,
        lineHeight: 20,
    },
    horizontalRule: {
        height: 1,
        backgroundColor: theme.colors.divider,
        marginTop: 8,
        marginBottom: 8,
    },
    imageBlock: {
        width: '100%',
        maxWidth: 520,
        marginVertical: 8,
        alignSelf: 'flex-start',
        gap: 8,
    },
    image: {
        width: '100%',
        minHeight: 160,
        height: 240,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHighest,
    },
    imageCaption: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.textSecondary,
    },
    copyButtonContainer: {
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 10,
        elevation: 10,
        opacity: 1,
    },
    copyButtonContainerHidden: {
        opacity: 0,
    },
    copyButton: {
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        cursor: 'pointer',
    },
    copyButtonHidden: {
        display: 'none',
    },
    copyButtonCopied: {
        backgroundColor: theme.colors.success,
        borderColor: theme.colors.success,
        opacity: 1,
    },
    copyButtonText: {
        ...Typography.default(),
        color: theme.colors.text,
        fontSize: 12,
        lineHeight: 16,
    },

    //
    // Options Block
    //

    optionsContainer: {
        flexDirection: 'column',
        gap: 8,
        marginVertical: 8,
    },
    optionPressable: {
        borderRadius: Platform.select({ web: 8, default: 18 }),
    },
    optionItem: {
        backgroundColor: Platform.select({ web: theme.colors.surfaceHighest, default: theme.colors.surface }),
        borderRadius: Platform.select({ web: 8, default: 18 }),
        paddingHorizontal: 16,
        paddingVertical: Platform.select({ web: 12, default: 14 }),
        borderWidth: Platform.select({ web: 1, default: StyleSheet.hairlineWidth }),
        borderColor: theme.colors.divider,
        overflow: 'hidden',
    },
    optionItemPressed: {
        backgroundColor: Platform.select({ web: theme.colors.surfaceHigh, default: theme.colors.surfacePressed }),
        opacity: Platform.select({ web: 0.7, default: 1 }),
    },
    optionText: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.text,
    },
    // Tapping an option sends it as your message. Full-width rows in the
    // composer send button's resting grey — flat, no border.
    optionButton: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
        overflow: 'hidden',
    },
    optionButtonPressed: {
        opacity: 0.7,
    },
    optionButtonText: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.text,
    },

    //
    // Table
    //

    tableContainer: {
        marginVertical: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 8,
        overflow: 'hidden',
        maxWidth: '100%',
        alignSelf: 'flex-start',
    },
    tableRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
    },
    tableRowBorderBottom: {
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    tableHeaderRow: {
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    tableCell: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        alignItems: 'flex-start',
    },
    tableCellBorderRight: {
        borderRightWidth: 1,
        borderRightColor: theme.colors.divider,
    },
    tableHeaderCell: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    tableHeaderText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 24,
    },
    tableCellText: {
        ...Typography.default(),
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 24,
    },

    // Add global style for Web platform (Unistyles supports this via compiler plugin)
    ...(Platform.OS === 'web' ? {
        // Web-only CSS styles
        _____web_global_styles: {}
    } : {}),
}));
