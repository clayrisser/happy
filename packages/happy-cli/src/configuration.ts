/**
 * Global configuration for happy CLI
 * 
 * Centralizes all configuration including environment variables and paths
 * Environment files should be loaded using Node's --env-file flag
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json'

import { resolveServerUrls, type DroverServerMode } from './serverUrl'

// The server chain lives in ./serverUrl (DROVE-389); these are the names the
// rest of the CLI has always imported from here.
export { hostedServerUrl, hostedWebappUrl, resolveDroverServer, resolveServerUrls } from './serverUrl'
export type { DroverServer, DroverServerMode } from './serverUrl'


class Configuration {
  public readonly serverUrl: string
  public readonly webappUrl: string
  /** Which relay the URLs above came from, for `drover server` and the doctor. */
  public readonly serverMode: DroverServerMode
  public readonly isDaemonProcess: boolean

  // Directories and paths (from persistence)
  public readonly happyHomeDir: string
  public readonly logsDir: string
  public readonly settingsFile: string
  public readonly privateKeyFile: string
  public readonly daemonStateFile: string
  public readonly daemonLockFile: string
  public readonly sessionsFile: string
  public readonly currentCliVersion: string

  public readonly isExperimentalEnabled: boolean
  public readonly disableCaffeinate: boolean
  public readonly bootHappyAgent: boolean

  constructor() {
    // Check if we're running as daemon based on process args
    const args = process.argv.slice(2)
    this.isDaemonProcess = args.length >= 2 && args[0] === 'daemon' && (args[1] === 'start-sync')

    // Directory configuration - Priority: HAPPY_HOME_DIR env > default home dir
    if (process.env.HAPPY_HOME_DIR) {
      // Expand ~ to home directory if present
      const expandedPath = process.env.HAPPY_HOME_DIR.replace(/^~/, homedir())
      this.happyHomeDir = expandedPath
    } else {
      this.happyHomeDir = join(homedir(), '.happy')
    }

    this.logsDir = join(this.happyHomeDir, 'logs')
    this.settingsFile = join(this.happyHomeDir, 'settings.json')
    this.privateKeyFile = join(this.happyHomeDir, 'access.key')
    this.daemonStateFile = join(this.happyHomeDir, 'daemon.state.json')
    this.daemonLockFile = join(this.happyHomeDir, 'daemon.state.json.lock')
    this.sessionsFile = join(this.happyHomeDir, 'sessions.json')

    // URL precedence (all three): HAPPY_*_URL env > the drover server MODE >
    // settings.<key> > default.
    // Settings are read sync here (avoid circular import with persistence.ts).
    // webappUrl must follow the same chain as serverUrl, otherwise `happy server`
    // self-host points the API at localhost but auth still opens the prod webapp.
    //
    // The mode sits ABOVE settings.json and BELOW an explicit URL (DROVE-332).
    // Above settings, because the mode is the machine's statement about which
    // relay it is on and settings.json lives inside the mode's own happy home,
    // so a stale serverUrl there must not drag a switched machine back. Below
    // HAPPY_SERVER_URL, because that is what the drover wrappers export from
    // this same mode — the two always agree, and anyone setting the variable by
    // hand means it.
    //
    // A relay serves the exported web app from its own origin, so webappUrl
    // follows the mode to the same place rather than opening app.happy.engineering
    // against a server that has never heard of the account.
    const resolved = resolveServerUrls(
      process.env,
      (key) => readSettingsStringSync(this.settingsFile, key),
    )
    this.serverMode = resolved.mode
    this.serverUrl = resolved.serverUrl
    this.webappUrl = resolved.webappUrl

    this.isExperimentalEnabled = ['true', '1', 'yes'].includes(process.env.HAPPY_EXPERIMENTAL?.toLowerCase() || '');
    this.disableCaffeinate = ['true', '1', 'yes'].includes(process.env.HAPPY_DISABLE_CAFFEINATE?.toLowerCase() || '');
    // Happy Agent is a second machine-level daemon with its own database and its own
    // registration on the Happy account, so starting it is opted into rather than
    // inherited by everyone who upgrades the CLI.
    this.bootHappyAgent =
      ['true', '1', 'yes'].includes(process.env.HAPPY_BOOT_AGENT?.toLowerCase() || '') ||
      this.isExperimentalEnabled;

    this.currentCliVersion = packageJson.version

    // Visual indicator on CLI startup (only if not daemon process to avoid log clutter)
    const variant = process.env.HAPPY_VARIANT || 'stable'
    if (!this.isDaemonProcess && variant === 'dev') {
      console.log('\x1b[33m🔧 DEV MODE\x1b[0m - Data: ' + this.happyHomeDir)
    }

    if (!existsSync(this.happyHomeDir)) {
      mkdirSync(this.happyHomeDir, { recursive: true })
    }
    // Ensure directories exist
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true })
    }
  }
}

function readSettingsStringSync(settingsFile: string, key: 'serverUrl' | 'webappUrl'): string | undefined {
  try {
    if (!existsSync(settingsFile)) return undefined
    const raw = JSON.parse(readFileSync(settingsFile, 'utf8'))
    const value = raw?.[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

export const configuration: Configuration = new Configuration()
