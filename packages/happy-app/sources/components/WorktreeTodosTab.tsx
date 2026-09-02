/**
 * The Todos tab of the worktree sheet (DROVE-330, reshaped by DROVE-380).
 *
 * Clay: "a tab there that shows the todo". Two lists, because the app keeps
 * two things called that, and a tab that showed one and hid the other would
 * read as broken:
 *
 *   NEEDS YOU   the drover's to-dos: `drover needs` raised them, `drover
 *               todos` lists them, and they reach the phone as gates of kind
 *               `todo` through the bridge. LIVE, not a snapshot: this reads
 *               the same store the inbox reads, so a to-do closed in the
 *               terminal leaves this list the moment the bus says so.
 *
 *   TASK LIST   Claude's own plan for the session, off TodoWrite, drawn by
 *               SessionTasksList, which is drawn once and reused everywhere
 *               (DROVE-167).
 *
 * THEN CLAY PHOTOGRAPHED IT AGAIN: "Is there a richer way to display this, or
 * to communicate this?" The shot is two grey captions, two grey fragments, and
 * two thirds of a screen of black. DROVE-359 was right to cut the paragraphs
 * that used to fill it; what was wrong is that nothing took their place.
 *
 * So, three states per section and every one of them drawn on purpose:
 *
 *   EMPTY       a large glyph over the ONE fragment, centred in room taken off
 *               the cap (worktreeSheetLayout), rather than a grey line pinned
 *               to the top of a black tab. Still one fragment — copyDensity
 *               holds both of them to the same 40 characters.
 *   POPULATED   a needs-you card per to-do, and a real checklist for the tasks
 *               with `3 of 7` and a thin bar over it.
 *   WORKING     the task in hand marked and pulsing, done rows dimmed.
 *
 * A card OPENS rather than carrying two buttons at rest. Tapping it reveals
 * DroverTodoBody — the same body the transcript card and the gate overlay use
 * (DROVE-69) — so there is exactly one thing in the app that closes a to-do,
 * and it closes it by naming the OPTION the bus expects. It expands in place
 * rather than presenting a second sheet: this tab is already inside a Modal,
 * and a sheet over a sheet is the bug DROVE-183 is about.
 */
import * as React from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useSessionGates } from '@/hooks/usePendingGates';
import { splitInbox } from '@/sync/droverGates';
import { sessionAllow } from '@/sync/ops';
import { todosTabSections, type NeedsCardRow, type TodosEmptyGlyph } from '@/utils/todosTabSections';
import { answerWithDeadline, gateAnswerTrouble } from './gateAnswerTimeout';
import { hapticsConfirm } from './haptics';
import { SessionTasksList, useSessionTasks } from './SessionTasksList';
import { DroverTodoBody } from './tools/views/DroverTodoView';
import {
    needsCardGap,
    todosEmptyGap,
    todosEmptyGlyphSize,
    todosEmptySectionHeight,
    todosSectionInset,
} from './worktreeSheetLayout';

