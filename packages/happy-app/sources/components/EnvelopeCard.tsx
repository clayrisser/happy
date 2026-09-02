/**
 * A user turn Claude Code injected, drawn as what it is (DROVE-392).
 *
 * Clay, with a screenshot of `<agent-message from="aaefbd4ef38db65e9">` at
 * the top of a user bubble: "this should be formatted special somewhere."
 * Nothing in that bubble was his. So an injected envelope is not a bubble on
 * his side of the transcript; it is a card in the flow, headed by who sent
 * it, folded until he wants the rest.
 *
 * THREE SHAPES, one component:
 *
 *   card    agent-message, a peer's cross-session-message, task-notification.
 *           A header row (glyph, the sender's name, the outcome for a
 *           notification, a chevron), one preview line under it while
 *           folded, and the body in place when opened, closing from its own
 *           foot the way every disclosure does (DROVE-150).
 *   line    system-reminder. One dim row; the note opens under it.
 *   line    command. One dim row and nothing under it.
 *
 * THE SURFACE IS OPAQUE, not glass. MobileGlass's rule: content surfaces stay
 * opaque so glass remains the chrome's own layer, and a report in the
 * transcript is content. It borrows the tool card's `surfaceHigh` so a
 * subagent's report and its tool calls read as one family.
 *
 * LAYOUT SYSTEM ONLY (DROVE-376): explicit line heights, paddings that own
 * their gaps, no computed offsets and no negative margins. The header's
 * `minHeight` is the row's box; the text inside it has a declared line box,
 * so what iOS draws is what the numbers say.
 *
 * COPY DENSITY (DROVE-346): the header is a name, the outcome is one
 * lowercase word, the preview is the sender's own first line. No explainer
 * prose anywhere on the card.
 *
 * The raw tag never reaches this file. The parser hands over parts, and the
 * one test that matters here renders each real envelope and asserts the tag
 * text is absent from everything on screen.
 */
import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import { t } from '@/text';
import {
    envelopePreview,
    shortAgentId,
    taskPreview,
    taskStatusWord,
    taskSummaryIsTerse,
    type TaskNotificationEnvelope,
    type UserEnvelope,
} from '@/utils/userEnvelope';
import { MarkdownView } from './markdown/MarkdownView';
import { LongPressCopyable } from './LongPressCopyable';
import { DisclosureFooter, useInlineDisclosure } from './DisclosureFooter';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

/**
 * The header row's box: 8 over, 20 of row, 8 under, 36 in all. The text
 * inside declares an 18pt line box, so the row is the row and not the font.
 */
const headerRowHeight = 20;
/** The dim line's box, the same as the transcript's disclosure header. */
const lineMinHeight = 28;

/**
 * The agent id an envelope names, for the label lookup, or null. A notice
 * about several agents names none: it is counted, not resolved.
 */
export function envelopeAgentId(envelope: UserEnvelope | null): string | null {
    if (!envelope) return null;
    if (envelope.kind === 'agent-message') return envelope.from;
    if (envelope.kind === 'task-notification' && envelope.taskIds.length === 1) return envelope.taskIds[0];
    return null;
}

function statusLabel(envelope: TaskNotificationEnvelope): string {
    const word = taskStatusWord(envelope.status);
    if (word === 'finished') return t('message.envelopeFinished');
    if (word === 'failed') return t('message.envelopeFailed');
    if (word === 'stopped') return t('message.envelopeStopped');
    return word;
}

/** What heads a task notification: the agent, the command, or the count. */
export function taskLabel(envelope: TaskNotificationEnvelope, agentLabel: string | null): string {
    if (envelope.taskIds.length === 1) {
        return agentLabel ?? envelope.name ?? shortAgentId(envelope.taskIds[0]);
    }
    if (envelope.name) return envelope.name;
    return t('message.envelopeAgents', { count: envelope.taskIds.length });
}

export function EnvelopeCard(props: {
    envelope: UserEnvelope;
    /** The agent's name off the live tree or the transcript, when known. */
    agentLabel: string | null;
    sessionId: string;
}) {
    const { envelope, agentLabel, sessionId } = props;
    switch (envelope.kind) {
        case 'agent-message':
            return (
                <Card
                    glyph="chatbubble-ellipses-outline"
                    label={agentLabel ?? shortAgentId(envelope.from)}
                    preview={envelopePreview(envelope.body)}
                    body={envelope.body}
                    sessionId={sessionId}
                />
            );
        case 'cross-session-message':
            return (
                <Card
                    glyph="swap-horizontal-outline"
                    label={envelope.fromName}
                    preview={envelopePreview(envelope.body)}
                    body={envelope.body}
                    sessionId={sessionId}
                />
            );
        case 'task-notification': {
            const word = taskStatusWord(envelope.status);
            const detail = [
                taskSummaryIsTerse(envelope) ? null : envelope.summary,
                envelope.result,
                envelope.failures,
                envelope.diagnostics,
            ].filter((part): part is string => typeof part === 'string' && part.length > 0);
            return (
                <Card
                    glyph={word === 'failed' ? 'alert-circle-outline' : 'rocket-outline'}
                    label={taskLabel(envelope, agentLabel)}
                    status={statusLabel(envelope)}
                    preview={taskPreview(envelope)}
                    body={detail.join('\n\n')}
                    sessionId={sessionId}
                />
            );
        }
        case 'system-reminder':
            return (
                <Line
                    glyph="information-circle-outline"
                    label={t('message.envelopeReminder')}
                    preview={envelopePreview(envelope.body)}
                    body={envelope.body}
                    sessionId={sessionId}
                />
            );
        case 'command':
            return <Line glyph="terminal-outline" label={`/${envelope.name}`} preview="" body={null} sessionId={sessionId} />;
        default: {
            const _exhaustive: never = envelope;
            return _exhaustive;
        }
    }
}

