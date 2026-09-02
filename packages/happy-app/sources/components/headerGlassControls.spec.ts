import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { headerGlassControls, resolveHeaderPress } from './headerGlassControls';

const sourcesRoot = resolve(__dirname, '..');

function read(source: string): string {
    return readFileSync(join(sourcesRoot, source), 'utf8');
}

/** A line that is prose is not a line that draws. */
function drawn(source: string): string[] {
    return source.split('\n').filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    });
}

function count(source: string, needle: string): number {
    return drawn(source).filter((line) => line.includes(needle)).length;
}

/**
 * The body of one entry in a unistyles stylesheet, so a claim about a
 * control's own style is not a claim about every style in the file.
 */
function styleBlock(source: string, key: string): string {
    const start = source.indexOf(`\n    ${key}: {`);
    expect(start, `no style named ${key}`).toBeGreaterThan(-1);
    const end = source.indexOf('\n    },', start);
    expect(end, `style ${key} is not closed at the stylesheet's indent`).toBeGreaterThan(start);
    return source.slice(start, end);
}

describe('the table itself', () => {
    it('names a file that exists for every mount and every declaration', () => {
        for (const control of headerGlassControls) {
            expect(() => statSync(join(sourcesRoot, control.source)), control.name).not.toThrow();
            if (control.declaredIn) {
                expect(() => statSync(join(sourcesRoot, control.declaredIn!)), control.name).not.toThrow();
            }
        }
    });

    it('makes a control that stays still say why', () => {
        // The two inert ones are the point of the table, not an omission in
        // it. Clay circled both, so "it is not a button" has to be written
        // down where the next person reads it.
        for (const control of headerGlassControls) {
            if (control.tappable) continue;
            expect(control.reason, control.name).toBeTruthy();
        }
        expect(headerGlassControls.filter((control) => !control.tappable).map((control) => control.name))
            .toEqual([
                'sessions header drover mark',
                'tool message header title pill',
                'tool message header status disc',
            ]);
    });

    it('counts a press only where there is something to press', () => {
        for (const control of headerGlassControls) {
            if (control.tappable) {
                expect(control.presses, control.name).toBeGreaterThanOrEqual(1);
            } else {
                expect(control.presses, control.name).toBe(0);
            }
        }
    });

    it('mounts every control on a shared surface, never a local copy of the material', () => {
        for (const control of headerGlassControls) {
            const source = read(control.source);
            expect(count(source, `<${control.surface}`), control.name).toBeGreaterThanOrEqual(1);
            expect(source, control.name).toMatch(/from '\.{1,2}\/GlassChromeControl'/);
        }
    });
});

describe('one press, one control', () => {
    // Every control mounts its OWN surface, so the effect view a touch lands
    // in is one control's and its neighbours never move. The filter and the
    // gear are the exception that proves it: they SHARE a surface, which is
    // why they are one row here with two presses rather than two rows.
    it.each(headerGlassControls.map((control) => [control.name, control] as const))(
        'pressing %s leaves every other control calm',
        (_name, control) => {
            const outcome = resolveHeaderPress(control.name);
            expect(outcome.swells).toEqual(control.tappable ? [control.name] : []);
            expect(outcome.calm).toHaveLength(headerGlassControls.length - 1);
            expect(outcome.calm).not.toContain(control.name);
        },
    );

    it('refuses a name it does not carry rather than reporting a calm header', () => {
        expect(() => resolveHeaderPress('the button nobody built')).toThrow(/no header glass control/);
    });

    it('keeps the two-action pill on one surface', () => {
        // DROVE-169 and DROVE-343: one interactive surface for a grouped
        // control, the segment under the finger answering. The seam is drawn,
        // not built out of two capsules.
        const pill = headerGlassControls.find((control) => control.name === 'sessions header filter and gear pill');
        expect(pill?.presses).toBe(2);
        const mainView = read('components/MainView.tsx');
        expect(count(mainView, 'GlassChromeSurface')).toBe(0);
        expect(count(mainView, 'styles.headerActionDivider')).toBe(1);
    });
});

