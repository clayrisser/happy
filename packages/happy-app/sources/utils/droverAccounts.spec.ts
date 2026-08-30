import { describe, expect, it } from 'vitest';
import { collectDroverAccountsFromSessions, droverFlipMessage } from './droverAccounts';

const session = (droverAccount?: string | null) => ({ metadata: { droverAccount } });

describe('collectDroverAccountsFromSessions', () => {
    it('returns the distinct stamped accounts, sorted', () => {
        expect(collectDroverAccountsFromSessions([
            session('work'),
            session('anna'),
            session('work'),
        ])).toEqual(['anna', 'work']);
    });

    it('ignores unaccounted sessions instead of inventing an account for them', () => {
        expect(collectDroverAccountsFromSessions([
            session(null),
            session(undefined),
            { metadata: null },
            {},
            session('work'),
        ])).toEqual(['work']);
    });

    it('is empty when nothing is stamped, which is what hides the action', () => {
        expect(collectDroverAccountsFromSessions([session(null), {}])).toEqual([]);
    });
});

describe('droverFlipMessage', () => {
    it('sends bare /flip when no account is named, letting the CLI pick', () => {
        expect(droverFlipMessage()).toBe('/flip');
        expect(droverFlipMessage(null)).toBe('/flip');
        expect(droverFlipMessage('')).toBe('/flip');
        expect(droverFlipMessage('   ')).toBe('/flip');
    });

    it('names the account when one is picked', () => {
        expect(droverFlipMessage('anna')).toBe('/flip anna');
        expect(droverFlipMessage('  anna  ')).toBe('/flip anna');
    });
});
