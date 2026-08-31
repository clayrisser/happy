/**
 * The usage popup's rows (DROVE-107), in fixed columns (DROVE-117).
 *
 * Clay, with a screenshot: "it should be displayed as bars and be more thin,
 * not take up so much space." Every account cost three text lines before this
 * - the name and percent on one, the reset time on the next, a long name
 * wrapping onto a third - so five accounts filled the phone and the percentage
 * was buried in a sentence.
 *
 * One row per account now: a mark slot, the name, a track, the number, and the
 * reset or back-at time trailing behind it, truncated rather than wrapped.
 * Every row is the same height, current account included, so the whole popup
 * reads as a column of bars. The fill is coloured by headroom, not by account,
 * which is what makes 43% and 0% comparable down the column.
 *
 * DROVE-230 turned the bars round and gave the track three states instead of
 * one. They used to EMPTY as usage was consumed, and Clay, who specified them,
 * read a verified-correct sheet and asked "Oh so 0% means nothing left?". His
 * call: "They should fill up instead so it's consistent." So the fill grows
 * with usage, and the empty end of the track now has to hold two facts that
 * used to sit at opposite ends. A window MEASURED at zero keeps a sliver of
 * fill on a solid track; a window nobody read draws a hollow, outlined track
 * with no fill at all. The mark slot at the head of the row carries the dot for
 * the window the account's heading was read off, tinted with that row's own
 * tone so it is not mistaken for the heading's current-account dot.
 *
 * DROVE-117 made the columns hold their width. The first cut let the track
 * take whatever the trailing text did not use, so `jamrizzi` with no reset
 * time drew a longer bar than `bitspur.com` at a similar headroom, and `main`
 * with no figure left a hole where the number goes. Bar length then encoded
 * two different things at once and the column stopped being comparable, which
 * was the only reason to draw bars. Now the track is one fixed width for the
 * whole popup, computed from the measured container, the number column always
 * renders (a dash when nothing was measured) and the trailing column always
 * holds its slot whether or not there is a time to put in it.
 *
 * DROVE-148 gave every account the same three rows, so there is one row shape
 * here and no second one for the account list. A block is a heading and its
 * measures; the current account's block is marked with a dot, not built
 * differently.
 *
 * DROVE-160 made the blocks the control as well as the readout. Clay: "So this
 * should let me change the account, flip the account, from here." This is the
 * screen where the choice is made, so it is the screen the move happens from.
 * The heading carries the answer to both questions a tap raises before it is
 * made: "current" on the one in use, "Switch" on every one that can take the
 * session. An account with no login gets neither, because it cannot.
 *
 * DROVE-208 put the way IN at the end of the way out. Clay, looking at five
 * accounts here: "Where is the button for me to add an account." Adding one
 * existed, on Settings -> Accounts only, and this is the screen where he
 * notices one is missing. So the list ends in a row that starts that same
 * flow. A row, not a block: no track, no percent column, a rule above it and
 * a machine named on it, so it cannot be read as a sixth account with an
 * empty bar. Which machine it targets and why it does not ask is argued in
 * sync/machineAccountsFlow.ts.
 */
import * as React from 'react';
import { LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useComposerSheetNavigate } from './composerSheetNavigation';
import { t } from '@/text';
import {
    usageBarColumns,
    usageBarPercentLabel,
    usageBarTrackWidth,
    usageSnapshotAgeText,
    type UsageBarGroup,
    type UsageBarRow,
    type UsageBarTone,
} from './agentInputUsage';

/**
 * Thin enough that eight rows cost less than the three-line block did for two,
 * and now that every account carries three of them (DROVE-148) the budget is
 * five accounts times three rows plus five headings: about 380pt, which the
 * sheet scrolls rather than clips.
 */
const rowHeight = 18;
const trackHeight = 5;
/** The dot marking the current account's block, and the slot it always keeps. */
const activeDot = 5;

/**
 * What the track is drawn at until the container has been measured. A phone
 * width, so the first frame is the right shape rather than a stub that jumps.
 */
export const usageBarFallbackWidth = 345;

function toneColor(tone: UsageBarTone, theme: ReturnType<typeof useUnistyles>['theme']): string {
    switch (tone) {
        case 'critical':
            return theme.colors.warningCritical;
        // The theme's own `warning` is grey, which is the one thing this row
        // must not be: grey is what "never measured" looks like.
        case 'low':
            return theme.dark ? '#FF9F0A' : '#FF9500';
        case 'ample':
            return theme.colors.success;
        default:
            return theme.colors.textSecondary;
    }
}

