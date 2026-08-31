import * as React from 'react';
import {
    ActivityIndicator,
    type LayoutChangeEvent,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
    Pressable,
    ScrollView,
    Text,
    TouchableOpacity,
    useWindowDimensions,
    View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { useBackSwipeLock } from '@/hooks/useBackSwipeLock';
import { useSessionGates, type DroverGateEntry } from '@/hooks/usePendingGates';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { layout } from './layout';
import { describePendingGates, type PendingGatesKind } from './pendingGatesSummary';
import { sessionGateAction, sessionGateReadOnlyHint } from './sessionGateAction';
import {
    focusIndex,
    gateOverlayDismissals,
    gateOverlayFocus,
    overlayCounter,
    overlayDeck,
    pageForOffset,
    stepIndex,
    swipeDismisses,
} from './sessionGateDeck';
import { droverTodoCard } from './tools/views/droverTodoCard';
import { DroverTodoBody } from './tools/views/DroverTodoView';
import {
    providerAnswersFor,
    questionCards,
    toInlineQuestions,
} from './tools/views/askUserQuestionAnswers';
import {
    InlineQuestionForm,
    type InlineQuestionAnswers,
} from './tools/views/InlineQuestionForm';

/**
 * The prompt this session raised, floating over this session's own chat
 * (DROVE-19, DROVE-88).
 *
 * Clay, watching a session work: "I was kinda hoping that I wouldn't have to
 * navigate away to see notifications that are popping up. Whatever the active
 * session I'm in, shouldn't it just, like, boom, pop up on it?" DROVE-19 put
 * the card in the message flow above the composer. Then, from the phone:
 * "those little permission pop-ups should overlay the existing content, not
 * show below it." A card in the flow pushes the chat up, and when he is
 * scrolled up reading it is out of sight below the fold.
 *
 * So it is an OVERLAY. It is absolutely positioned off the top of the dock it
 * is mounted in, so it draws over the chat list and takes no space from it:
 * the list keeps its height and its scroll position, and the dock's measured
 * height (which is what the list reserves at its bottom) does not include it.
 * Because it lives inside the dock, it rides the same keyboard animation the
 * composer does; no second keyboard listener.
 *
 * The scrim is a dim rounded band behind the card and nothing more. The chat
 * around it stays readable and scrollable, because the point of an overlay is
 * to be on top of what you are reading, not to take the screen.
 *
 * It can be put away without being answered: the X, or a drag down on the
 * sheet's header. That is a dismissal to the INBOX. The gate stays pending on
 * the bus, the longhorn keeps counting it (DROVE-71), and the inbox still
 * lists it. Only this overlay forgets it, and only until the app relaunches.
 *
 * Two or more pending gates are one stacked card with a "2 of 3" counter, and
 * a horizontal swipe (or the chevrons) pages between them. Answering or
 * dismissing the card in view slides the next one into its place.
 *
 * It shows ONLY this session's gates. useSessionGates does that matching on an
 * exact Claude session uuid; a prompt from one of the other four sessions
 * running right now must never take this screen.
 *
 * Each card is drawn BY TOOL (DROVE-89): a to-do gets the same body the
 * transcript's DroverTodoView draws, a question gets its own options, and only
 * a real permission gets Deny / Allow. The answered gate is not this
 * component's business: the transcript's own tool card records it in place,
 * as it did before the overlay existed.
 */
export function SessionGateOverlay({ sessionId }: { sessionId: string }) {
    const { theme } = useUnistyles();
    const window = useWindowDimensions();
    const entries = useSessionGates(sessionId);
    const dismissed = React.useSyncExternalStore(
        gateOverlayDismissals.subscribe,
        gateOverlayDismissals.get,
        gateOverlayDismissals.get,
    );
    const [index, setIndex] = React.useState(0);
    const deck = React.useMemo(() => overlayDeck(entries, dismissed, index), [entries, dismissed, index]);
    // The card deck is full-width and page one's left swipe starts at the
    // screen edge, which is exactly where swipe-back is most eager (DROVE-216).
    const backSwipe = useBackSwipeLock();

    // A tap on a gate push asked for one card by id (DROVE-94). Page to it
    // once this session lists it, putting it back if it had been swiped away,
    // and consume the request so the chevrons work normally afterwards. Until
    // the store has caught up (a cold start) the request simply waits.
    const focus = React.useSyncExternalStore(gateOverlayFocus.subscribe, gateOverlayFocus.get, gateOverlayFocus.get);
    React.useEffect(() => {
        if (!focus || focus.sessionId !== sessionId) return;
        const at = focusIndex(entries, dismissed, focus.gateId);
        if (at < 0) return;
        const card = entries.find((entry) => entry.gate.id === focus.gateId || entry.requestId === focus.gateId);
        if (card) gateOverlayDismissals.restore([card.gate.id]);
        setIndex(at);
        gateOverlayFocus.clear(focus);
    }, [dismissed, entries, focus, sessionId]);
    const summary = describePendingGates(deck.cards.map((card) => card.gate));
    const current = deck.cards[deck.index] ?? null;
    const currentId = current?.gate.id ?? null;
    const counter = overlayCounter(deck.index, deck.count);

    // Page width comes from the sheet's own layout, so the pager and the
    // cards agree to the pixel on every phone and on a tablet's centred column.
    const [pageWidth, setPageWidth] = React.useState(0);
    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = Math.round(event.nativeEvent.layout.width);
        setPageWidth((width) => (Math.abs(width - next) < 1 ? width : next));
    }, []);

    const pagerRef = React.useRef<ScrollView>(null);
    React.useEffect(() => {
        if (pageWidth <= 0) return;
        pagerRef.current?.scrollTo({ x: deck.index * pageWidth, animated: false });
    }, [deck.index, deck.count, pageWidth]);
    const handlePageSettled = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        setIndex(pageForOffset(event.nativeEvent.contentOffset.x, pageWidth, deck.count));
    }, [deck.count, pageWidth]);
    const page = React.useCallback((delta: number) => {
        setIndex((from) => stepIndex(from, deck.count, delta));
    }, [deck.count]);

    const dismissCurrent = React.useCallback(() => {
        if (currentId) gateOverlayDismissals.dismiss([currentId]);
    }, [currentId]);

    // The sheet follows the finger down and either leaves or springs back.
    // Only the header is draggable: the body holds scroll views and buttons
    // that need their own vertical touches.
    const dragY = useSharedValue(0);
    React.useEffect(() => {
        // A new card in view starts at rest, whatever the last one was doing.
        dragY.value = 0;
    }, [currentId, dragY]);
    const drag = React.useMemo(() => Gesture.Pan()
        .activeOffsetY([-12, 12])
        .failOffsetX([-16, 16])
        .onUpdate((event) => {
            dragY.value = Math.max(0, event.translationY);
        })
        .onEnd((event) => {
            if (swipeDismisses(event.translationY, event.velocityY)) {
                dragY.value = withTiming(260, { duration: 160 }, (finished) => {
                    if (finished) runOnJS(dismissCurrent)();
                });
            } else {
                dragY.value = withSpring(0, { damping: 22, stiffness: 240 });
            }
        }), [dismissCurrent, dragY]);
    const sheetStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: dragY.value }],
        opacity: 1 - Math.min(1, dragY.value / 260) * 0.6,
    }));

    if (!summary || !current) return null;

    // Bounded so a long question cannot climb over the whole chat. Answering a
    // prompt you cannot see the context of is not answering it.
    const bodyMaxHeight = Math.min(340, Math.round(window.height * 0.42));

    return (
        <View style={styles.anchor} pointerEvents="box-none">
            <View style={styles.column} pointerEvents="box-none">
                <Animated.View style={[styles.scrim, sheetStyle]}>
                    <View style={styles.sheet}>
                        <GestureDetector gesture={drag}>
                            <View style={styles.header}>
                                <View style={styles.grabber} />
                                <View style={styles.headerRow}>
                                    <Ionicons
                                        name={overlayIcon(summary.kind)}
                                        size={18}
                                        color={theme.colors.box.warning.text}
                                    />
                                    <Text style={styles.headerTitle} numberOfLines={1}>{summary.title}</Text>
                                    {counter && (
                                        <View style={styles.pager} accessibilityLabel={`Card ${counter}`}>
                                            <Pressable
                                                onPress={() => page(-1)}
                                                disabled={deck.index === 0}
                                                hitSlop={8}
                                                accessibilityRole="button"
                                                accessibilityLabel="Previous card"
                                                style={({ pressed }) => [styles.pageButton, pressed && styles.pressed]}
                                            >
                                                <Ionicons
                                                    name="chevron-back"
                                                    size={16}
                                                    color={deck.index === 0 ? theme.colors.textSecondary : theme.colors.text}
                                                />
                                            </Pressable>
                                            <Text style={styles.counter}>{counter}</Text>
                                            <Pressable
                                                onPress={() => page(1)}
                                                disabled={deck.index >= deck.count - 1}
                                                hitSlop={8}
                                                accessibilityRole="button"
                                                accessibilityLabel="Next card"
                                                style={({ pressed }) => [styles.pageButton, pressed && styles.pressed]}
                                            >
                                                <Ionicons
                                                    name="chevron-forward"
                                                    size={16}
                                                    color={deck.index >= deck.count - 1 ? theme.colors.textSecondary : theme.colors.text}
                                                />
                                            </Pressable>
                                        </View>
                                    )}
                                    <Pressable
                                        onPress={dismissCurrent}
                                        hitSlop={8}
                                        accessibilityRole="button"
                                        accessibilityLabel="Dismiss to inbox"
                                        accessibilityHint="Keeps it waiting in the drover inbox"
                                        style={({ pressed }) => [styles.close, pressed && styles.pressed]}
                                    >
                                        <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
                                    </Pressable>
                                </View>
                            </View>
                        </GestureDetector>
                        <View style={styles.body} onLayout={handleLayout}>
                            {pageWidth > 0 && (
                                <ScrollView
                                    ref={pagerRef}
                                    horizontal={true}
                                    pagingEnabled={true}
                                    showsHorizontalScrollIndicator={false}
                                    // One card is not a carousel; the swipe would
                                    // only bounce.
                                    scrollEnabled={deck.count > 1}
                                    onMomentumScrollEnd={handlePageSettled}
                                    keyboardShouldPersistTaps="handled"
                                    {...backSwipe.scrollProps}
                                >
                                    {deck.cards.map((entry) => (
                                        <ScrollView
                                            key={entry.gate.id}
                                            style={{ width: pageWidth, maxHeight: bodyMaxHeight }}
                                            contentContainerStyle={styles.pageContent}
                                            nestedScrollEnabled={true}
                                            // The keyboard is usually up when a prompt
                                            // lands, and without this the first tap on
                                            // an option only dismisses it.
                                            keyboardShouldPersistTaps="handled"
                                        >
                                            <SessionGateCard entry={entry} />
                                        </ScrollView>
                                    ))}
                                </ScrollView>
                            )}
                        </View>
                    </View>
                </Animated.View>
            </View>
        </View>
    );
}

