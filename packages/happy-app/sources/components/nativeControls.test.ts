import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    bannedHostMode,
    contextMenuVerdict,
    controlClasses,
    glassViewPrimitives,
    rawGlassViewExemptions,
    swiftUiHostSites,
    swiftUiImporters,
} from './nativeControls';

/**
 * The guard for the policy in `nativeControls.ts` (DROVE-134).
 *
 * Built on `glassChromeScreens.test.ts`'s shape rather than a second
 * mechanism: every list here fails BOTH ways, on a file that breaks a rule and
 * is not listed, and on a listed file that no longer does the thing the entry
 * excuses. A reason that outlives its code is how a policy becomes decoration.
 */

const sourcesRoot = resolve(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            walk(full, out);
        } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
            out.push(full);
        }
    }
    return out;
}

/**
 * Only `.ts` and `.tsx` above, which is what let a parked `.tsx.native` copy
 * sit beside a live file without Metro, tsc, or any scan here seeing it. There
 * is none left: DROVE-154 shipped the one that existed and deleted it.
 *
 * The policy module and this file are excluded: both quote the markers being
 * scanned for, and a rule that fails on its own statement of itself is not a
 * rule.
 */
const policyFiles = ['components/nativeControls.ts', 'components/nativeControls.test.ts'];
const files = walk(sourcesRoot)
    .filter((file) => !policyFiles.includes(relative(sourcesRoot, file)));

/** A marker counts where it is CODE. Half these files explain the rules. */
function codeLines(source: string): string[] {
    return source.split('\n').filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('*')
            && !trimmed.startsWith('//')
            && !trimmed.startsWith('/*');
    });
}

function draws(file: string, needle: string): boolean {
    return codeLines(readFileSync(file, 'utf8')).some((line) => line.includes(needle));
}

function sourcesMatching(needle: string): string[] {
    return files
        .filter((file) => draws(file, needle))
        .map((file) => relative(sourcesRoot, file))
        .sort();
}

describe('Rule 2: the material comes from one place', () => {
    it('constructs GlassView only in the primitives, or where a reason is written down', () => {
        // A second glass implementation beside the primitives is what drew a
        // visibly different surface next to its neighbours in the header, which
        // was half of Clay's original complaint. Everything else goes through
        // GlassChromeSurface / GlassChromeButton or MobileGlassSurface.
        const allowed = [
            ...glassViewPrimitives,
            ...rawGlassViewExemptions.map((exemption) => exemption.source),
        ].sort();
        expect(sourcesMatching('<GlassView')).toEqual(allowed);
    });

    it('keeps no exemption alive for a file that stopped constructing one', () => {
        const offenders = sourcesMatching('<GlassView');
        for (const exemption of rawGlassViewExemptions) {
            expect(offenders, exemption.source).toContain(exemption.source);
            expect(exemption.reason.length).toBeGreaterThan(20);
        }
    });

    it('has no SwiftUI-button glass control left in the tree', () => {
        // NativeGlassIconButton was the wrong door: a SwiftUI Button renders
        // SwiftUI children only, so it could never hold the title pill or the
        // avatar, and it drew a second material next to the primitives. It is
        // deleted rather than kept as a monument, because dead code with a long
        // comment is what gets reused. The record is Rule 2.
        expect(sourcesMatching("buttonStyle('glass')")).toEqual([]);
        expect(files.map((file) => basename(file))).not.toContain('NativeGlassIconButton.tsx');
    });
});

describe('Rule 3: a Host cannot see React Native children', () => {
    const hosting = sourcesMatching('<Host');

    it('lists every file that mounts a Host', () => {
        expect(hosting).toEqual(swiftUiHostSites.map((site) => site.source).sort());
    });

    it('keeps no entry for a file that stopped mounting one', () => {
        for (const site of swiftUiHostSites) {
            expect(hosting, site.source).toContain(site.source);
        }
    });

    it('makes the bare mode say why it is still here', () => {
        for (const site of swiftUiHostSites) {
            if (site.mode !== bannedHostMode) continue;
            expect(site.reason, site.source).toBeTruthy();
        }
    });

    it('lets nothing import a file that mounts a bare Host', () => {
        // The self-clearing half. A bare Host is tolerable only while it is
        // unreachable; wiring one up is what shipped clipped messages, so
        // wiring one up fails here first. The component's own platform family
        // is excluded, since the dispatcher naming them is the point of them.
        for (const site of swiftUiHostSites) {
            if (site.mode !== bannedHostMode) continue;
            const family = basename(site.source).replace(/\.(ios|android|web)\.tsx?$/, '');
            const importers = files
                .filter((file) => !basename(file).startsWith(family))
                .filter((file) => draws(file, family))
                .map((file) => relative(sourcesRoot, file));
            expect(importers, site.source).toEqual([]);
        }
    });

    it('never matches a Host horizontally', () => {
        // `matchContents` with no per-axis object matches BOTH axes. Horizontal
        // pins the host's style width from content whose width comes down from
        // that same node, and the loop collapses to zero. Only `overlay` and
        // `fixed` sites may carry a bare `matchContents`, because neither of
        // them reads the measurement back.
        for (const site of swiftUiHostSites) {
            if (site.mode !== 'measured') continue;
            const source = readFileSync(join(sourcesRoot, site.source), 'utf8');
            expect(source, site.source).toContain('vertical: true');
        }
    });

    it('wraps the children of a measured Host in RNHostView', () => {
        // RNHostView is the only component in @expo/ui that KVOs the RN child's
        // bounds back into a SwiftUI frame, and the only one that attaches a
        // touch handler. Without it a measured Host is a bare one.
        for (const site of swiftUiHostSites) {
            if (site.mode !== 'measured') continue;
            expect(draws(join(sourcesRoot, site.source), 'RNHostView'), site.source).toBe(true);
        }
    });
});