/**
 * What a row says out loud (DROVE-230).
 *
 * The fill is the only thing on a sighted row that carries the DIRECTION, and
 * a screen reader never sees a fill. So the word goes in: `percentSpoken` is
 * "99% used", not the bare "99%" the column prints, and the binding row says
 * that it is the one the heading quoted.
 */
export function usageRowSpokenLabel(row: UsageBarRow): string {
    return [
        row.fullName,
        row.percentSpoken ?? '',
        row.binding ? bindingSpoken() : '',
        row.trailing,
    ].filter(Boolean).join(', ');
}

function bindingSpoken(): string {
    return t('agentInput.usagePopup.bindingRow');
}

export function UsageAccountBarRow(props: { row: UsageBarRow; trackWidth?: number }) {
    const { theme } = useUnistyles();
    const row = props.row;
    const fill = toneColor(row.tone, theme);
    const trackWidth = props.trackWidth ?? usageBarTrackWidth(usageBarFallbackWidth);
    // A measured ZERO keeps a visible sliver, and an unmeasured row keeps
    // none (DROVE-230). Filling as usage is consumed put the exhausted case at
    // the FULL end of the track, which left the empty end holding two opposite
    // facts: a window nobody read, and a window read as barely touched. One
    // dot of fill apart, and the track itself outlined rather than solid when
    // there is no reading, is what tells them apart before any word is read.
    const fillWidth = row.measured
        ? Math.max(trackHeight, Math.round(row.fraction * trackWidth))
        : 0;
    return (
        <View
            accessible
            accessibilityLabel={usageRowSpokenLabel(row)}
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                height: rowHeight,
                gap: usageBarColumns.gap,
                opacity: row.disabled ? 0.5 : 1,
            }}
        >
            {/* The mark for the row the account heading was read off. Tinted
                with the row's own tone rather than filled white, so it is not
                mistaken for the heading's current-account dot one line up. */}
            <View style={{
                width: usageBarColumns.mark,
                height: usageBarColumns.mark,
                borderRadius: usageBarColumns.mark / 2,
                backgroundColor: row.binding ? fill : 'transparent',
            }} />
            <Text
                numberOfLines={1}
                style={{
                    width: usageBarColumns.name,
                    fontSize: 11,
                    color: theme.colors.text,
                    ...Typography.default(),
                }}
            >
                {row.name}
            </Text>
            {/* The track is always drawn, so a 0% account is still a row you
                can see and count, not a gap in the column. Fixed width, never
                flex: a row with no trailing text must not get a longer bar.
                Solid when there is a reading, hollow when there is not: an
                outlined track is the shape of "nobody looked", and it can no
                longer be confused with a measured window sitting at zero. */}
            <View style={{
                width: trackWidth,
                height: trackHeight,
                borderRadius: trackHeight / 2,
                backgroundColor: row.measured ? theme.colors.divider : 'transparent',
                borderWidth: row.measured ? 0 : StyleSheet.hairlineWidth,
                borderColor: theme.colors.divider,
                overflow: 'hidden',
            }}>
                {row.measured ? (
                    <View style={{
                        width: fillWidth,
                        height: '100%',
                        borderRadius: trackHeight / 2,
                        backgroundColor: fill,
                    }} />
                ) : null}
            </View>
            {/* Always rendered. An unmeasured account shows a dash and keeps
                the column, rather than sliding the row's tail leftward. */}
            <Text
                numberOfLines={1}
                style={{
                    width: usageBarColumns.percent,
                    textAlign: 'right',
                    fontSize: 11,
                    color: row.percentText ? theme.colors.text : theme.colors.textSecondary,
                    ...Typography.default(),
                }}
            >
                {usageBarPercentLabel(row.percentText)}
            </Text>
            {/* Trailing, truncated, and holding its slot even when empty: the
                time is the least of the four facts, it must never push the row
                onto a second line, and it must never lend its width to the
                track of the one row that happens to lack it. */}
            <Text
                numberOfLines={1}
                ellipsizeMode="tail"
                style={{
                    width: usageBarColumns.trailing,
                    fontSize: 10,
                    color: theme.colors.textSecondary,
                    ...Typography.default(),
                }}
            >
                {row.trailing}
            </Text>
        </View>
    );
}

