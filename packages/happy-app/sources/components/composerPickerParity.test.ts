/**
 * ONE PICKER SHEET, MOUNTED BY BOTH SCREENS (DROVE-394).
 *
 * Clay, on the new-session sheet's harness menu: "for the millionth time this
 * input box needs to match all the other input boxes; that should actually be
 * a sheet that comes up."
 *
 * The session composer's capsule opened a list drawn inline in `AgentInput`;
 * Home opened an iOS context menu for the harness and a glass card of its own
 * for the rest. This is a source scan for the reason `composerParity.test.ts`
 * is one: the failure is a screen quietly drawing its own copy of a shared
 * thing, which no render of either screen in isolation can see.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sources = join(__dirname, '..');
const read = (relative: string) => readFileSync(join(sources, relative), 'utf8');

const screens = {
    'the session screen': 'components/AgentInput.tsx',
    'the home screen': 'components/HomeDock.tsx',
} as const;

describe('both screens open the one picker sheet (DROVE-394)', () => {
    it('mounts `ComposerPickerSheet` on each', () => {
        for (const [screen, file] of Object.entries(screens)) {
            expect(read(file), screen).toContain('<ComposerPickerSheet');
        }
    });

    it('draws no picker row on either screen', () => {
        // A radio row is the picker's shape, and the picker draws it.
        for (const [screen, file] of Object.entries(screens)) {
            expect(read(file), screen).not.toContain('accessibilityRole="radio"');
        }
        expect(read('components/ComposerPickerSheet.tsx')).toContain('accessibilityRole="radio"');
    });

    it('opens no native menu on Home, for any of its seven pickers', () => {
        const home = read('components/HomeDock.tsx');
        expect(home).not.toContain('NativeOptionsPicker');
        expect(home).not.toContain('NativeSettingsMenu');
        expect(home).not.toContain('renderSettingsSheet');
        expect(home).not.toContain('<ScrollView');
        // Every row on the sheet opens the picker the same way.
        expect(home).toContain('onPress={() => setSheetPage(row.page as PickerPage)}');
    });

    it('refuses a harness this computer cannot run rather than dropping the pick', () => {
        const home = read('components/HomeDock.tsx');
        expect(home).toContain('resolveHarnessPick(availableAgents, key)');
        expect(home).not.toContain('onSelect: (key) => selectAgent(key as NewSessionAgentType)');
    });

    it('keeps the sheet’s shell in the one file', () => {
        const picker = read('components/ComposerPickerSheet.tsx');
        expect(picker).toContain('<ComposerSheet');
        // A disabled row is drawn with its reason and takes no press: the
        // whole of the harness bug, held on the row.
        expect(picker).toContain('disabled={disabled}');
        expect(picker).toContain('accessibilityHint={option.description ?? undefined}');
    });
});
