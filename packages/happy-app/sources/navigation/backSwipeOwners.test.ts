import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { backSwipeLockSites, backSwipeOwners } from './backSwipeOwners';

/**
 * The guard for the inventory in `backSwipeOwners.ts` (DROVE-216).
 *
 * Built on `nativeControls.test.ts`'s shape: every list fails BOTH ways, on a
 * file that owns a horizontal drag and is not listed, and on a listed file that
 * no longer does the thing its entry describes. A reason that outlives its code
 * is how a policy becomes decoration.
 */

const sourcesRoot = resolve(__dirname, '..');

/** The mechanism itself, which owns no drag and quotes the markers in prose. */
const mechanism = new Set([
    'navigation/backSwipeLock.ts',
    'navigation/backSwipeOwners.ts',
    'hooks/useBackSwipeLock.ts',
]);

/**
 * What counts as owning a horizontal drag. Each is the real construct, not a
 * mention: a JSX `horizontal` prop, an import of the native slider or of
 * RNGH's Swipeable, a pan gesture, or a raw responder that reads moves.
 */
const markers: { name: string; pattern: RegExp }[] = [
    { name: 'horizontal scroll', pattern: /^\s*horizontal(\s*$|\s+[a-zA-Z{\/]|={true})|<(?:Animated\.)?(?:ScrollView|FlatList)\s+horizontal/m },
    { name: 'native slider', pattern: /^import .*from '@react-native-community\/slider'/m },
    { name: 'pan gesture', pattern: /Gesture\.Pan\(/ },
    { name: 'raw responder', pattern: /onResponderMove/ },
    { name: 'swipeable row', pattern: /^import .*\bSwipeable\b/m },
];

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

function appFiles(): { path: string; body: string }[] {
    return walk(sourcesRoot)
        .map((full) => ({ path: relative(sourcesRoot, full).split('\\').join('/'), body: readFileSync(full, 'utf8') }))
        .filter(({ path }) => !/\.(test|spec)\.tsx?$/.test(path))
        .filter(({ path }) => !mechanism.has(path));
}

function drivers(): string[] {
    return appFiles()
        .filter(({ body }) => markers.some((marker) => marker.pattern.test(body)))
        .map(({ path }) => path)
        .sort();
}

function read(path: string): string {
    return readFileSync(join(sourcesRoot, path), 'utf8');
}

describe('back swipe owners', () => {
    test('every horizontal drag in the app is on the list', () => {
        const listed = new Set(backSwipeOwners.map((owner) => owner.source));
        const missing = drivers().filter((path) => !listed.has(path));

        expect(missing).toEqual([]);
    });

    test('every entry still owns a horizontal drag', () => {
        const found = new Set(drivers());
        const stale = backSwipeOwners.map((owner) => owner.source).filter((path) => !found.has(path));

        expect(stale).toEqual([]);
    });

    test('the list has no duplicates', () => {
        const sources = backSwipeOwners.map((owner) => owner.source);

        expect(sources).toEqual([...new Set(sources)]);
    });

    test('every entry carries a reason worth reading', () => {
        for (const owner of backSwipeOwners) {
            expect(owner.reason.length, owner.source).toBeGreaterThan(40);
            expect(owner.control.length, owner.source).toBeGreaterThan(8);
        }
    });

    test('a control that takes the lock really calls the hook', () => {
        for (const owner of backSwipeOwners) {
            if (!owner.lockedIn) continue;
            expect(read(owner.lockedIn), owner.source).toContain('useBackSwipeLock');
        }
    });

    test('a control left alone does not quietly hold the lock', () => {
        for (const owner of backSwipeOwners) {
            if (owner.lockedIn) continue;
            expect(read(owner.source), owner.source).not.toContain('useBackSwipeLock');
        }
    });

    test('nothing calls the hook without an entry saying why', () => {
        const sites = new Set(backSwipeLockSites());
        const callers = appFiles()
            .filter(({ body }) => /useBackSwipeLock/.test(body))
            .map(({ path }) => path)
            .filter((path) => !sites.has(path))
            .sort();

        expect(callers).toEqual([]);
    });

    test('the slider Clay hit is gone, and so is its entry (DROVE-242)', () => {
        // It was the composer's effort drag, a raw JS responder reading pageX,
        // and it is deleted rather than locked: effort is a press that opens a
        // sheet now, and a press has no pan for the navigator to steal. The
        // rest of the inventory stands, which is the point of keeping a list
        // instead of patching the one control that got reported.
        expect(backSwipeOwners.find((owner) => owner.source === 'components/ComposerSessionControls.tsx'))
            .toBeUndefined();
        expect(backSwipeOwners.length).toBeGreaterThan(5);
    });
});