/** The heading and its measures. Wrapped in a Pressable when it can be moved to. */
function UsageAccountBlock(props: {
    group: UsageBarGroup;
    trackWidth: number;
    onSwitch?: (account: string) => void;
}) {
    const { theme } = useUnistyles();
    // The confirm is a system alert, so it cannot come up while the sheet's
    // Modal is still sliding down (DROVE-183, the DROVE-158 mechanism). In the
    // sheet this closes first and asks after; on the session info screen,
    // where the same block is drawn outside any sheet, it asks straight away.
    const leave = useComposerSheetNavigate();
    const group = props.group;
    const account = group.account ?? null;
    const canSwitch = !!(props.onSwitch && group.switchable && account);
    const body = (
        <>
            {/* Every account is headed the same way, so the current one is
                told apart by a dot, a brighter name and the word rather than
                by a different row shape below it. The dot's slot is always
                there, so the names line up down the sheet. */}
            {group.title ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                    <View style={{
                        width: activeDot,
                        height: activeDot,
                        borderRadius: activeDot / 2,
                        backgroundColor: group.active ? theme.colors.text : 'transparent',
                    }} />
                    <Text
                        numberOfLines={1}
                        ellipsizeMode="tail"
                        style={{
                            flexShrink: 1,
                            fontSize: 10,
                            color: group.active ? theme.colors.text : theme.colors.textSecondary,
                            ...Typography.default(),
                        }}
                    >
                        {group.title}
                    </Text>
                    {/* Trailing, so it never pushes the name's truncation
                        around. One word per block and never both: which one
                        you are on, or that this one will take you. */}
                    {group.active || canSwitch ? (
                        <Text
                            numberOfLines={1}
                            style={{
                                marginLeft: 'auto',
                                paddingLeft: 6,
                                fontSize: 10,
                                color: group.active ? theme.colors.textSecondary : theme.colors.textLink,
                                ...Typography.default(),
                            }}
                        >
                            {group.active ? 'current' : 'Switch ›'}
                        </Text>
                    ) : null}
                </View>
            ) : null}
            {group.rows.map((row) => (
                <UsageAccountBarRow key={row.key} row={row} trackWidth={props.trackWidth} />
            ))}
        </>
    );
    if (!canSwitch) {
        return body;
    }
    // One focusable element, not four. The rows below are each accessible in
    // their own right, and a screen reader stepping through three bars with no
    // way to press the block around them is the version of this that cannot be
    // used, so the block takes the focus and carries what the rows said.
    const label = [
        `Switch to ${account}`,
        group.title,
        ...group.rows.map(usageRowSpokenLabel),
    ].filter(Boolean).join('. ');
    return (
        <Pressable
            accessible
            accessibilityRole="button"
            accessibilityLabel={label}
            onPress={() => leave(() => props.onSwitch?.(account!))}
            style={({ pressed }: { pressed: boolean }) => ({ opacity: pressed ? 0.5 : 1 })}
        >
            {body}
        </Pressable>
    );
}

/**
 * The end of the list: add an account, on the machine this session runs on
 * (DROVE-208).
 *
 * Deliberately unlike a block. The bars are a comparison and this is not a
 * thing to compare, so it gets a rule above it, no track, no number column and
 * a green glyph the account headings do not have. The machine is on the row
 * rather than in the flow it starts, because a login lands somewhere and the
 * one thing worth saying before the tap is where.
 *
 * It navigates, so it goes through the sheet's exit: close, wait for the Modal
 * to be off the screen, then push (DROVE-183). Outside a sheet the same hook
 * just runs it.
 */
function UsageAddAccountRow(props: { machineName: string; onPress: () => void }) {
    const { theme } = useUnistyles();
    const leave = useComposerSheetNavigate();
    return (
        <Pressable
            accessible
            accessibilityRole="button"
            accessibilityLabel={`Add a Claude account on ${props.machineName}. `
                + 'Other machines in Settings, Accounts.'}
            onPress={() => leave(props.onPress)}
            style={({ pressed }: { pressed: boolean }) => ({
                marginTop: 10,
                paddingTop: 8,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: theme.colors.divider,
                opacity: pressed ? 0.5 : 1,
            })}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Ionicons name="add-circle-outline" size={13} color={theme.colors.success} />
                <Text
                    numberOfLines={1}
                    style={{
                        fontSize: 11,
                        color: theme.colors.textLink,
                        ...Typography.default(),
                    }}
                >
                    Add an account
                </Text>
                {/* Trailing, like the "Switch" word above it, so a long
                    machine name truncates instead of wrapping the row. */}
                <Text
                    numberOfLines={1}
                    ellipsizeMode="tail"
                    style={{
                        marginLeft: 'auto',
                        paddingLeft: 6,
                        flexShrink: 1,
                        fontSize: 10,
                        color: theme.colors.textSecondary,
                        ...Typography.default(),
                    }}
                >
                    {`on ${props.machineName} ›`}
                </Text>
            </View>
            {/* The answer to "and if I meant the other Mac". A quota sheet is
                one session on one machine, so the picker lives where every
                machine already does rather than being grown in here. */}
            <Text
                numberOfLines={1}
                ellipsizeMode="tail"
                style={{
                    marginTop: 1,
                    marginLeft: 18,
                    fontSize: 10,
                    color: theme.colors.textSecondary,
                    ...Typography.default(),
                }}
            >
                Other machines in Settings → Accounts
            </Text>
        </Pressable>
    );
}