/**
 * A checklist for a set that is only to-dos, which block nothing; a hand for
 * anything that is holding a session up. The same pair the inbox headings use.
 */
function overlayIcon(kind: PendingGatesKind): 'hand-left-outline' | 'checkbox-outline' {
    return kind === 'todo' ? 'checkbox-outline' : 'hand-left-outline';
}

const SessionGateCard = React.memo(({ entry }: { entry: DroverGateEntry }) => {
    const { theme } = useUnistyles();
    // `entry.sessionId` is who HOLDS the card, which for a drover gate is the
    // bridge session and not the session on screen. Answering the session you
    // are looking at would reach an agent that never asked anything.
    const { gate, sessionId, requestId } = entry;
    const [busy, setBusy] = React.useState<'allow' | 'deny' | null>(null);

    const cards = React.useMemo(() => questionCards(entry.args), [entry.args]);
    const questions = React.useMemo(() => toInlineQuestions(cards), [cards]);
    const action = sessionGateAction(gate.kind, entry.args, entry.tool);
    const todo = React.useMemo(
        () => (action === 'todo' ? droverTodoCard(entry.args) : null),
        [action, entry.args],
    );

    // Close a to-do by naming the button that was pressed. The same call
    // DroverTodoView and the inbox make: the bridge's busResolutionFor takes a
    // to-do answer only when it carries one of the card's option ids, so this
    // is the one shape that actually resolves it on the bus.
    const closeTodo = React.useCallback(async (optionId: string) => {
        await sessionAllow(sessionId, requestId, undefined, undefined, 'approved', { optionId });
    }, [requestId, sessionId]);

    const submitAnswer = React.useCallback(async (answers: InlineQuestionAnswers) => {
        await sessionAllow(
            sessionId,
            requestId,
            undefined,
            undefined,
            'approved',
            { answers: providerAnswersFor(cards, answers) },
        );
    }, [cards, requestId, sessionId]);

    const decide = React.useCallback(async (allow: boolean) => {
        if (busy) return;
        setBusy(allow ? 'allow' : 'deny');
        try {
            if (allow) {
                await sessionAllow(sessionId, requestId);
            } else {
                await sessionDeny(sessionId, requestId);
            }
        } catch (error) {
            console.error('Failed to answer gate in place:', error);
        } finally {
            setBusy(null);
        }
    }, [busy, requestId, sessionId]);

    if (action === 'todo') {
        // A to-do with no title is not renderable; droverTodoCard says so by
        // returning null, and drawing two buttons over nothing would close a
        // record the screen could not describe.
        if (!todo) return null;
        return (
            <View style={[styles.card, styles.todoCard]}>
                <DroverTodoBody card={todo} canInteract={true} onClose={closeTodo} chip={false} />
            </View>
        );
    }

    if (action === 'answer-question') {
        return (
            <View style={styles.card}>
                <InlineQuestionForm
                    questions={questions}
                    canInteract={true}
                    onSubmit={submitAnswer}
                />
            </View>
        );
    }

    return (
        <View style={styles.card}>
            <Text style={styles.cardTitle} numberOfLines={1}>{gate.title}</Text>
            <Text style={styles.preview}>{gate.preview || gate.title}</Text>
            {action === 'read-only' ? (
                <Text style={styles.hint}>{sessionGateReadOnlyHint}</Text>
            ) : (
                <View style={styles.actions}>
                    <TouchableOpacity
                        style={[styles.action, styles.deny]}
                        onPress={() => decide(false)}
                        disabled={busy !== null}
                        activeOpacity={0.7}
                    >
                        {busy === 'deny'
                            ? <ActivityIndicator size="small" color={theme.colors.text} />
                            : <Text style={styles.denyText}>Deny</Text>}
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.action, styles.allow]}
                        onPress={() => decide(true)}
                        disabled={busy !== null}
                        activeOpacity={0.7}
                    >
                        {busy === 'allow'
                            ? <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                            : <Text style={styles.allowText}>Allow</Text>}
                    </TouchableOpacity>
                </View>
            )}
        </View>
    );
});

