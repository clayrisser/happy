import { describe, expect, it } from 'vitest';
import { resolveControlHandoffDirection, resolveControlMode } from './controlHandoff';

describe('control handoff helpers', () => {
    it('maps controlledByUser to the local UI control mode', () => {
        expect(resolveControlMode(true)).toBe('mobile');
        expect(resolveControlMode(false)).toBe('desktop');
        expect(resolveControlMode(null)).toBe('desktop');
        expect(resolveControlMode(undefined)).toBe('desktop');
    });

    it('treats a tmux pane session as always sendable from the phone', () => {
        // A pane session has no takeover to model: the message is typed into
        // the terminal either way, so the composer must never gate on control.
        expect(resolveControlMode(false, { hasPane: true })).toBe('mobile');
        expect(resolveControlMode(undefined, { hasPane: true })).toBe('mobile');
        expect(resolveControlMode(null, { hasPane: true })).toBe('mobile');
        expect(resolveControlMode(true, { hasPane: true })).toBe('mobile');
    });

    it('falls back to controlledByUser when there is no pane', () => {
        expect(resolveControlMode(false, { hasPane: false })).toBe('desktop');
        expect(resolveControlMode(false, { hasPane: null })).toBe('desktop');
        expect(resolveControlMode(false, {})).toBe('desktop');
        expect(resolveControlMode(true, { hasPane: false })).toBe('mobile');
    });

    it('detects desktop to mobile handoff including the legacy missing previous value', () => {
        expect(resolveControlHandoffDirection(false, true)).toBe('desktop-to-mobile');
        expect(resolveControlHandoffDirection(undefined, true)).toBe('desktop-to-mobile');
        expect(resolveControlHandoffDirection(null, true)).toBe('desktop-to-mobile');
    });

    it('detects mobile to desktop handoff', () => {
        expect(resolveControlHandoffDirection(true, false)).toBe('mobile-to-desktop');
    });

    it('ignores unchanged and incomplete handoff states', () => {
        expect(resolveControlHandoffDirection(false, false)).toBeNull();
        expect(resolveControlHandoffDirection(true, true)).toBeNull();
        expect(resolveControlHandoffDirection(undefined, false)).toBeNull();
        expect(resolveControlHandoffDirection(true, undefined)).toBeNull();
    });
});