function Card(props: {
    glyph: IoniconName;
    label: string;
    status?: string;
    preview: string;
    body: string;
    sessionId: string;
}) {
    const { theme } = useUnistyles();
    const { expanded, toggle, collapse, headerRef, footerRef } = useInlineDisclosure();
    return (
        <View style={styles.card}>
            <Pressable
                ref={headerRef}
                collapsable={false}
                accessibilityRole="button"
                onPress={toggle}
                style={({ pressed }) => [styles.header, pressed && styles.pressed]}
            >
                <View style={styles.headerRow}>
                    <Ionicons name={props.glyph} size={14} color={theme.colors.textSecondary} />
                    <Text style={styles.label} numberOfLines={1}>{props.label}</Text>
                    {props.status ? <Text style={styles.status}>{props.status}</Text> : null}
                    <Ionicons
                        name={expanded ? 'chevron-down' : 'chevron-forward'}
                        size={13}
                        color={theme.colors.textSecondary}
                    />
                </View>
                {!expanded && props.preview.length > 0 ? (
                    <Text style={styles.preview} numberOfLines={1}>{props.preview}</Text>
                ) : null}
            </Pressable>
            {expanded ? (
                <>
                    <View style={styles.body}>
                        {props.body.length > 0 ? (
                            <LongPressCopyable text={props.body}>
                                <MarkdownView externalCopyHandler markdown={props.body} sessionId={props.sessionId} />
                            </LongPressCopyable>
                        ) : null}
                    </View>
                    <DisclosureFooter
                        label={props.label}
                        onPress={collapse}
                        innerRef={footerRef}
                        textStyle={styles.footerText}
                        style={styles.footer}
                    />
                </>
            ) : null}
        </View>
    );
}

function Line(props: {
    glyph: IoniconName;
    label: string;
    preview: string;
    /** Null for a row that has nothing to open. */
    body: string | null;
    sessionId: string;
}) {
    const { theme } = useUnistyles();
    const { expanded, toggle, collapse, headerRef, footerRef } = useInlineDisclosure();
    const openable = props.body !== null && props.body.length > 0;
    const text = props.preview.length > 0 ? `${props.label} · ${props.preview}` : props.label;
    return (
        <View style={styles.line}>
            <Pressable
                ref={headerRef}
                collapsable={false}
                accessibilityRole={openable ? 'button' : 'text'}
                disabled={!openable}
                onPress={toggle}
                style={({ pressed }) => [styles.lineRow, pressed && styles.pressed]}
            >
                <Ionicons name={props.glyph} size={13} color={theme.colors.textSecondary} />
                <Text style={styles.lineText} numberOfLines={1}>{text}</Text>
                {openable ? (
                    <Ionicons
                        name={expanded ? 'chevron-down' : 'chevron-forward'}
                        size={13}
                        color={theme.colors.textSecondary}
                    />
                ) : null}
            </Pressable>
            {expanded && openable ? (
                <>
                    <View style={styles.lineBody}>
                        <MarkdownView markdown={props.body ?? ''} sessionId={props.sessionId} />
                    </View>
                    <DisclosureFooter
                        label={props.label}
                        onPress={collapse}
                        innerRef={footerRef}
                        textStyle={styles.lineText}
                    />
                </>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    card: {
        marginHorizontal: 16,
        marginVertical: 6,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHigh,
        maxWidth: '100%',
        overflow: 'hidden',
    },
    header: {
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: 8,
        gap: 4,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: headerRowHeight,
    },
    pressed: {
        opacity: 0.6,
    },
    label: {
        flexShrink: 1,
        minWidth: 0,
        fontSize: 13,
        lineHeight: 18,
        fontWeight: '600',
        color: theme.colors.text,
    },
    status: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    preview: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    body: {
        paddingHorizontal: 12,
        paddingBottom: 4,
    },
    footer: {
        paddingHorizontal: 12,
    },
    footerText: {
        fontSize: 13,
        lineHeight: 20,
        color: theme.colors.textSecondary,
    },
    line: {
        marginHorizontal: 16,
        marginVertical: 4,
        maxWidth: '100%',
        overflow: 'hidden',
    },
    lineRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        alignSelf: 'stretch',
        minHeight: lineMinHeight,
        paddingVertical: 4,
        opacity: 0.72,
    },
    lineText: {
        flexShrink: 1,
        minWidth: 0,
        fontSize: 13,
        lineHeight: 20,
        color: theme.colors.textSecondary,
    },
    lineBody: {
        marginTop: 2,
        opacity: 0.85,
    },
}));
