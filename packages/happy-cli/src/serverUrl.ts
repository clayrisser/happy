/**
 * Which Happy server this machine talks to (DROVE-332), as pure functions.
 *
 * Split out of configuration.ts (DROVE-389) so a verb that must not construct
 * the configuration singleton — `drover sessions` and `drover stale-sessions`
 * are tested with that module mocked to THROW on import, because importing it
 * reads the happy home and makes a logs/ directory — can still answer "which
 * server" the way every other part of the CLI answers it. Nothing here reads a
 * file or the process env on its own; configuration.ts re-exports all of it.
 */

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
