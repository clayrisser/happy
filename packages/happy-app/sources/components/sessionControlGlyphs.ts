/**
 * The two glyphs on the composer's session controls, and the words a screen
 * reader hears instead of them (DROVE-141).
 *
 * Clay, with a screenshot of the pair DROVE-111 shipped: "use better icons for
 * these." Both had the same class of problem, so both are decided here, once,
 * and pinned by a spec rather than by eye.
 *
 * PERMISSION MODE WAS A WARNING TRIANGLE. That is the universal glyph for
 * something being WRONG, so a session running exactly as asked rendered as an
 * error. Yolo is a choice, not a fault. A triangle also has nowhere to go: it
 * cannot say plan, or edits, or the default that stops and asks.
 *
 * The axis now is a PADLOCK, because open versus shut is the most legible
 * difference there is at 20pt, and because it names the thing the mode
 * actually controls: whether the agent needs your key.
 *
 *   lock closed   the default. Nothing happens until you say so.
 *   lock open     yolo. No gate, deliberately. Not an error, an open door.
 *   shield check  safe-yolo. No gate, but fenced to the workspace.
 *   eye           read-only. It can look. A lock here would say "shut out",
 *                 which is the wrong sentence: reading works fine.
 *   pencil        acceptEdits. It writes without asking, and nothing more.
 *   map           plan. Its own glyph, as the ticket asked: the route drawn
 *                 before the walk.
 *
 * Six shapes, no two alike in silhouette, and the two Clay switches between
 * most (default and yolo) are the same glyph open and shut, which is the
 * easiest pair of all to tell apart in a hurry.
 *
 * EFFORT WAS A BAR METER. The lane that built it already flagged the flaw:
 * four filled bars and five filled bars are a COUNT, and nobody counts at a
 * glance, so the two levels a person most often moves between were the two
 * hardest to tell apart. A dial is a POSITION. The needle's angle says where
 * on the scale you are without anything being counted, and because the angle
 * is interpolated across whatever scale the model offers, it works for the
 * four levels Codex has and the six Claude has without changing (DROVE-101).
 *
 * Neither glyph leans on colour: one is a silhouette, the other an angle.
 *
 * Pure, so every mode and every scale can be pinned without a renderer.
 * ComposerSessionControls.tsx draws them.
 */

/** The Ionicons name for a permission mode. Kind first, key as the fallback. */
export type PermissionGlyphName =
    | 'eye-outline'
    | 'map-outline'
    | 'create-outline'
    | 'lock-open-outline'
    | 'lock-closed-outline'
    | 'shield-checkmark-outline';

export function permissionModeGlyph(
    kind: string | null | undefined,
    key?: string | null,
): PermissionGlyphName {
    const value = (kind ?? key ?? '').toLowerCase();
    if (value === 'read-only' || value === 'read' || value === 'read_only') return 'eye-outline';
    if (value === 'plan') return 'map-outline';
    if (value === 'acceptedits' || value === 'edits') return 'create-outline';
    if (value === 'yolo' || value === 'bypasspermissions' || value === 'full') return 'lock-open-outline';
    if (value === 'safe-yolo' || value === 'workspace' || value === 'auto') return 'shield-checkmark-outline';
    // Everything else is the mode that stops and asks, which is the shut lock.
    return 'lock-closed-outline';
}

/**
 * The dial's sweep, in degrees, with 0 straight up.
 *
 * 260 degrees rather than a full circle so the two ends are visibly ends: a
 * needle at the bottom-left is unmistakably the floor and one at the
 * bottom-right unmistakably the ceiling. A full circle would put lowest and
 * highest at the same place.
 */
export const effortGaugeSweep = { startDeg: -130, endDeg: 130 } as const;

/**
 * Where the needle points for level `index` on a scale `count` long.
 *
 * Interpolated, not stepped, so the scale's LENGTH never changes what an angle
 * means relative to the ends: top of the scale is always hard right, bottom
 * always hard left, whether the model offers four levels or six. A one-level
 * scale points straight up, since it has no position to report.
 */
export function effortGaugeAngle(index: number, count: number): number {
    const levels = Math.max(1, Math.round(count));
    if (levels === 1) return 0;
    const level = Math.max(0, Math.min(levels - 1, Math.round(index)));
    const { startDeg, endDeg } = effortGaugeSweep;
    return startDeg + ((endDeg - startDeg) * level) / (levels - 1);
}

/** A point on the dial, with 0 degrees straight up and positive clockwise. */
export function effortGaugePoint(
    centre: number,
    radius: number,
    degrees: number,
): { x: number; y: number } {
    const radians = (degrees * Math.PI) / 180;
    return {
        x: centre + radius * Math.sin(radians),
        y: centre - radius * Math.cos(radians),
    };
}

/**
 * The track the needle sits on, as an SVG arc.
 *
 * The sweep is wider than a half turn, so the large-arc flag is always set;
 * the sweep flag is clockwise, which is the direction the levels run.
 */
export function effortGaugeTrackPath(size: number, strokeWidth: number): string {
    const centre = size / 2;
    const radius = (size - strokeWidth) / 2;
    const from = effortGaugePoint(centre, radius, effortGaugeSweep.startDeg);
    const to = effortGaugePoint(centre, radius, effortGaugeSweep.endDeg);
    return `M ${round(from.x)} ${round(from.y)} A ${round(radius)} ${round(radius)} 0 1 1 ${round(to.x)} ${round(to.y)}`;
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

/**
 * What a screen reader hears where the glyph is.
 *
 * The row says it in a shape; this says it in words, which is the whole of the
 * accessibility contract for an unlabelled control. Named, then valued, so the
 * announcement is "Permission mode, Yolo" rather than a bare word with no
 * subject.
 */
export function permissionModeAccessibility(modeLabel: string | null | undefined): {
    label: string;
    value?: string;
} {
    const mode = modeLabel?.trim();
    return mode ? { label: 'Permission mode', value: mode } : { label: 'Permission mode' };
}

export function effortAccessibility(
    effortLabel: string | null | undefined,
    index: number,
    count: number,
): { label: string; value?: string } {
    const effort = effortLabel?.trim();
    if (!effort) return { label: 'Reasoning effort' };
    const levels = Math.max(1, Math.round(count));
    // The position is the thing the dial draws, so the words carry it too.
    const value = levels > 1
        ? `${effort}, ${Math.max(0, Math.min(levels - 1, Math.round(index))) + 1} of ${levels}`
        : effort;
    return { label: 'Reasoning effort', value };
}
