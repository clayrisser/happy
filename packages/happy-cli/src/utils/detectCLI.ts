import { execSync } from 'child_process';
import os from 'os';
import { existsSync } from 'fs';
import { join } from 'path';
import { findAgyBin } from '@/agy/constants';
import { findCursorBin } from '@/cursor/cursorBin';
import { findCodexBin } from '@/codex/codexBin';

export interface CLIAvailability {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  openclaw: boolean;
  agy: boolean;
  /** cursor-agent, which also installs itself as `agent` and `cursor`. */
  cursor: boolean;
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
  const claude = commandExists('claude');
  // NOT commandExists: `npm install -g @openai/codex` and `brew install --cask
  // codex` both land outside a launchd daemon's PATH, so a bare probe reports
  // "not installed" on a machine that runs Codex every day — and the app's
  // picker then hides the harness entirely (DROVE-273).
  const codex = findCodexBin() !== undefined;
  const gemini = commandExists('gemini');
  const agy = findAgyBin() !== undefined;
  // NOT commandExists: the installer puts cursor-agent in ~/.local/bin, which
  // is not on the daemon's PATH, so a bare probe reports "not installed" on a
  // machine that runs Cursor every day.
  const cursor = findCursorBin() !== undefined;

  // OpenClaw: check command, config file, or env var
  const openclawCommand = commandExists('openclaw');
  const openclawConfig = existsSync(join(os.homedir(), '.openclaw', 'openclaw.json'));
  const openclawEnv = !!process.env.OPENCLAW_GATEWAY_URL;
  const openclaw = openclawCommand || openclawConfig || openclawEnv;

  return { claude, codex, gemini, openclaw, agy, cursor, detectedAt: Date.now() };
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

  const claude = checkCommand('claude');
  const codex = findCodexBin() !== undefined;
  const gemini = checkCommand('gemini');
  const agy = findAgyBin() !== undefined;
  const cursor = findCursorBin() !== undefined;

  // OpenClaw: check command, config file, or env var
  const openclawCommand = checkCommand('openclaw');
  const openclawConfig = existsSync(join(process.env.USERPROFILE || os.homedir(), '.openclaw', 'openclaw.json'));
  const openclawEnv = !!process.env.OPENCLAW_GATEWAY_URL;
  const openclaw = openclawCommand || openclawConfig || openclawEnv;

  return { claude, codex, gemini, openclaw, agy, cursor, detectedAt: Date.now() };
}
