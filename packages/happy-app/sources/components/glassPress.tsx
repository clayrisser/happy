import * as React from 'react';

/**
 * Whether the surface a control sits in is drawing the platform's own press
 * response, so the control can stop drawing an imitation of it (DROVE-169).
 *
 * Clay: "I'm still waiting for my buttons to have the Liquid Glass animations
 * to them like the DEFAULT behavior". Three imitations were in the way, and
 * they are written in three different files: a `withSpring` scale in
 * `MobileGlassSurface`, another in `BubblePressable`, and an `opacity: 0.6`
 * pressed style on `GlassChromeButton`. Scaling the whole view is also the
 * worst of them on the material, because a `GlassView` under a transform
 * renders as a refractive blob rather than a control reacting.
 *
 * A context rather than a prop because the segments inside a capsule are
 * written by files that do not know what they are mounted in, and only the
 * surface knows whether the material under them is real.
 */
const GlassPressContext = React.createContext(false);

export function GlassPressProvider({ value, children }: {
    value: boolean;
    children?: React.ReactNode;
}) {
    return (
        <GlassPressContext.Provider value={value}>
            {children}
        </GlassPressContext.Provider>
    );
}

export function useNativeGlassPress(): boolean {
    return React.useContext(GlassPressContext);
}
