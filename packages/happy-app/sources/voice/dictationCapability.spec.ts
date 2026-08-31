import { describe, expect, it } from 'vitest';
import { dictationBlock } from './dictationCapability';

describe('dictationBlock', () => {
    it('lets a module that can report open the mic', () => {
        expect(dictationBlock({
            moduleAvailable: true,
            reportsProgress: true,
            build: '12',
        })).toBeNull();
    });

    it('refuses a build whose module cannot report, and names it', () => {
        expect(dictationBlock({
            moduleAvailable: true,
            reportsProgress: false,
            build: '11',
        })).toEqual({ kind: 'stale-build', build: '11' });
    });

    it('refuses a device with no speech module at all', () => {
        expect(dictationBlock({
            moduleAvailable: false,
            reportsProgress: false,
            build: '11',
        })).toEqual({ kind: 'unsupported' });
    });

    it('says unsupported before stale: no module is the bigger fact', () => {
        expect(dictationBlock({
            moduleAvailable: false,
            reportsProgress: true,
            build: null,
        })).toEqual({ kind: 'unsupported' });
    });

    it('carries a null build through rather than inventing a number', () => {
        expect(dictationBlock({
            moduleAvailable: true,
            reportsProgress: false,
            build: null,
        })).toEqual({ kind: 'stale-build', build: null });
    });
});
