import * as React from 'react';
import { Text } from 'react-native';
import type { Role, Span } from './highlight';

export type SyntaxPalette = Record<Role, string>;

interface SyntaxSpansProps {
    spans: Span[];
    palette: SyntaxPalette;
    selectable?: boolean;
}

/**
 * The coloured children of a monospace block (DROVE-159).
 *
 * Deliberately not a block of its own: it returns children for whatever <Text>
 * the caller already had, so the font, the size and above all the wrapping stay
 * exactly what DROVE-149 set. A nested <Text> inherits layout from its parent,
 * so colouring cannot change where a line breaks.
 *
 * Only colour varies between roles. No weight, no size, no style: a metrics
 * change reflows the block, a reflow moves the viewport, and a moved viewport
 * is what DROVE-125 spent a ticket getting rid of.
 *
 * One span that is entirely plain renders as a bare string, so an undetected
 * block produces the same tree it did before this existed.
 */
export const SyntaxSpans = React.memo<SyntaxSpansProps>(({ spans, palette, selectable }) => {
    if (spans.length === 0) return null;
    if (spans.length === 1 && spans[0].role === 'plain') {
        return <>{spans[0].text}</>;
    }
    return (
        <>
            {spans.map((span, index) => (
                <Text key={index} selectable={selectable} style={{ color: palette[span.role] }}>
                    {span.text}
                </Text>
            ))}
        </>
    );
});

SyntaxSpans.displayName = 'SyntaxSpans';
