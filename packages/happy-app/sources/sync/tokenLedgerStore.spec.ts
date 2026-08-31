/**
 * WHERE THE ALL-TIME LEDGER LIVES, AND WHAT IT OUTLIVES (DROVE-241).
 *
 * The reducer is proved in tokenLedger.spec.ts. This proves the one thing
 * that is about the STORE rather than the arithmetic: the ledger is not on
 * the MMKV instance a logout wipes, so nothing but Clay's long press can
 * zero it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Two instances, exactly as the app has them: the default one that
 * `clearPersistence()` clears on logout, and the named ones that survive it.
 * Keying the mock's map by MMKV id is the whole point of this spec — a single
 * shared map would make the assertion below pass no matter which instance the
 * ledger used.
 */
const stores = new Map<string, Map<string, string>>();
const storeFor = (id: string) => {
    const existing = stores.get(id);
    if (existing) return existing;
    const created = new Map<string, string>();
    stores.set(id, created);
    return created;
};
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        private readonly store: Map<string, string>;
        constructor(config?: { id?: string }) {
            const id = config?.id ?? 'default';
            const existing = stores.get(id);
            if (existing) {
                this.store = existing;
            } else {
                this.store = new Map<string, string>();
                stores.set(id, this.store);
            }
        }
        getString(key: string) { return this.store.get(key); }
        set(key: string, value: string) { this.store.set(key, value); }
        delete(key: string) { this.store.delete(key); }
        getNumber(key: string) { const v = this.store.get(key); return v === undefined ? undefined : Number(v); }
        clearAll() { this.store.clear(); }
    },
}));

const { loadTokenLedger, saveTokenLedger } = await import('./tokenLedgerStore');
const { emptyTokenLedger, tokenLedgerTotal } = await import('./tokenLedger');

const banked = {
    byModel: { 'claude-opus-5': 1_000_000, 'claude-fable-5': 300_000 },
    unattributed: 18,
    marks: { drove: { session: 1_300_018, byModel: { 'claude-opus-5': 1_000_000 }, at: 5 } },
    resetAt: null,
};

describe('the ledger on disk', () => {
    beforeEach(() => stores.forEach((store) => store.clear()));

    it('round-trips', () => {
        saveTokenLedger(banked);
        expect(loadTokenLedger()).toEqual(banked);
        expect(tokenLedgerTotal(loadTokenLedger())).toBe(1_300_018);
    });

    it('is NOT on the instance a logout clears', () => {
        // `clearPersistence()` is `new MMKV().clearAll()` — the default
        // instance, holding settings, drafts, the push token and everything
        // else. A ledger kept there would be zeroed by signing out, which is
        // not one of the two things Clay asked could reset it.
        saveTokenLedger(banked);
        storeFor('default').clear();
        expect(loadTokenLedger()).toEqual(banked);
    });

    it('starts empty rather than throwing on a corrupt or missing record', () => {
        expect(loadTokenLedger()).toEqual(emptyTokenLedger);
        storeFor('token-ledger').set('all-time-tokens-v1', 'not json {{');
        expect(loadTokenLedger()).toEqual(emptyTokenLedger);
        storeFor('token-ledger').set('all-time-tokens-v1', JSON.stringify({ byModel: 'nope' }));
        expect(loadTokenLedger()).toEqual(emptyTokenLedger);
    });
});
