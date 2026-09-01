/**
 * vitest setupFile for the unit project (DROVE-336): throwaway homes and dead
 * ports, applied before the test file loads a single module, and checked again
 * after every test. noRealState.ts says why.
 */

import { afterEach } from 'vitest';

import { applyNoRealState, assertNoRealState } from './noRealState';

const guard = applyNoRealState(process.env);

// Loaded only now. `configuration` is a singleton that reads the env once, at
// import; a static import here would be hoisted above the apply and bake the
// real paths in.
const { configuration } = await import('@/configuration');

assertNoRealState(configuration, process.env, guard.real);

afterEach(() => {
    assertNoRealState(configuration, process.env, guard.real);
});
