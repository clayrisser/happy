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

/**
 * Which relay this machine is on (DROVE-332). Drover stopped piggybacking on
 * Happy's hosted server, so `serverUrl` is no longer one hardcoded default with
 * an escape hatch: it is a MODE, and the mode is the same word the shell side
 * uses (etc/drover.env in cattle-drover).
 *
 *   hosted — upstream's api.cluster-fluster.com. The default, and it stays the
 *            default until the estate relay exists.
 *   estate — the drover relay on Clay's estate, DROVER_ESTATE_URL.
 *   local  — the self-host relay this Mac runs, DROVER_RELAY_URL.
 */
export type DroverServerMode = 'hosted' | 'estate' | 'local'

export interface DroverServer {
  mode: DroverServerMode
  /** The URL the mode names, or undefined for hosted — which has none of its own. */
  url: string | undefined
  /** Set when the environment named a mode that cannot be honoured. */
  problem: string | undefined
}

export const hostedServerUrl = 'https://api.cluster-fluster.com'
export const hostedWebappUrl = 'https://app.happy.engineering'

/**
 * The mode word this environment carries, canonicalized. `official` and `relay`
 * are the OLD spellings of hosted and local and keep working, because they are
 * written into the local.env of every machine drover has already installed.
 * An unknown word is a problem, never a silent hosted.
 */
export function resolveDroverServer(env: NodeJS.ProcessEnv = process.env): DroverServer {
  const word = (env.DROVER_SERVER_MODE || '').trim().toLowerCase()
  const estateUrl = (env.DROVER_ESTATE_URL || '').trim()
  const relayUrl = (env.DROVER_RELAY_URL || '').trim()
  switch (word) {
    case '':
    case 'hosted':
    case 'official':
      return { mode: 'hosted', url: undefined, problem: undefined }
    case 'local':
    case 'relay':
      return {
        mode: 'local',
        url: relayUrl || 'http://127.0.0.1:7971',
        problem: undefined,
      }
    case 'estate':
      // Fail closed, the same rule the rest of this chain follows: a server
      // that was configured and cannot be resolved must not quietly become
      // the hosted one. A machine Clay moved off the hosted server stays off.
      return {
        mode: 'estate',
        url: estateUrl || undefined,
        problem: estateUrl
          ? undefined
          : 'DROVER_SERVER_MODE=estate but DROVER_ESTATE_URL is unset — the estate relay has no address yet',
      }
    default:
      return {
        mode: 'hosted',
        url: undefined,
        problem: `unknown DROVER_SERVER_MODE '${env.DROVER_SERVER_MODE}' — the modes are hosted, estate and local`,
      }
  }
}

/**
 * The whole `serverUrl` / `webappUrl` chain, as a function, so the precedence is
 * something a test can state rather than something you have to construct the
 * singleton to observe.
 *
 * Precedence: HAPPY_*_URL env > the drover server MODE > settings.<key> > the
 * hosted default.
 *
 * The mode sits ABOVE settings.json because the mode is the machine's statement
 * about which relay it is on, and settings.json lives inside the mode's OWN
 * happy home — a stale serverUrl there must not drag a switched machine back.
 * It sits BELOW HAPPY_SERVER_URL because that is what the drover wrappers
 * export from this same mode, so the two always agree, and anyone setting the
 * variable by hand means it.
 *
 * A relay serves the exported web app from its own origin, so webappUrl follows
 * the mode to the same place rather than opening app.happy.engineering against
 * a server that has never heard of the account.
 *
 * A mode that cannot be honoured THROWS, before anything connects. The
 * alternative is a CLI that registers this machine on the hosted server after
 * Clay moved it off — the exact quiet failure the cutover has to not have. An
 * explicit HAPPY_SERVER_URL answers the question on its own, so it is allowed
 * to stand even then.
 */
export function resolveServerUrls(
  env: NodeJS.ProcessEnv,
  settings: (key: 'serverUrl' | 'webappUrl') => string | undefined,
): { mode: DroverServerMode; serverUrl: string; webappUrl: string } {
  const server = resolveDroverServer(env)
  if (server.problem && !env.HAPPY_SERVER_URL) {
    throw new Error(
      `drover: ${server.problem}\n`
      + '  Fix it with: drover server hosted | estate <url> | local',
    )
  }
  return {
    mode: server.mode,
    serverUrl: env.HAPPY_SERVER_URL || server.url || settings('serverUrl') || hostedServerUrl,
    webappUrl: env.HAPPY_WEBAPP_URL || server.url || settings('webappUrl') || hostedWebappUrl,
  }
}

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
