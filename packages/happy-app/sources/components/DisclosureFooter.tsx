/**
 * The React half of DROVE-150: every inline disclosure in the transcript wears
 * the same collapse row at its END, so a block you have just read closes from
 * where you finished rather than from a header several screens back.
 *
 * Rules live in `inlineDisclosure.ts`. This file draws the row and carries the
 * transcript's scroll-anchor callback down to disclosures nested too deep to
 * thread a prop through.
 */
import * as React from 'react';
import { Pressable, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import { edgeClearance, tapSlopFor } from './scrollIndicatorInset';
import {
    collapseFromFooter,
    type DisclosureAnchor,
    disclosureState,
    type DisclosureState,
    toggleDisclosure,
} from './inlineDisclosure';

export type ViewAnchor = DisclosureAnchor<View>;

type PreserveAnchor = (anchor: ViewAnchor) => void;

const DisclosureAnchorContext = React.createContext<PreserveAnchor | null>(null);

export function DisclosureAnchorProvider(props: {
    value: PreserveAnchor | null;
    children: React.ReactNode;
}) {
    return (
        <DisclosureAnchorContext.Provider value={props.value}>
            {props.children}
        </DisclosureAnchorContext.Provider>
    );
}

export function useDisclosureAnchor(): PreserveAnchor | null {
    return React.useContext(DisclosureAnchorContext);
}

function measureY(node: View | null, done: (y: number | null) => void) {
    if (!node) {
        done(null);
        return;
    }
    node.measureInWindow((_x, y) => {
        done(Number.isFinite(y) ? y : null);
    });
}

/**
 * State for one disclosure: what the header toggles, what the footer closes,
 * and the refs both rows need so the list can be put back afterwards.
 */
export function useInlineDisclosure(initiallyExpanded = false) {
    const preserveAnchor = useDisclosureAnchor();
    const [state, setState] = React.useState<DisclosureState<View>>(
        () => disclosureState<View>(initiallyExpanded),
    );
    const headerRef = React.useRef<View>(null);
    const footerRef = React.useRef<View>(null);
    const appliedAnchorRef = React.useRef<unknown>(null);

    // After the collapse has actually laid out, not before, or the header is
    // measured at the position it is about to leave. Once each: an anchor is
    // a one-shot request, and re-running it would drag the transcript again.
    React.useLayoutEffect(() => {
        const anchor = state.anchor;
        if (!anchor || appliedAnchorRef.current === anchor) return;
        appliedAnchorRef.current = anchor;
        preserveAnchor?.(anchor);
    }, [state.anchor, preserveAnchor]);

    const toggle = React.useCallback(() => {
        setState((current) => toggleDisclosure(current));
    }, []);

    const expand = React.useCallback(() => {
        setState((current) => (current.expanded ? current : { expanded: true, anchor: null }));
    }, []);

    const collapse = React.useCallback(() => {
        measureY(footerRef.current, (footerY) => {
            measureY(headerRef.current, (headerY) => {
                setState((current) => collapseFromFooter(current, headerRef.current, headerY, footerY));
            });
        });
    }, []);

    return { expanded: state.expanded, toggle, expand, collapse, headerRef, footerRef };
}

interface DisclosureFooterProps {
    /** The header's own words, so the row reads as the same control. */
    label: string;
    onPress: () => void;
    innerRef?: React.RefObject<View | null>;
    iconSize?: number;
    /** The header's text style, for the same reason as the label. */
    textStyle?: StyleProp<TextStyle>;
    style?: StyleProp<ViewStyle>;
}

/** Text at ~20pt plus the padding below. Named so the hit slop follows it. */
const footerRowHeight = 32;

/**
 * The collapse row. Chevron points up because that is the direction the block
 * is about to go, and the tap target spans the row rather than the glyph.
 */
export const DisclosureFooter = React.memo<DisclosureFooterProps>(({
    label,
    onPress,
    innerRef,
    iconSize = 13,
    textStyle,
    style,
}) => {
    const { theme } = useUnistyles();
    return (
        <Pressable
            ref={innerRef}
            collapsable={false}
            accessibilityRole="button"
            accessibilityLabel={label}
            onPress={onPress}
            hitSlop={tapSlopFor(footerRowHeight)}
            style={({ pressed }) => [styles.footer, style, pressed && styles.footerPressed]}
        >
            <Text style={[styles.footerLabel, textStyle]} numberOfLines={1}>{label}</Text>
            <Ionicons name="chevron-up" size={iconSize} color={theme.colors.textSecondary} />
        </Pressable>
    );
});

const styles = StyleSheet.create((theme) => ({
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        // Stretched, so the whole width closes the block and not just the glyph.
        alignSelf: 'stretch',
        gap: 4,
        paddingVertical: 6,
        marginTop: 2,
        // Same lane the headers keep clear of the scroll indicator (DROVE-156).
        paddingRight: edgeClearance(),
    },
    footerPressed: {
        opacity: 0.6,
    },
    footerLabel: {
        flexShrink: 1,
        // Casing and size come from the header's own text style, so the two
        // rows read as one control.
        color: theme.colors.textSecondary,
    },
}));
