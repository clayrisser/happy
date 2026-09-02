import { execSync } from 'child_process';
import { existsSync } from 'fs';
import os from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findAgyBin } from '@/agy/constants';
import { findClaudeBin } from '@/claude/claudeBin';
import { findPiBin } from '@/pi/piBin';
import { detectCLIAvailability } from './detectCLI';

vi.mock('child_process', () => ({ execSync: vi.fn() }));
vi.mock('fs', () => ({ existsSync: vi.fn() }));
vi.mock('os', () => ({
  default: {
    homedir: vi.fn(() => '/home/person'),
    platform: vi.fn(() => 'darwin'),
  },
}));
vi.mock('@/agy/constants', () => ({ findAgyBin: vi.fn() }));
vi.mock('@/claude/claudeBin', () => ({ findClaudeBin: vi.fn() }));
vi.mock('@/pi/piBin', () => ({ findPiBin: vi.fn() }));

const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedFindAgyBin = vi.mocked(findAgyBin);
const mockedFindClaudeBin = vi.mocked(findClaudeBin);
const mockedFindPiBin = vi.mocked(findPiBin);
const mockedPlatform = vi.mocked(os.platform);

describe('CLI availability detection', () => {
  beforeEach(() => {
    mockedExecSync.mockReset();
    mockedExecSync.mockImplementation(() => {
      throw new Error('not installed');
    });
    mockedExistsSync.mockReset();
    mockedExistsSync.mockReturnValue(false);
    mockedFindAgyBin.mockReset();
    mockedFindAgyBin.mockReturnValue(undefined);
    mockedFindClaudeBin.mockReset();
    mockedFindClaudeBin.mockReturnValue(undefined);
    mockedFindPiBin.mockReset();
    mockedFindPiBin.mockReturnValue(undefined);
    mockedPlatform.mockReturnValue('darwin');
  });

  it('reports Antigravity only when its executable resolver finds an installation', () => {
    expect(detectCLIAvailability().agy).toBe(false);

    mockedFindAgyBin.mockReturnValue('/home/person/.local/bin/agy');

    expect(detectCLIAvailability().agy).toBe(true);
  });

  // DROVE-295. `command -v pi` is what a login shell answers and a launchd
  // daemon does not: pi installs to /opt/homebrew/bin, which is off the
  // daemon's PATH. Probing the bare name would report the local-model harness
  // as uninstalled on the machine it was written for, so this must go through
  // the absolute-path resolver and nothing else.
  it('reports pi from its absolute-path resolver, never a bare PATH probe', () => {
    expect(detectCLIAvailability().pi).toBe(false);

    mockedFindPiBin.mockReturnValue('/opt/homebrew/bin/pi');

    expect(detectCLIAvailability().pi).toBe(true);
    // And a shell was never spawned to decide it.
    expect(mockedExecSync.mock.calls.some(([cmd]) => String(cmd).includes(' pi'))).toBe(false);
  });

  // DROVE-400. `command -v claude` is what a login shell answers and a launchd
  // daemon does not: the native installer puts claude in ~/.local/bin, which
  // is off the daemon's PATH. Probing the bare name reported Claude Code as
  // uninstalled on the machine this code runs on, so this must go through
  // the absolute-path resolver and nothing else.
  it('reports Claude Code from its absolute-path resolver, never a bare PATH probe', () => {
    expect(detectCLIAvailability().claude).toBe(false);

    mockedFindClaudeBin.mockReturnValue('/home/person/.local/bin/claude');

    expect(detectCLIAvailability().claude).toBe(true);
    // And a shell was never spawned to decide it.
    expect(mockedExecSync.mock.calls.some(([cmd]) => String(cmd).includes(' claude'))).toBe(false);
  });

  it('reports Claude Code on Windows through the same resolver', () => {
    mockedPlatform.mockReturnValue('win32');
    expect(detectCLIAvailability().claude).toBe(false);
    mockedFindClaudeBin.mockReturnValue('C:\\Users\\person\\AppData\\Roaming\\npm\\claude.cmd');
    expect(detectCLIAvailability().claude).toBe(true);
    expect(mockedExecSync.mock.calls.some(([cmd]) => String(cmd).includes('Get-Command claude'))).toBe(false);
  });

  it('reports pi on Windows through the same resolver', () => {
    mockedPlatform.mockReturnValue('win32');
    expect(detectCLIAvailability().pi).toBe(false);
    mockedFindPiBin.mockReturnValue('C:\\pi\\pi.cmd');
    expect(detectCLIAvailability().pi).toBe(true);
  });
});