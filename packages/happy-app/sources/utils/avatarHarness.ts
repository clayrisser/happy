/**
 * Resolve the harness identity used by a session avatar badge and, since
 * DROVE-393, by the glyph on every session row.
 *
 * A Rig session is Happy's own harness even when its selected provider is
 * Codex or Claude, so the client identity always wins over provider/flavor
 * metadata.
 *
 * THE SET IS THE CATALOG'S, NOT THIS FILE'S (DROVE-393). It used to be a
 * hand-picked subset that each harness joined one ticket late: pi in
 * DROVE-379 and gemini in DROVE-381, each after a session had already sat in
 * the list wearing nothing, each time with the icon in the bundle all along.
 * cursor and openclaw were next in line; the promanager session Clay pointed
 * at was a `drover cursor` pane. So every key the catalog names resolves to
 * its mark, retired or not, because retirement is about STARTING a session
 * and a session that exists still has to say what it is. That includes the
 * harnesses the picker cannot start (opencode), which the catalog names for
 * the same reason. The type is the catalog's own, which makes a harness
 * added there without a mark a compile error in HarnessGlyph.tsx rather than
 * a badge-free row.
 */
import type { NewSessionAgentType } from '@/sync/persistence';
import { HARNESS_NAMES, NON_SPAWNABLE_HARNESS_NAMES, type NonSpawnableHarness } from './harnessCatalog';

export type AvatarHarnessIcon = NewSessionAgentType | NonSpawnableHarness;

const HARNESS_ICONS: ReadonlySet<string> = new Set([
    ...Object.keys(HARNESS_NAMES),
    ...Object.keys(NON_SPAWNABLE_HARNESS_NAMES),
]);

/**
 * Codex shipped under two older flavor slugs and both are still on real
 * sessions; harnessName.ts keeps their names for the same reason.
 */
const FLAVOR_ALIASES: Record<string, AvatarHarnessIcon> = {
    gpt: 'codex',
    openai: 'codex',
};

/**
 * Line-art marks with no colour of their own. They take the text colour of
 * wherever they sit; every other mark is drawn in its own colours everywhere.
 */
export const MONOCHROME_HARNESS_ICONS: ReadonlySet<AvatarHarnessIcon> = new Set<AvatarHarnessIcon>([
    'codex',
    'rig',
    'cursor',
]);

export function resolveAvatarHarness(
    flavor?: string | null,
    clientId?: string | null,
): AvatarHarnessIcon | null {
    if (clientId === 'rig') return 'rig';
    if (flavor == null) return null;
    const key = FLAVOR_ALIASES[flavor] ?? flavor;
    if (!HARNESS_ICONS.has(key)) return null;
    return key as AvatarHarnessIcon;
}

/**
 * The flavor a session's marks are drawn from.
 *
 * `flavor` is absent on every session written before the field existed, and
 * harnessName() calls those Claude because that is what they were. A badge is
 * a stronger claim than a name: drawn wrong, it says a cursor pane is Claude.
 * So an absent flavor earns the claude mark only on the Claude runner's own
 * evidence, `claudeSessionId`, which claudeLocalLauncher.ts writes and no
 * other runner does. `startedBy` is not evidence: every runner stamps it from
 * the same CLI argument, so a cursor pane the daemon started says `daemon`
 * exactly as a Claude one does.
 */
export function sessionHarnessFlavor(
    metadata?: {
        flavor?: string | null;
        claudeSessionId?: string | null;
        startedBy?: string | null;
    } | null,
): string | null {
    if (metadata?.flavor) return metadata.flavor;
    if (metadata?.claudeSessionId) return 'claude';
    return null;
}
