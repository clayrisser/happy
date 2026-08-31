/**
 * The effort SCALE: which levels this model offers, and where the current one
 * sits on them (DROVE-200, cut back to this by DROVE-242).
 *
 * This file was the drag. DROVE-200 built effort as a slider, because effort
 * is ordinal and DROVE-141 already draws it as a dial with a needle position:
 * pressing the segment raised a horizontal readout above the composer and the
 * same unbroken touch dragged along it, one stop per level, committing on
 * release.
 *
 * IT IS GONE, AND CLAY IS WHY. With a screenshot of that readout sitting over
 * his field: "Why does it show the old shitty slider when I hold down effort?"
 *
 * DROVE-229 had already made a TAP on the segment open the full-width sheet
 * and left the readout as the thing you see while dragging. That split is what
 * he was looking at. Holding the control showed him the surface the sheet had
 * just replaced, so which picker he got depended on how he touched the same
 * 44pt square, and the readout appeared on touch-DOWN, which means resting a
 * finger raised it. A hold is not a drag.
 *
 * WHY DELETED RATHER THAN NARROWED TO A REAL DRAG. Making it wait for the
 * finger to travel would have answered the screenshot, and it was the other
 * option on the table. What killed it is that the drag had no way in any more.
 * Nothing on the capsule announced it, and a press, the only thing anyone
 * would try, opens a sheet. A gesture reachable only by a move nobody is told
 * about, on a control whose press does something else, is not a fast path; it
 * is a trap, and it had just fired. DROVE-229 also found this responder
 * entered `dragging` on every press-in, which is the same press-versus-drag
 * line got wrong once already.
 *
 * So effort is a picker segment exactly like the mode and the model beside it
 * (DROVE-242): one press, one sheet, all four dismissal routes. What it costs
 * is named on `composerPickerSheetOpen` in composerPicker.ts.
 *
 * WHAT SURVIVES IS THE SCALE, which was never the slider's. The DIAL reads it
 * for the needle's angle and the sheet reads it for its rows, and both did
 * before the drag existed.
 *
 * THE ENDS ARE THIS MODEL'S REAL ENDS. The stops come from
 * `getEffortLevelsForModel`, which is per model and which DROVE-164 rewrote as
 * a DENY list after DROVE-101 wrote it backwards and cost Clay `ultracode` for
 * two months. Nothing here re-derives that table; it asks it. Switching model
 * re-asks it, so the run re-scales: six stops on Opus 5, four on a model below
 * the xhigh line, whatever the rig published for a rig session.
 *
 * `AUTO` IS A MODE, NOT A LEVEL. `/effort auto` hands the choice back to
 * Claude Code; it is not a seventh notch and it is not below `low`, so it has
 * no index on the run at all. Choosing it is a row on the effort sheet. Its
 * wire value is `effortLevel: null`, which paneModelSync spells `/effort auto`,
 * the reset argument DROVE-164 fixed.
 *
 * Pure, no React and no native module, so the scale is provable in node.
 */

import type { Metadata } from '@/sync/storageTypes';
import {
    effortDisplayName,
    getEffortLevelsForModel,
    type AgentFlavor,
    type EffortLevel,
} from './modelModeOptions';

/** The index that means `auto`: not on the ordered run at all. */
export const EFFORT_AUTO_INDEX = -1;

export interface EffortSliderScale {
    /** Wire keys, floor first, ceiling last. */
    keys: readonly string[];
    /** The same stops as words, for the readout and the screen reader. */
    names: readonly string[];
}

const emptyScale: EffortSliderScale = { keys: [], names: [] };

/**
 * The stops this model actually offers.
 *
 * Only reachable levels. `getEffortLevelsForModel` is already per model and is
 * the selection path DROVE-101 and DROVE-164 both landed on; a disabled entry
 * would only ever arrive here through a rig publishing one, and it is dropped
 * rather than counted as a position the needle can point at.
 */
export function effortSliderScale(
    flavor: AgentFlavor,
    modelKey: string,
    metadata?: Metadata | null,
): EffortSliderScale {
    return effortSliderScaleFromLevels(getEffortLevelsForModel(flavor, modelKey, metadata));
}

/**
 * The same scale built from a list a caller already has. The composer is given
 * the PICKER's list, which appends the levels this model cannot reach as
 * disabled rows (DROVE-101); the run drops them, so its ends are the model's
 * real ends and the dial's hard left and hard right mean the ends.
 */
export function effortSliderScaleFromLevels(levels: readonly EffortLevel[]): EffortSliderScale {
    const reachable = levels.filter((level) => !level.disabled);
    if (reachable.length === 0) return emptyScale;
    return {
        keys: reachable.map((level) => level.key),
        names: reachable.map((level) => level.name ?? effortDisplayName(level.key)),
    };
}

/**
 * Where a key sits on this scale.
 *
 * Three answers, and the third is the one that makes switching model work:
 *   - no key at all is `auto`, which is off the run: EFFORT_AUTO_INDEX.
 *   - a key on the scale is its index.
 *   - a key the NEW model cannot reach lands on the ceiling, which is where
 *     `updateModelMode` puts it too (getHighestReachableEffortKey, DROVE-101).
 *     The needle never points off the end of its own scale.
 */
export function effortSliderIndex(scale: EffortSliderScale, key: string | null | undefined): number {
    if (scale.keys.length === 0) return EFFORT_AUTO_INDEX;
    if (key == null || key.length === 0) return EFFORT_AUTO_INDEX;
    const index = scale.keys.indexOf(key);
    if (index >= 0) return index;
    return scale.keys.length - 1;
}