SessionGateCard.displayName = 'SessionGateCard';

const styles = StyleSheet.create((theme) => ({
    anchor: {
        // Off the top edge of whatever this is mounted in, which is the
        // composer dock. Absolute, so the dock's measured height (the inset
        // the chat list reserves) never includes it and the list does not
        // move when a card arrives or leaves.
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: '100%',
        overflow: 'visible',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingBottom: 6,
    },
    column: {
        width: '100%',
        maxWidth: layout.maxWidth,
    },
    scrim: {
        // The dim band behind the card, and only behind the card.
        borderRadius: 22,
        padding: 6,
        backgroundColor: theme.dark ? 'rgba(0, 0, 0, 0.55)' : 'rgba(0, 0, 0, 0.22)',
    },
    sheet: {
        borderRadius: 16,
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.box.warning.text,
        overflow: 'hidden',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.22,
        shadowRadius: 12,
        elevation: 10,
    },
    header: {
        paddingTop: 6,
        paddingBottom: 8,
        paddingHorizontal: 12,
    },
    grabber: {
        alignSelf: 'center',
        width: 36,
        height: 4,
        borderRadius: 2,
        backgroundColor: theme.colors.divider,
        marginBottom: 6,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 28,
    },
    headerTitle: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text,
        flex: 1,
        minWidth: 0,
    },
    pager: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        borderRadius: 12,
        paddingHorizontal: 2,
        backgroundColor: theme.colors.surfaceHigh,
    },
    pageButton: {
        width: 24,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    counter: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
        minWidth: 34,
        textAlign: 'center',
    },
    close: {
        width: 28,
        height: 28,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
    pressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    body: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    pageContent: {
        paddingHorizontal: 12,
        paddingTop: 12,
    },
    card: {
        // InlineQuestionForm's own ToolSectionView carries a bottom margin, so
        // the gap under a card lives on the card, not on the page.
        marginBottom: 4,
    },
    todoCard: {
        // DroverTodoBody brings no section wrapper of its own, so it takes the
        // margin the form's ToolSectionView would have carried.
        marginBottom: 12,
    },
    cardTitle: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text,
        marginBottom: 4,
    },
    preview: {
        ...Typography.mono(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text,
        marginBottom: 12,
    },
    hint: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginBottom: 12,
    },
    actions: {
        flexDirection: 'row',
        gap: 8,
        marginBottom: 12,
    },
    action: {
        flex: 1,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 10,
        borderWidth: 1,
    },
    deny: {
        backgroundColor: 'transparent',
        borderColor: theme.colors.divider,
    },
    denyText: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        color: theme.colors.text,
    },
    allow: {
        backgroundColor: theme.colors.button.primary.background,
        borderColor: theme.colors.button.primary.background,
    },
    allowText: {
        ...Typography.default('semiBold'),
        fontSize: 15,
        color: theme.colors.button.primary.tint,
    },
}));
