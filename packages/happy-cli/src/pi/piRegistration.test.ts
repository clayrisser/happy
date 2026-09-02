import { describe, expect, it } from 'vitest';
import { piRegistrationLine } from './piRegistration';

describe('piRegistrationLine', () => {
    it('names the machine, account, happy home and server', () => {
        const line = piRegistrationLine({
            machineId: '21e57f11-ad51-4761-b31f-80dd9b417986',
            happyHomeDir: '/Users/clayrisser/.happy',
            serverUrl: 'https://api.example.test',
            account: 'jam@codejam.ninja',
            homeDir: '/Users/clayrisser',
        });

        expect(line).toBe(
            'registered on machine 21e57f11-ad51-4761-b31f-80dd9b417986'
            + ' · jam@codejam.ninja · ~/.happy · https://api.example.test',
        );
    });

    // The same session has to read identically on macOS and Linux, and no OS
    // username rides along — the rule the huly session identity already holds.
    it('collapses the home directory to ~', () => {
        const line = piRegistrationLine({
            machineId: 'm1',
            happyHomeDir: '/home/clayrisser/.happy',
            serverUrl: 'https://api.example.test',
            homeDir: '/home/clayrisser',
        });

        expect(line).toContain(' · ~/.happy · ');
        expect(line).not.toContain('/home/clayrisser');
    });

    it('leaves a happy home outside the home directory alone', () => {
        const line = piRegistrationLine({
            machineId: 'm1',
            happyHomeDir: '/opt/happy',
            serverUrl: 'https://api.example.test',
            homeDir: '/Users/clayrisser',
        });

        expect(line).toContain(' · /opt/happy · ');
    });

    // A pane started outside drover has no DROVER_ACCOUNT. That is not an
    // error and must not print an empty slot.
    it('omits the account when there is none', () => {
        const line = piRegistrationLine({
            machineId: 'm1',
            happyHomeDir: '/Users/c/.happy',
            serverUrl: 'https://api.example.test',
            account: '   ',
            homeDir: '/Users/c',
        });

        expect(line).toBe('registered on machine m1 · ~/.happy · https://api.example.test');
    });

    it('returns null rather than a bare prefix when it knows nothing', () => {
        expect(piRegistrationLine({ machineId: '', happyHomeDir: '', serverUrl: '' })).toBeNull();
    });
});
