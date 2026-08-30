import { describe, expect, it } from 'vitest';
import {
  appendDaemonPermissionArgs,
  appendDaemonSpawnModeArgs,
  shouldForwardDaemonPermissionMode,
} from './spawnModeArgs';

describe('daemon spawn mode arguments', () => {
  it('forwards Codex default because it is a concrete ask-first policy', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, { directory: '/repo', permissionMode: 'default' }, 'codex', true);

    expect(args).toEqual(['--permission-mode', 'default']);
  });

  it('leaves Claude default ambient', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, { directory: '/repo', permissionMode: 'default' }, 'claude', false);

    expect(args).toEqual([]);
  });

  it('forwards explicit Codex permission, model, and effort selections', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, {
      directory: '/repo',
      permissionMode: 'yolo',
      modelMode: 'gpt-5.6-sol',
      effortLevel: 'medium',
    }, 'codex', true);

    expect(args).toEqual([
      '--permission-mode', 'yolo',
      '--model', 'gpt-5.6-sol',
      '--effort', 'medium',
    ]);
  });

  it('uses the same Codex default rule for resume launches', () => {
    expect(shouldForwardDaemonPermissionMode('codex', 'default')).toBe(true);
    expect(shouldForwardDaemonPermissionMode('claude', 'default')).toBe(false);
  });
});

// BASED-140: a daemon spawn used to carry nothing about permissions, so a
// session started from the phone ran in `default` and raised a card for every
// tool call while the terminal beside it raised none.
describe('daemon spawns under the drover permission policy', () => {
  it('gives a phone-started Claude session the terminal\'s bypass', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, { directory: '/repo' }, 'claude', true);

    expect(args).toEqual(['--dangerously-skip-permissions']);
  });

  it('treats Claude\'s ambient "default" as no request at all', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, { directory: '/repo', permissionMode: 'default' }, 'claude', true);

    expect(args).toEqual(['--dangerously-skip-permissions']);
  });

  it('lets an explicit mode from the phone beat the policy', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, { directory: '/repo', permissionMode: 'plan' }, 'claude', true);

    expect(args).toEqual(['--permission-mode', 'plan']);
  });

  it('adds nothing when the policy is off', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, { directory: '/repo' }, 'claude', false);

    expect(args).toEqual([]);
  });

  it('never puts a Claude flag on a Codex spawn', () => {
    const args: string[] = [];

    appendDaemonSpawnModeArgs(args, { directory: '/repo' }, 'codex', true);

    expect(args).toEqual([]);
  });

  it('applies the same policy to a resume launch', () => {
    const resumed: string[] = ['claude', '--resume', 'abc'];

    appendDaemonPermissionArgs(resumed, 'claude', undefined, true);

    expect(resumed).toEqual(['claude', '--resume', 'abc', '--dangerously-skip-permissions']);
  });
});