export function UsageAccountBars(props: {
    groups: UsageBarGroup[];
    width?: number;
    /**
     * "Read 3m ago · Times in CDT · Fable week not counted for Opus"
     * (DROVE-230). One caption under every block, because every fact on it
     * applies to all of them and none fits in an 88pt trailing column.
     *
     * Nothing here is needed to READ a bar any more. The line used to open
     * with `Bars show left`, which is where the sheet's only statement of its
     * own direction lived, and a rule in small print at the bottom of a scroll
     * is a rule nobody has read. The mark carries the direction now and the
     * caption carries only what a mark cannot.
     */
    footer?: string;
    /**
     * When the snapshot was taken (DROVE-230), so the caption can say how old
     * the reading is.
     *
     * The age is worded HERE rather than upstream because it is the one fact
     * on the caption that changes while nothing else does. `resolveUsageStrip`
     * runs in a memo keyed on the snapshot, so a string built there would
     * still read "Read just now" an hour after the sweep stopped, which is a
     * lie on the exact axis Clay stopped trusting these numbers over. This
     * component holds a minute clock instead, and it only ticks while the
     * caption is on screen.
     */
    capturedAt?: number | null;
    /** Tapping a block moves the session onto that account (DROVE-160). */
    onSwitchAccount?: (account: string) => void;
    /**
     * The add row that ends the list (DROVE-208). Absent where there is no
     * session behind the bars, so the session info screen, which draws one
     * account and has no machine to name, stays a readout.
     */
    addAccount?: { machineName: string; onPress: () => void } | null;
}) {
    const { theme } = useUnistyles();
    const [measured, setMeasured] = React.useState<number | null>(null);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const width = event.nativeEvent.layout.width;
        setMeasured((current) => (current === width ? current : width));
    }, []);
    const trackWidth = usageBarTrackWidth(props.width ?? measured ?? usageBarFallbackWidth);
    // A minute is the resolution the wording has, so a minute is how often it
    // is worth waking for. Only while there is a stamp to age.
    const capturedAt = props.capturedAt ?? null;
    const [now, setNow] = React.useState(() => Date.now());
    React.useEffect(() => {
        if (capturedAt == null) return;
        setNow(Date.now());
        const id = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(id);
    }, [capturedAt]);
    const caption = [
        capturedAt == null ? '' : usageSnapshotAgeText(capturedAt, now),
        props.footer ?? '',
    ].filter(Boolean).join(' \u00b7 ');
    return (
        <View
            onLayout={props.width == null ? onLayout : undefined}
            style={{
                paddingHorizontal: usageBarColumns.horizontalPadding,
                paddingTop: 4,
                paddingBottom: 2,
            }}
        >
            {props.groups.map((group, index) => (
                <View key={group.key} style={{ marginTop: index > 0 ? 8 : 2 }}>
                    <UsageAccountBlock
                        group={group}
                        trackWidth={trackWidth}
                        onSwitch={props.onSwitchAccount}
                    />
                </View>
            ))}
            {caption ? (
                <Text
                    numberOfLines={1}
                    style={{
                        marginTop: 8,
                        fontSize: 10,
                        color: theme.colors.textSecondary,
                        ...Typography.default(),
                    }}
                >
                    {caption}
                </Text>
            ) : null}
            {/* After the caption, because the caption explains the NUMBERS and
                belongs with them. Last in the sheet, which is where the end of
                the list is and where the thumb already is. */}
            {props.addAccount ? (
                <UsageAddAccountRow
                    machineName={props.addAccount.machineName}
                    onPress={props.addAccount.onPress}
                />
            ) : null}
        </View>
    );
}
