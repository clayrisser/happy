/**
 * Generate temporary settings file with Claude hooks for session tracking
 * 
 * Creates a settings.json file that configures Claude's SessionStart hook
 * to notify our HTTP server when sessions change (new session, resume, compact, etc.)
 */

import { join, resolve } from 'node:path';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { projectPath } from '@/projectPath';
import { droverHooks, mergeHooks } from '@/drover/hooks';
import { preCompactHookPath, sessionStartHookPath } from './startHookServer';

/**
 * Generate a temporary settings file with SessionStart hook configuration
 * 
 * @param port - The port where Happy server is listening
 * @returns Path to the generated settings file
 */
export function generateHookSettingsFile(port: number): string {
    const hooksDir = join(configuration.happyHomeDir, 'tmp', 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    // Unique filename per process to avoid conflicts
    const filename = `session-hook-${process.pid}.json`;
    const filepath = join(hooksDir, filename);

    // Path to the hook forwarder script
    const forwarderScript = resolve(projectPath(), 'scripts', 'session_hook_forwarder.cjs');
    const hookCommand = `node "${forwarderScript}" ${port} ${sessionStartHookPath}`;
    // DROVE-257: the one signal that a compaction has STARTED. Everything else
    // about a compaction is invisible from outside the pane — the transcript
    // does not move for the whole pass and the fd 3 fetch counter drops at the
    // response headers — so without this hook the phone draws a session
    // rewriting its own history as connected and idle.
    const preCompactCommand = `node "${forwarderScript}" ${port} ${preCompactHookPath}`;

    // Cattle Drover (BASED-98): the bus producers ride along here, so a
    // question, an idle notice or a session's lifecycle reaches the phone,
    // the watch and tmux for sessions DROVER started, and only those. See
    // drover/hooks.ts for why this is not registered globally.
    const settings = {
        hooks: mergeHooks(
            {
                SessionStart: [
                    {
                        matcher: "*",
                        hooks: [
                            {
                                type: "command" as const,
                                command: hookCommand
                            }
                        ]
                    }
                ],
                // Both triggers: `manual` is a typed `/compact`, `auto` is the
                // context filling up, and the dot means the same thing for
                // either. Claude Code matches this field against the trigger.
                PreCompact: [
                    {
                        matcher: "*",
                        hooks: [
                            {
                                type: "command" as const,
                                command: preCompactCommand
                            }
                        ]
                    }
                ]
            },
            droverHooks()
        )
    };

    writeFileSync(filepath, JSON.stringify(settings, null, 2));
    logger.debug(`[generateHookSettings] Created hook settings file: ${filepath}`);

    return filepath;
}

/**
 * Clean up the temporary hook settings file
 * 
 * @param filepath - Path to the settings file to remove
 */
export function cleanupHookSettingsFile(filepath: string): void {
    try {
        if (existsSync(filepath)) {
            unlinkSync(filepath);
            logger.debug(`[generateHookSettings] Cleaned up hook settings file: ${filepath}`);
        }
    } catch (error) {
        logger.debug(`[generateHookSettings] Failed to cleanup hook settings file: ${error}`);
    }
}

