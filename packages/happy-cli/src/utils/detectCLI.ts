import { execSync } from 'child_process';
import os from 'os';
import { existsSync } from 'fs';
import { join } from 'path';
import { findAgyBin } from '@/agy/constants';
import { findClaudeBin } from '@/claude/claudeBin';
import { findCursorBin } from '@/cursor/cursorBin';
import { findCodexBin } from '@/codex/codexBin';
import { findGeminiBin } from '@/gemini/geminiBin';
import { findPiBin } from '@/pi/piBin';

export interface CLIAvailability {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  openclaw: boolean;
  agy: boolean;
  /** cursor-agent, which also installs itself as `agent` and `cursor`. */
  cursor: boolean;
  /** pi — the LOCAL-model harness (DROVE-295). */
  pi: boolean;
  detectedAt: number;
}

/**
 * Detects which CLI tools are available on this machine.
 * Cross-platform: uses `command -v` on POSIX, `Get-Command` on Windows.
 */
export function detectCLIAvailability(): CLIAvailability {
  const isWindows = os.platform() === 'win32';

  if (isWindows) {
    return detectWindows();
  }
  return detectPosix();
}

function commandExists(command: string): boolean {
  try {
    execSync(`command -v ${command} >/dev/null 2>&1`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function detectPosix(): CLIAvailability {
  // NOT commandExists (DROVE-400): Claude Code's native installer puts
  // `claude` in ~/.local/bin, which no launchd daemon has on its PATH. The
  // bare probe reported claude: false on Clay's own Mac, and the phone's
  // new-session sheet drew the Claude Code row disabled for it.
  const claude = findClaudeBin() !== undefined;
  // NOT commandExists: `npm install -g @openai/codex` and `brew install --cask
  // codex` both land outside a launchd daemon's PATH, so a bare probe reports
  // "not installed" on a machine that runs Codex every day — and the app's
  // picker then hides the harness entirely (DROVE-273).
  const codex = findCodexBin() !== undefined;
  // NOT commandExists (DROVE-381): `npm install -g @google/gemini-cli` is the
  // only way gemini arrives, and the npm global prefix is per node version — an
  // asdf or nvm directory no daemon PATH names, or /opt/homebrew/bin under a
  // brew node. A bare probe reports the harness uninstalled on a machine that
  // runs it every day, and the app's picker then hides the row entirely.
  const gemini = findGeminiBin() !== undefined;
  const agy = findAgyBin() !== undefined;
  // NOT commandExists: the installer puts cursor-agent in ~/.local/bin, which
  // is not on the daemon's PATH, so a bare probe reports "not installed" on a
  // machine that runs Cursor every day.
  const cursor = findCursorBin() !== undefined;
  // NOT commandExists, and pi is the sharpest case of it: `npm install -g
  // @earendil-works/pi-coding-agent` lands a symlink in /opt/homebrew/bin,
  // which no launchd daemon has on its PATH. A bare probe reports the
  // local-model harness as uninstalled on the machine it was written for.
  const pi = findPiBin() !== undefined;

  // OpenClaw: check command, config file, or env var
  const openclawCommand = commandExists('openclaw');
  const openclawConfig = existsSync(join(os.homedir(), '.openclaw', 'openclaw.json'));
  const openclawEnv = !!process.env.OPENCLAW_GATEWAY_URL;
  const openclaw = openclawCommand || openclawConfig || openclawEnv;

  return { claude, codex, gemini, openclaw, agy, cursor, pi, detectedAt: Date.now() };
}

function detectWindows(): CLIAvailability {
  const checkCommand = (name: string): boolean => {
    try {
      execSync(`powershell -NoProfile -Command "Get-Command ${name} -ErrorAction SilentlyContinue"`, { stdio: 'ignore', windowsHide: true });
      return true;
    } catch {
      return false;
    }
  };

  // Same resolver as POSIX, which already knows the Windows wrapper names.
  const claude = findClaudeBin() !== undefined;
  const codex = findCodexBin() !== undefined;
  // Same resolver as POSIX, which already knows the Windows wrapper names.
  const gemini = findGeminiBin() !== undefined;
  const agy = findAgyBin() !== undefined;
  const cursor = findCursorBin() !== undefined;
  const pi = findPiBin() !== undefined;

  // OpenClaw: check command, config file, or env var
  const openclawCommand = checkCommand('openclaw');
  const openclawConfig = existsSync(join(process.env.USERPROFILE || os.homedir(), '.openclaw', 'openclaw.json'));
  const openclawEnv = !!process.env.OPENCLAW_GATEWAY_URL;
  const openclaw = openclawCommand || openclawConfig || openclawEnv;

  return { claude, codex, gemini, openclaw, agy, cursor, pi, detectedAt: Date.now() };
}