describe('the shared header lets the screen say which slots are buttons', () => {
    const header = read('components/navigation/Header.tsx');

    it('asks about all three slots rather than deciding for every screen', () => {
        expect(count(header, '<GlassChromeSurface')).toBe(3);
        expect(count(header, 'interactive={headerLeftInteractive}')).toBe(1);
        expect(count(header, 'interactive={mobileTitleInteractive}')).toBe(1);
        expect(count(header, 'interactive={headerRightInteractive}')).toBe(1);
    });

    it('answers no until a screen says otherwise', () => {
        expect(header).toContain('headerLeftInteractive = false');
        expect(header).toContain('headerRightInteractive = false');
        expect(header).toContain('mobileTitleInteractive = false');
    });

    it('leaves the clip to the primitive on all three slot styles', () => {
        // DROVE-202 and DROVE-328: an interactive surface has to be free to
        // swell past its resting frame, and a style that puts the clip back
        // turns the swell into an inner zoom.
        for (const key of ['leftControlGlass', 'rightControlGlass', 'mobileTitlePill']) {
            expect(styleBlock(header, key), key).not.toContain('overflow');
        }
    });
});

describe('the sessions header', () => {
    const mainView = read('components/MainView.tsx');

    it('gives the trailing pill the platform press', () => {
        expect(count(mainView, 'headerRightInteractive')).toBe(1);
    });

    it('leaves the drover mark still, because it opens nothing', () => {
        expect(count(mainView, 'headerLeftInteractive')).toBe(0);
        expect(count(read('components/HeaderLogo.tsx'), 'Pressable')).toBe(0);
    });
});

describe('the per-project new-session +', () => {
    const projectGroup = read('components/ProjectGroup.tsx');

    it('is the same glass button the composer + is', () => {
        expect(count(projectGroup, '<GlassChromeButton')).toBe(1);
        expect(count(projectGroup, 'tintColor={theme.colors.surfaceHighest}')).toBe(1);
        // A list row is not floating chrome, and the flat fallback never drew
        // a hairline.
        expect(count(projectGroup, 'rim={false}')).toBe(1);
    });

    it('has no hand-rolled press left', () => {
        // The filled View inside a Pressable that faded to 0.5 is the response
        // DROVE-169 spent three springs removing.
        expect(count(projectGroup, 'addButtonPressed')).toBe(0);
        expect(count(projectGroup, 'opacity: 0.5')).toBe(0);
    });

    it('keeps the touch target it had', () => {
        expect(count(projectGroup, 'hitSlop={12}')).toBe(1);
    });
});

describe('the session header, which was already right', () => {
    const chatHeader = read('components/ChatHeaderView.tsx');

    it('presses its title pill and its avatar', () => {
        expect(count(chatHeader, '<GlassChromeSurface')).toBe(2);
        expect(count(chatHeader, 'interactive={!!onTitlePress}')).toBe(1);
        expect(count(chatHeader, 'interactive')).toBeGreaterThanOrEqual(2);
    });
});

describe('the tool message header, which stays still', () => {
    it('never asks for a press it cannot act on', () => {
        // Both slots hold readouts: a ToolHeader and a ToolStatusIndicator.
        // This is the header in Clay's second photograph, and leaving it inert
        // is the decision, not the oversight.
        const screen = read('app/(app)/session/[id]/message/[messageId].tsx');
        expect(count(screen, 'headerRightInteractive')).toBe(0);
        expect(count(screen, 'Pressable')).toBe(0);
        expect(count(read('components/tools/ToolHeader.tsx'), 'Pressable')).toBe(0);
        expect(count(read('components/tools/ToolStatusIndicator.tsx'), 'Pressable')).toBe(0);
    });
});
