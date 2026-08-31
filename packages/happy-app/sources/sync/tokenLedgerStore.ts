/**
 * Where the all-time token ledger lives on disk (DROVE-241).
 *
 * ITS OWN MMKV INSTANCE, and that is the whole reason this file exists rather
 * than a key on `localSettings`. `persistence.ts` uses the DEFAULT instance
 * and `clearPersistence()` calls `mmkv.clearAll()` on every logout, so a
 * counter kept there would be wiped by an event that has nothing to do with
 * Clay's long press. `serverConfig.ts` already sets the precedent for state
 * that has to outlive a logout; this follows it.
 *
 * THE KEY IS THE DEVICE. Not the Claude account, which is the thing that
 * flipped twice in one evening; not the Happy account, because logging out is
 * not "reset my counter". The long press is the only reset, which is exactly
 * what Clay asked for and nothing more.
 */
import { MMKV } from 'react-native-mmkv';
import * as z from 'zod';
import { emptyTokenLedger, type TokenLedger } from './tokenLedger';

/** Deliberately not the default instance. See the header. */
const ledgerStorage = new MMKV({ id: 'token-ledger' });

const LEDGER_KEY = 'all-time-tokens-v1';

const MarkSchema = z.object({
    session: z.number(),
    byModel: z.record(z.string(), z.number()),
    at: z.number(),
});

const LedgerSchema = z.object({
    byModel: z.record(z.string(), z.number()),
    unattributed: z.number(),
    marks: z.record(z.string(), MarkSchema),
    resetAt: z.number().nullable(),
});

/** The ledger on disk, or an empty one. A corrupt record is never fatal. */
export function loadTokenLedger(): TokenLedger {
    try {
        const raw = ledgerStorage.getString(LEDGER_KEY);
        if (!raw) return emptyTokenLedger;
        const parsed = LedgerSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : emptyTokenLedger;
    } catch {
        return emptyTokenLedger;
    }
}

export function saveTokenLedger(ledger: TokenLedger): void {
    try {
        ledgerStorage.set(LEDGER_KEY, JSON.stringify(ledger));
    } catch {
        // A phone with no room left is not a reason to break the session list.
    }
}