const stylesheet = StyleSheet.create((theme) => ({
    section: {
        paddingHorizontal: todosSectionInset.horizontal,
        paddingTop: todosSectionInset.top,
        paddingBottom: todosSectionInset.bottom,
        gap: todosSectionInset.gap,
    },
    sectionTitle: {
        fontSize: 10,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    /* The glyph and its fragment, centred in the room the section was given
       rather than stacked under the caption. */
    emptyBlock: {
        alignItems: 'center',
        justifyContent: 'center',
        gap: todosEmptyGap,
    },
    empty: {
        fontSize: 13,
        lineHeight: 19,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
    cards: {
        gap: needsCardGap,
    },
    card: {
        gap: 4,
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHigh,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
    },
    title: {
        flex: 1,
        fontSize: 14,
        lineHeight: 19,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    age: {
        fontSize: 12,
        lineHeight: 19,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    context: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    trouble: {
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.warning,
        ...Typography.default(),
    },
}));

/** The two empty glyphs, off the icon set the rest of the sheet already draws. */
function EmptyGlyph({ glyph, color }: { glyph: TodosEmptyGlyph; color: string }) {
    if (glyph === 'needs') {
        // The raised hand: somebody is asking for you. `checklist` for the
        // other one is the same glyph the wrist draws for an empty task list,
        // so the two surfaces agree about what nothing looks like.
        return <Ionicons name="hand-left-outline" size={todosEmptyGlyphSize} color={color} />;
    }
    return <Octicons name="checklist" size={todosEmptyGlyphSize} color={color} />;
}

function EmptyState({ glyph, fragment, height }: { glyph: TodosEmptyGlyph; fragment: string; height: number }) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <View style={[styles.emptyBlock, { height }]} accessibilityLabel={fragment}>
            <EmptyGlyph glyph={glyph} color={theme.colors.textSecondary} />
            {/* One fragment. The second sentence that used to be here
                explained `drover needs` to the person least able to run it
                (DROVE-359), and copyDensity now pins both by value. */}
            <Text style={styles.empty}>{fragment}</Text>
        </View>
    );
}

/**
 * One to-do: shut, it is a title, a fragment and an age; open, it is the gate
 * cards' own body with its options on it.
 *
 * Closed by naming the button (DROVE-69). Both options go through
 * sessionAllow with an optionId, because the bus reads the OPTION and not the
 * verb: a drop is not a denial, it is a choice to not do the job.
 */
function NeedsCard({ row }: { row: NeedsCardRow }) {
    const styles = stylesheet;
    const [open, setOpen] = React.useState(false);
    const [trouble, setTrouble] = React.useState<string | null>(null);
    const { sessionId, requestId } = row;

    const close = React.useCallback(async (optionId: string) => {
        setTrouble(null);
        const outcome = await answerWithDeadline(
            () => sessionAllow(sessionId, requestId, undefined, undefined, 'approved', { optionId }),
        );
        const complaint = gateAnswerTrouble(outcome);
        if (complaint) {
            setTrouble(complaint);
            // Thrown so DroverTodoBody un-sets itself and offers the buttons
            // again. A card reading "Marked done." over a to-do the bus never
            // heard about is the one outcome worse than saying nothing.
            throw new Error(complaint);
        }
        // The confirmation, and it answers to the phoneHaptics switch, which
        // ships off (DROVE-190). The gate is inside components/haptics, not
        // here, so this cannot forget it.
        hapticsConfirm();
    }, [requestId, sessionId]);

    return (
        <View style={styles.card}>
            {open ? (
                <>
                    <View style={styles.titleRow}>
                        <View style={{ flex: 1 }}>
                            {/* chip off: the caption over this list already
                                says NEEDS YOU, and saying it twice on one
                                screen is the density DROVE-346 is about. */}
                            <DroverTodoBody card={row.card} canInteract onClose={close} chip={false} />
                        </View>
                        {!!row.age && <Text style={styles.age}>{row.age}</Text>}
                    </View>
                    <Pressable
                        onPress={() => setOpen(false)}
                        accessibilityRole="button"
                        accessibilityLabel={`Collapse ${row.card.title}`}
                        hitSlop={8}
                        style={({ pressed }) => [{ alignSelf: 'flex-start', opacity: pressed ? 0.7 : 1 }]}
                    >
                        <Octicons name="chevron-up" size={14} color={styles.age.color} />
                    </Pressable>
                </>
            ) : (
                <Pressable
                    onPress={() => setOpen(true)}
                    accessibilityRole="button"
                    accessibilityLabel={`To-do: ${row.card.title}${row.context ? `, ${row.context}` : ''}`}
                    accessibilityHint="Opens it so it can be marked done"
                    style={({ pressed }) => [{ gap: 4 }, pressed && { opacity: 0.7 }]}
                >
                    <View style={styles.titleRow}>
                        <Text style={styles.title} numberOfLines={2}>{row.card.title}</Text>
                        {!!row.age && <Text style={styles.age}>{row.age}</Text>}
                    </View>
                    {/* One fragment of context, and nothing at all when the
                        agent gave none: an empty second line reads as a card
                        that failed to render. */}
                    {!!row.context && <Text style={styles.context} numberOfLines={1}>{row.context}</Text>}
                </Pressable>
            )}
            {!!trouble && <Text style={styles.trouble}>{trouble}</Text>}
        </View>
    );
}

export function WorktreeTodosTab({ sessionId }: { sessionId: string }) {
    const styles = stylesheet;
    const gates = useSessionGates(sessionId);
    const todos = React.useMemo(() => splitInbox(gates).todos, [gates]);
    const tasks = useSessionTasks(sessionId);
    const sections = React.useMemo(() => todosTabSections({ todos, tasks }), [todos, tasks]);
    // The room an empty section gets, off the cap rather than off a padding
    // somebody picked. Both empty is the screenshot, and both empty is the
    // case that has to fill the tab.
    const window = useWindowDimensions();
    const safeArea = useSafeAreaInsets();
    const emptyHeight = todosEmptySectionHeight({
        windowHeight: window.height,
        safeAreaTop: safeArea.top,
        safeAreaBottom: safeArea.bottom,
    }, sections.emptySections);
    return (
        <View>
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>{sections.needs.caption}</Text>
                {sections.needs.empty ? (
                    <EmptyState
                        glyph={sections.needs.glyph}
                        fragment={sections.needs.fragment}
                        height={emptyHeight}
                    />
                ) : (
                    <View style={styles.cards}>
                        {sections.needs.cards.map((row) => (
                            <NeedsCard key={row.requestId} row={row} />
                        ))}
                    </View>
                )}
            </View>
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>{sections.tasks.caption}</Text>
                {sections.tasks.empty ? (
                    <EmptyState
                        glyph={sections.tasks.glyph}
                        fragment={sections.tasks.fragment}
                        height={emptyHeight}
                    />
                ) : (
                    <SessionTasksList tasks={tasks} progress />
                )}
            </View>
        </View>
    );
}