describe('Rules 1 and 2: @expo/ui is for menus', () => {
    const importers = sourcesMatching("from '@expo/ui/swift-ui'");

    it('lists every file reaching for SwiftUI', () => {
        expect(importers).toEqual(swiftUiImporters.map((importer) => importer.source).sort());
    });

    it('keeps no entry for a file that stopped reaching for it', () => {
        for (const importer of swiftUiImporters) {
            expect(importers, importer.source).toContain(importer.source);
        }
    });

    it('keeps a native menu row a label and nothing else', () => {
        // DROVE-107's wall, and the reason the account quota is a custom sheet.
        // A native menu row holds a sentence and an SF Symbol; widening this to
        // a ReactNode does not make the platform draw it, it makes the row
        // blank.
        const source = readFileSync(join(sourcesRoot, 'components/NativeSettingsMenu.tsx'), 'utf8');
        const optionType = source.slice(
            source.indexOf('export type NativeSettingsMenuOption'),
        );
        const body = optionType.slice(0, optionType.indexOf('};') + 2);
        expect(body).toContain('label: string;');
        expect(body).not.toContain('ReactNode');
        expect(body).not.toContain('React.ReactElement');
    });
});

describe('Rule 7: every platform file has a sibling', () => {
    const platformImpls = files
        .map((file) => relative(sourcesRoot, file))
        .filter((file) => /\.(ios|android)\.tsx?$/.test(file));
    const stems = [...new Set(platformImpls.map((impl) => impl.replace(/\.(ios|android)\.tsx?$/, '')))];

    it('has one, because tsc and vitest see only the sibling', () => {
        // Metro resolves the platform file on its own. An orphan .ios.tsx is
        // code the type checker and the test runner cannot reach.
        for (const impl of platformImpls) {
            const sibling = join(sourcesRoot, `${impl.replace(/\.(ios|android)\.tsx?$/, '')}.tsx`);
            expect(() => statSync(sibling), impl).not.toThrow();
        }
    });

    it('makes the sibling either a dispatcher or the default implementation', () => {
        // Both shapes are house style and the test does not prefer one. What it
        // refuses is a sibling that is neither: a types-only file, or a stub,
        // which leaves every non-iOS platform rendering nothing.
        for (const stem of stems) {
            const name = basename(stem);
            const source = readFileSync(join(sourcesRoot, `${stem}.tsx`), 'utf8');
            const dispatcher = source.includes('Platform.select') && source.includes('default:');
            const implementation = new RegExp(
                `export (function|const) ${name}\\b|export \\{[^}]*\\b${name}\\b`,
            ).test(source);
            expect(dispatcher || implementation, `${stem}.tsx`).toBe(true);
        }
    });
});

describe('the inventory stays answerable', () => {
    it('names a file that exists for every class of control', () => {
        for (const control of controlClasses) {
            expect(() => statSync(join(sourcesRoot, control.source)), control.name).not.toThrow();
        }
    });

    it('says what every class would gain or lose by moving', () => {
        // The ticket asked for this and it is the half that rots first. A class
        // with no verdict is one nobody decided about.
        for (const control of controlClasses) {
            expect(control.verdict, control.name).toBeTruthy();
            expect(control.verdict!.length, control.name).toBeGreaterThan(20);
        }
    });

    it('records that RN primitives already are the platform controls', () => {
        // Rule 0, asserted so a later sweep cannot quietly decide UISwitch needs
        // replacing with a SwiftUI Toggle.
        const native = controlClasses.filter((control) => control.drawnBy === 'rn-platform');
        expect(native.map((control) => control.name)).toEqual([
            'switches',
            'text fields',
            'alerts and confirmations',
            'sliders',
        ]);
    });

    it('has shipped the context menu and kept no parked copy beside it', () => {
        // The other half of the assertion that used to hold the parked file
        // alive. It said "if a later lane ships it, this flips with the file",
        // and DROVE-154 is that lane: the verdict is `shipped`, the `.native`
        // copy is deleted, and the live file is the one `measured` host site.
        // A second copy reappearing beside a shipping file is the failure this
        // now guards, because that is how two iOS implementations drift apart.
        expect(contextMenuVerdict).toBe('shipped');
        expect(() => statSync(join(__dirname, 'LongPressCopyable.ios.tsx.native'))).toThrow();
        const site = swiftUiHostSites.find((entry) => entry.source === 'components/LongPressCopyable.ios.tsx');
        expect(site?.mode).toBe('measured');
    });
});
