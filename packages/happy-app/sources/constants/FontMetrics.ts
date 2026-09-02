/**
 * Vertical metrics of the shipped faces, as fractions of the em.
 *
 * Read from the font files in `sources/assets/fonts` with fontTools, not
 * guessed: IBM Plex Sans carries `sCapHeight` 698 and an hhea line of
 * 1025 + 275 on a 1000-unit em, in Regular and SemiBold alike. Layout that
 * has to line up with the INK of a piece of type rather than its line box
 * reads these; the recording pill's level strip is held to the clock's cap
 * height this way (DROVE-383).
 *
 * Its own module, with no `react-native` import, so pure layout code and the
 * specs beside it can read a metric without pulling the native surface in.
 * `Typography` re-exports it, so it is one surface with the faces.
 */
export const FontMetrics = {
    /** IBM Plex Sans, `Typography.default`. */
    default: {
        /**
         * A capital or a lining digit's height above the baseline. `7` is
         * exactly this; `0` overshoots it by 1.2%, as round glyphs do.
         */
        capHeight: 0.698,
        /** Ascender plus descender: what a line of this face takes with no `lineHeight` set. */
        lineHeight: 1.3,
    },
} as const;
