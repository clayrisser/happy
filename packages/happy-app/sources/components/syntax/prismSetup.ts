/**
 * Turn off everything Prism does on its own, before it loads (DROVE-159).
 *
 * Prism reads `globalThis.Prism.manual` and `.disableWorkerMessageHandler`
 * while its own module body runs, so this has to be evaluated first. It is a
 * separate module rather than two lines at the top of `grammars.ts` because
 * ESM hoists imports above statements, so the assignment would land too late.
 *
 * Both flags matter here:
 *
 *  - `manual` stops the auto-highlighter. On React Native Web `document`
 *    exists, so Prism would otherwise schedule a `highlightAll()` that walks
 *    the entire page after load hunting for `.language-*` elements. We render
 *    through `tokenize` and never want it touching the DOM.
 *  - `disableWorkerMessageHandler` stops the worker branch, which Prism takes
 *    on native, where there is no `document`. It only fires if something has
 *    polyfilled `addEventListener` onto the global, which a stray dependency
 *    can do.
 */
const scope = globalThis as { Prism?: { manual?: boolean; disableWorkerMessageHandler?: boolean } };

scope.Prism = {
    ...(scope.Prism ?? {}),
    manual: true,
    disableWorkerMessageHandler: true,
};

export {};
