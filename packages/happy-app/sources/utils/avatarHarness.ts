/**
 * Resolve the harness identity used by a session avatar badge.
 *
 * A Rig session is Happy's own harness even when its selected provider is
 * Codex or Claude, so the client identity always wins over provider/flavor
 * metadata. Only the active harnesses have badges; retired and unknown
 * flavors stay badge-free.
 *
 * pi joined that set in DROVE-379. It had shipped its icon and its slot in
 * HARNESS_ORDER without ever reaching this map, so a `drover pi` row sat in
 * the list wearing nothing that said pi — the same avatar and the same
 * path-derived title as the claude sessions in the same project card. Clay
 * read that as the session never arriving at all.
 *
 * gemini followed in DROVE-381, the ticket that un-retired it. Its icon had
 * shipped with the app all along; the retirement was the only thing keeping
 * it out of this set, and DROVE-379 had already flagged that a returning row
 * would arrive badge-free and repeat the pi bug.
 */
export type AvatarHarnessIcon = 'claude' | 'codex' | 'agy' | 'pi' | 'gemini' | 'rig';

const ACTIVE_HARNESS_ICONS: ReadonlySet<string> = new Set([
    'claude',
    'codex',
    'agy',
    'pi',
    'gemini',
]);

export function resolveAvatarHarness(
    flavor?: string | null,
    clientId?: string | null,
): AvatarHarnessIcon | null {
    if (clientId === 'rig') return 'rig';
    if (flavor == null || !ACTIVE_HARNESS_ICONS.has(flavor)) return null;
    return flavor as Exclude<AvatarHarnessIcon, 'rig'>;
}