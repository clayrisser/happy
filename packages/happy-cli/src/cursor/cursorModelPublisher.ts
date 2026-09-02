/**
 * The one path a Cursor session's model list takes to the phone (DROVE-395).
 *
 * WHY IT IS ITS OWN THING. runCursor used to fire `--list-models` once, return
 * on `[]`, and move on. A locked login keychain exits 1 before a row is
 * printed, which is the state a session started from the phone is in, so the
 * capsule showed a padlock and a speaker and no model at all, and the log had
 * nothing to say about it. The list is the only thing that decides whether
 * the phone can name or change the model, so it gets a policy rather than a
 * `.then`.
 *
 * WHAT THE POLICY IS.
 *
 *   ask under the turn's env   `list` is handed in, and the runner hands in
 *                              `backend.listModels()`, so the question runs
 *                              under exactly what the next turn runs under.
 *   a failure is logged        with the exit and cursor-agent's last line.
 *   and still published        as the rows the session knows are true: `auto`
 *                              and the family it was started with, marked.
 *                              fallbackCursorModelCatalog says why no tiers.
 *   asked again after a turn   a turn that COMPLETED proves the credential
 *                              works, so a keychain unlocked after the start
 *                              fills the real picker on the next turn. Bounded,
 *                              because a login that will never answer should
 *                              not be asked forever.
 *   one catalog in force       a pick from the phone is resolved by lookup
 *                              against whichever catalog is current, so the
 *                              started family round-trips to its exact id
 *                              before any list has landed.
 *
 * WHO CALLS IT. The per-turn `--print --resume` runner today, with the resolved
 * id going to `backend.setModel` for the next turn. A pane that launches the
 * real cursor-agent TUI once (DROVE-377) has the same two needs, the rows to
 * publish and the id for its `--model`, and gets them from the same object:
 * nothing in here knows how a turn is spawned.
 */

import {
    buildCursorModelCatalog,
    fallbackCursorModelCatalog,
    resolveCursorModelId,
    type CursorModelCatalog,
    type CursorModelListing,
    type CursorModelOption,
} from './cursorModels';

/** What lands on `metadata`. `thoughtLevels` only when a real scale exists. */
export interface CursorModelPatch {
    models: CursorModelOption[];
    thoughtLevels?: CursorModelOption[];
}

export interface CursorModelPublisherOptions {
    /** `cursor-agent --list-models`, under the environment a turn gets. */
    list: () => Promise<CursorModelListing>;
    /** Write the rows onto the session. */
    publish: (patch: CursorModelPatch) => void;
    /** The `--model` the session was started with, if any. */
    startedModel?: string | null;
    /** How many more times a failed list is asked after a completed turn. */
    retries?: number;
    log?: (msg: string) => void;
    warn?: (msg: string) => void;
}

/** After the first ask, this many more, one per completed turn. */
export const cursorListRetries = 3;

export class CursorModelPublisher {
    private readonly opts: CursorModelPublisherOptions;
    private readonly maxAttempts: number;
    private catalog: CursorModelCatalog;
    private listed = false;
    private attempts = 0;
    private inFlight: Promise<void> | null = null;

    constructor(opts: CursorModelPublisherOptions) {
        this.opts = opts;
        this.maxAttempts = 1 + (opts.retries ?? cursorListRetries);
        // In force from the first millisecond, published only if the list
        // fails: a pick that arrives before cursor-agent has answered still
        // resolves against something true.
        this.catalog = fallbackCursorModelCatalog(opts.startedModel);
    }

    /** Whether the real list has landed. */
    get hasListed(): boolean {
        return this.listed;
    }

    /** How many times cursor-agent has been asked. */
    get listAttempts(): number {
        return this.attempts;
    }

    /** The catalog in force: the real list, or the fallback until it lands. */
    get current(): CursorModelCatalog {
        return this.catalog;
    }

    /**
     * The first ask. Publishes the real list, or the fallback with the reason
     * in the log. Never throws: a session is not lost over a picker.
     */
    start(): Promise<void> {
        return this.attempt(true);
    }

    /**
     * After a COMPLETED turn. A failed turn proves nothing about the
     * credential, so the runner does not call this for one.
     */
    afterTurn(): Promise<void> {
        if (this.listed || this.attempts >= this.maxAttempts) return Promise.resolve();
        return this.attempt(false);
    }

    /** The real `--model` id for a family and an effort pick, by lookup. */
    resolve(family: string | null | undefined, effort: string | null | undefined): string | null {
        return resolveCursorModelId(this.catalog, family, effort);
    }

    private attempt(first: boolean): Promise<void> {
        // A turn that ends while the first ask is still running joins it
        // rather than starting a second cursor-agent beside it.
        if (this.inFlight) return this.inFlight;
        this.inFlight = this.run(first).finally(() => {
            this.inFlight = null;
        });
        return this.inFlight;
    }

    private async run(first: boolean): Promise<void> {
        this.attempts += 1;
        let listing: CursorModelListing;
        try {
            listing = await this.opts.list();
        } catch (error) {
            listing = { models: [], failure: error instanceof Error ? error.message : String(error) };
        }

        if (listing.failure === null && listing.models.length > 0) {
            this.catalog = buildCursorModelCatalog(listing.models);
            this.listed = true;
            this.opts.publish({
                models: this.catalog.models,
                ...(this.catalog.efforts.length > 0 ? { thoughtLevels: this.catalog.efforts } : {}),
            });
            this.opts.log?.(
                `--list-models: ${listing.models.length} ids, ${this.catalog.models.length} families`
                + (first ? '' : ` (attempt ${this.attempts})`),
            );
            return;
        }

        const left = this.maxAttempts - this.attempts;
        this.opts.warn?.(
            `--list-models failed (${listing.failure ?? 'no model rows'}); `
            + (left > 0 ? `asking again after a turn, ${left} left` : 'not asking again'),
        );
        if (first) {
            this.opts.publish({ models: this.catalog.models });
        }
    }
}
