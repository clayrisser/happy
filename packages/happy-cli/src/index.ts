#!/usr/bin/env node

/**
 * CLI entry point for the drover command
 * 
 * Simple argument parsing without any CLI framework dependencies
 */


// DROVE-288: the entry stays import-light on purpose. Every verb dynamic-
// imports its own arm below the dispatch, so `pick-account` (run before EVERY
// session start) and `--version` (the daemon's version probe) stop paying ~2s
// of bundle-wide import cost to read a few JSON files. pkgroll code-splits
// each `await import()` into its own chunk; only what a verb actually touches
// is compiled. Keep it that way: a static import added here is paid by every
// invocation of every verb.
import chalk from 'chalk'
import { execFileSync } from 'node:child_process'
import packageJson from '../package.json'
import { extractNoSandboxFlag } from './utils/sandboxFlags'
import type { StartOptions } from '@/claude/runClaude'


(async () => {
  const args = process.argv.slice(2)

  // Check if first argument is a subcommand
  const subcommand = args[0]

  // The harness LAUNCHERS in node (DROVE-315 wave 3a). cattle-drover's
  // libexec/drover-{codex,cursor,pi} are the PREFLIGHT in front of the runners
  // further down this file — open the pane, name the missing binary, resolve
  // the account token, turn a bare --resume into an id — and they are ported
  // into src/drover/cli. Those three names are already arms below, so the
  // generic verb dispatch (which sits under every one of them) can never reach
  // them; this is the handover switch instead. Shell stays authoritative until
  // the node path is proven, and DROVER_NODE_LAUNCHERS=1 routes to it. Lazy by
  // construction: nothing loads unless the switch is on AND the name matches,
  // so --version and a session start pay nothing (DROVE-314).
  //
  // opencode, tmux-enter, clone and the pickers need no switch — they are not
  // arms here, so they fall through to the table like every other ported verb.
  if (process.env.DROVER_NODE_LAUNCHERS === '1'
    && (subcommand === 'codex' || subcommand === 'cursor' || subcommand === 'pi')) {
    const { runDroverVerb } = await import('./drover/cli')
    const code = await runDroverVerb(subcommand, args.slice(1))
    if (code !== null) {
      const { flushExit } = await import('./drover/cli/exit')
      await flushExit(code)
    }
  }

  // DROVE-314: read-only verbs must not pay the session-supervisor cost.
  // `drover --version` (the daemon's version probe, run constantly) and
  // `drover --help` are pure reads, but when they fall through to the main
  // branch below they load persistence, the auth/api layer and runClaude just
  // to print a string — ~680ms of bundle-load waste on Clay's machine, paid on
  // every probe. This is DROVE-288's insight (a read verb needs no supervisor)
  // applied to the two verbs that still went the long way. When the flag IS the
  // invocation, answer it here and exit before anything heavy loads. A flag
  // mixed with other args (e.g. `drover --model x --version`, or `drover claude
  // --help`) still flows through the main parser and is forwarded to Claude as
  // before — only chalk and the version string, both already loaded, are
  // touched here.
  if (subcommand === '--version' || subcommand === '-v') {
    console.log(`drover version: ${packageJson.version}`)
    process.exit(0)
  }
  if (subcommand === '--help' || subcommand === '-h') {
    printDroverHelp()
    console.log(chalk.gray('Run `claude --help` to see all Claude Code options.'))
    process.exit(0)
  }

  // If --version is passed - do not log, its likely daemon inquiring about our
  // version. pick-account runs before EVERY session start (DROVE-21) and would
  // otherwise leave a one-line log file per start.
  if (!args.includes('--version') && subcommand !== 'pick-account') {
    const { logger } = await import('./ui/logger')
    logger.debug('Starting drover CLI with args: ', process.argv)
  }

  if (subcommand === 'pick-account') {
    // Cattle Drover (DROVE-21): which account should a session START on?
    // The verb body lives in commands/pickAccount so this hot path (it runs
    // before EVERY session start) loads only the registry, the cooldown
    // ledger and the resume-id parser (DROVE-288).
    const { handlePickAccountCommand } = await import('./commands/pickAccount')
    await handlePickAccountCommand(args.slice(1))
  }

  if (subcommand === 'doctor') {
    // Check for clean subcommand
    if (args[1] === 'clean') {
      if (args.slice(2).some(a => a === '--help' || a === '-h')) {
        console.log(`
${chalk.bold('drover doctor clean')} - Kill all drover-related processes (daemon + sessions)

${chalk.bold('Usage:')}
  drover doctor clean

${chalk.bold('Warning:')} This is destructive — it terminates the daemon and every running session.
Conversation history is preserved on the server, but in-flight tool calls are interrupted.
`)
        process.exit(0)
      }
      const { killRunawayHappyProcesses } = await import('./daemon/doctor')
      const result = await killRunawayHappyProcesses()
      console.log(`Cleaned up ${result.killed} runaway processes`)
      if (result.errors.length > 0) {
        console.log('Errors:', result.errors)
      }
      process.exit(0)
    }
    const { runDoctorCommand } = await import('./ui/doctor')
    await runDoctorCommand();
    return;
  } else if (subcommand === 'auth') {
    // Handle auth subcommands
    try {
      const { handleAuthCommand } = await import('./commands/auth')
      await handleAuthCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'connect') {
    // Handle connect subcommands
    try {
      const { handleConnectCommand } = await import('./commands/connect')
      await handleConnectCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'sandbox') {
    try {
      const { handleSandboxCommand } = await import('./commands/sandbox')
      await handleSandboxCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'server') {
    try {
      const { handleServerCommand } = await import('./commands/server')
      await handleServerCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'drover-bridge' || subcommand === 'bridge') {
    // Cattle Drover bridge (BASED-98): makes the app a surface on the local
    // prompt bus. Long-running; typically supervised by launchd/systemd.
    //
    // `bridge` is the name a person types; `drover-bridge` is kept because the
    // installed launchd units and the wrapper script have used it since the
    // stack was first bootstrapped, and a service verb that stops resolving is
    // a stack that silently does not come back after a reboot.
    try {
      const { runDroverBridge } = await import('@/drover/droverBridge');
      await runDroverBridge();
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'bye') {
    console.log('Bye!');
    process.exit(0);
  } else if (subcommand === 'resume') {
    try {
      const { handleResumeCommand } = await import('@/resume/handleResumeCommand')
      await handleResumeCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'codex') {
    // Handle codex command
    try {
      const { handleCodexCommand } = await import('./commands/codexCommand')
      await handleCodexCommand(args.slice(1));
      // Do not force exit here; allow instrumentation to show lingering handles
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'gemini') {
    // Handle gemini subcommands
    const geminiSubcommand = args[1];
    
    // Handle "drover gemini model set <model>" command
    if (geminiSubcommand === 'model' && args[2] === 'set' && args[3]) {
      const modelName = args[3];
      const validModels = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
      
      if (!validModels.includes(modelName)) {
        console.error(`Invalid model: ${modelName}`);
        console.error(`Available models: ${validModels.join(', ')}`);
        process.exit(1);
      }
      
      try {
        const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs');
        const { join } = require('path');
        const { homedir } = require('os');
        
        const configDir = join(homedir(), '.gemini');
        const configPath = join(configDir, 'config.json');
        
        // Create directory if it doesn't exist
        if (!existsSync(configDir)) {
          mkdirSync(configDir, { recursive: true });
        }
        
        // Read existing config or create new one
        let config: any = {};
        if (existsSync(configPath)) {
          try {
            config = JSON.parse(readFileSync(configPath, 'utf-8'));
          } catch (error) {
            // Ignore parse errors, start fresh
            config = {};
          }
        }
        
        // Update model in config
        config.model = modelName;
        
        // Write config back
        writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
        console.log(`✓ Model set to: ${modelName}`);
        console.log(`  Config saved to: ${configPath}`);
        console.log(`  This model will be used in future sessions.`);
        process.exit(0);
      } catch (error) {
        console.error('Failed to save model configuration:', error);
        process.exit(1);
      }
    }
    
    // Handle "drover gemini model get" command
    if (geminiSubcommand === 'model' && args[2] === 'get') {
      try {
        const { existsSync, readFileSync } = require('fs');
        const { join } = require('path');
        const { homedir } = require('os');
        
        const configPaths = [
          join(homedir(), '.gemini', 'config.json'),
          join(homedir(), '.config', 'gemini', 'config.json'),
        ];
        
        let model: string | null = null;
        for (const configPath of configPaths) {
          if (existsSync(configPath)) {
            try {
              const config = JSON.parse(readFileSync(configPath, 'utf-8'));
              model = config.model || config.GEMINI_MODEL || null;
              if (model) break;
            } catch (error) {
              // Ignore parse errors
            }
          }
        }
        
        if (model) {
          console.log(`Current model: ${model}`);
        } else if (process.env.GEMINI_MODEL) {
          console.log(`Current model: ${process.env.GEMINI_MODEL} (from GEMINI_MODEL env var)`);
        } else {
          console.log('Current model: gemini-2.5-pro (default)');
        }
        process.exit(0);
      } catch (error) {
        console.error('Failed to read model configuration:', error);
        process.exit(1);
      }
    }
    
    // Handle "drover gemini project set <project-id>" command
    if (geminiSubcommand === 'project' && args[2] === 'set' && args[3]) {
      const projectId = args[3];
      
      try {
        const { saveGoogleCloudProjectToConfig } = await import('@/gemini/utils/config');
        const { readCredentials } = await import('@/persistence');
        const { ApiClient } = await import('@/api/api');
        
        // Try to get current user email from Cattle Drover cloud token
        let userEmail: string | undefined = undefined;
        try {
          const credentials = await readCredentials();
          if (credentials) {
            const api = await ApiClient.create(credentials);
            const vendorToken = await api.getVendorToken('gemini');
            if (vendorToken?.oauth?.id_token) {
              const parts = vendorToken.oauth.id_token.split('.');
              if (parts.length === 3) {
                const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
                userEmail = payload.email;
              }
            }
          }
        } catch {
          // If we can't get email, project will be saved globally
        }
        
        saveGoogleCloudProjectToConfig(projectId, userEmail);
        console.log(`✓ Google Cloud Project set to: ${projectId}`);
        if (userEmail) {
          console.log(`  Linked to account: ${userEmail}`);
        }
        console.log(`  This project will be used for Google Workspace accounts.`);
        process.exit(0);
      } catch (error) {
        console.error('Failed to save project configuration:', error);
        process.exit(1);
      }
    }
    
    // Handle "drover gemini project get" command
    if (geminiSubcommand === 'project' && args[2] === 'get') {
      try {
        const { readGeminiLocalConfig } = await import('@/gemini/utils/config');
        const config = readGeminiLocalConfig();
        
        if (config.googleCloudProject) {
          console.log(`Current Google Cloud Project: ${config.googleCloudProject}`);
          if (config.googleCloudProjectEmail) {
            console.log(`  Linked to account: ${config.googleCloudProjectEmail}`);
          } else {
            console.log(`  Applies to: all accounts (global)`);
          }
        } else if (process.env.GOOGLE_CLOUD_PROJECT) {
          console.log(`Current Google Cloud Project: ${process.env.GOOGLE_CLOUD_PROJECT} (from env var)`);
        } else {
          console.log('No Google Cloud Project configured.');
          console.log('');
          console.log('If you see "Authentication required" error, you may need to set a project:');
          console.log('  drover gemini project set <your-project-id>');
          console.log('');
          console.log('This is required for Google Workspace accounts.');
          console.log('Guide: https://goo.gle/gemini-cli-auth-docs#workspace-gca');
        }
        process.exit(0);
      } catch (error) {
        console.error('Failed to read project configuration:', error);
        process.exit(1);
      }
    }
    
    // Handle "drover gemini project" (no subcommand) - show help
    if (geminiSubcommand === 'project' && !args[2]) {
      console.log('Usage: drover gemini project <command>');
      console.log('');
      console.log('Commands:');
      console.log('  set <project-id>   Set Google Cloud Project ID');
      console.log('  get                Show current Google Cloud Project ID');
      console.log('');
      console.log('Google Workspace accounts require a Google Cloud Project.');
      console.log('If you see "Authentication required" error, set your project ID.');
      console.log('');
      console.log('Guide: https://goo.gle/gemini-cli-auth-docs#workspace-gca');
      process.exit(0);
    }
    
    // Handle gemini command (ACP-based agent)
    try {
      // The standalone gemini CLI is EOL; agy (Antigravity CLI) is its successor.
      console.warn(chalk.yellow('⚠ The gemini backend is deprecated and may be removed in a future release. Use `drover agy` (Antigravity CLI) instead.'));

      const { runGemini } = await import('@/gemini/runGemini');

      // Parse startedBy argument
      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--started-by') {
          startedBy = args[++i] as 'daemon' | 'terminal';
        }
      }
      
      const { credentials } = await authAndEnsureDaemon();

      await runGemini({credentials, startedBy});
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'acp') {
    try {
      const { runAcp, resolveAcpAgentConfig } = await import('@/agent/acp');

      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      let verbose = false;
      const acpArgs: string[] = [];
      let customCommandMode = false;
      for (let i = 1; i < args.length; i++) {
        if (!customCommandMode && args[i] === '--started-by') {
          startedBy = args[++i] as 'daemon' | 'terminal';
          continue;
        }
        if (!customCommandMode && args[i] === '--verbose') {
          verbose = true;
          continue;
        }
        if (args[i] === '--') {
          customCommandMode = true;
        }
        acpArgs.push(args[i]);
      }

      const resolved = resolveAcpAgentConfig(acpArgs);
      const { credentials } = await authAndEnsureDaemon();

      await runAcp({
        credentials,
        startedBy,
        verbose,
        agentName: resolved.agentName,
        command: resolved.command,
        args: resolved.args,
      });
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'openclaw') {
    try {
      const { runOpenClaw } = await import('@/openclaw/runOpenClaw');

      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      let verbose = false;
      let gatewayUrl: string | undefined;
      let gatewayToken: string | undefined;
      let gatewayPassword: string | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--started-by') {
          startedBy = args[++i] as 'daemon' | 'terminal';
        } else if (args[i] === '--verbose') {
          verbose = true;
        } else if (args[i] === '--gateway-url') {
          gatewayUrl = args[++i];
        } else if (args[i] === '--gateway-token') {
          gatewayToken = args[++i];
        } else if (args[i] === '--gateway-password') {
          gatewayPassword = args[++i];
        }
      }

      const { credentials } = await authAndEnsureDaemon();

      await runOpenClaw({
        credentials,
        startedBy,
        verbose,
        gatewayUrl,
        gatewayToken,
        gatewayPassword,
      });
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'cursor') {
    // A Cursor agent session (DROVE-57). The daemon spawns this in a tmux
    // window through the drover wrapper, exactly as it does `claude`.
    try {
      const { runCursor } = await import('@/cursor/runCursor');

      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      let model: string | null = null;
      let resumeChatId: string | null = null;
      let permissionMode: string | null = null;
      // Set by `drover cursor --gate`, which is what actually registers the
      // hook. The runner cannot check for itself: hooks live in
      // ~/.cursor/hooks.json and belong to the whole machine, so their
      // presence says nothing about whether THIS session put them there.
      let gated = false;
      // `drover clone --to cursor` and the phone's clone action both land
      // here (DROVE-337). The FILE travels, never its contents.
      let seedFile: string | null = null;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--started-by') {
          startedBy = args[++i] as 'daemon' | 'terminal';
        } else if (args[i] === '--model') {
          model = args[++i] ?? null;
        } else if (args[i] === '--resume') {
          resumeChatId = args[++i] ?? null;
        } else if (args[i] === '--permission-mode') {
          permissionMode = args[++i] ?? null;
        } else if (args[i] === '--gated') {
          gated = true;
        } else if (args[i] === '--seed') {
          seedFile = args[++i] ?? null;
        } else if (args[i]?.startsWith('--seed=')) {
          seedFile = args[i].slice('--seed='.length);
        }
      }

      const { credentials } = await authAndEnsureDaemon();

      await runCursor({ credentials, startedBy, model, resumeChatId, permissionMode, gated, seedFile });
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'pi') {
    // A pi session (DROVE-316). pi is the LOCAL-model harness — LM Studio and
    // a local GLM, not a cloud login — and this is the runner that lets the
    // daemon spawn one from the phone's picker. DROVE-295 built everything
    // around it and stopped exactly here, because listing a harness the daemon
    // cannot spawn is a tap that opens a window and then fails.
    try {
      const { runPi } = await import('@/pi/runPi');

      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      let model: string | null = null;
      let thinking: string | null = null;
      let resumeSessionId: string | null = null;
      let gate = true;
      let seedFile: string | null = null;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--started-by') {
          startedBy = args[++i] as 'daemon' | 'terminal';
        } else if (args[i] === '--seed') {
          seedFile = args[++i] ?? null;
        } else if (args[i] === '--model') {
          model = args[++i] ?? null;
        } else if (args[i] === '--thinking' || args[i] === '--effort') {
          // `--effort` because that is what appendDaemonSpawnModeArgs spells
          // the app's thought-level pick, and pi calls the same axis thinking.
          thinking = args[++i] ?? null;
        } else if (args[i] === '--resume') {
          resumeSessionId = args[++i] ?? null;
        } else if (args[i] === '--no-gate') {
          gate = false;
        } else if (args[i] === '--no-extensions' || args[i] === '-ne') {
          // Refused here as well as in piArgs.ts, so the message names the
          // reason rather than letting pi answer `Unknown provider "lmstudio"`
          // three layers down. The local model providers ARE extensions.
          console.error(chalk.red('Error:'), 'drover pi: --no-extensions takes the LOCAL MODELS down with it.');
          console.error('  The lmstudio and glm providers are pi extensions, so pi refuses to start.');
          process.exit(2);
        }
      }

      const { credentials } = await authAndEnsureDaemon();

      await runPi({ credentials, startedBy, model, thinking, resumeSessionId, gate, seedFile });
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'agy') {
    try {
      const { runAgy } = await import('@/agy/runAgy');

      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      let verbose = false;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--started-by') {
          startedBy = args[++i] as 'daemon' | 'terminal';
        } else if (args[i] === '--verbose') {
          verbose = true;
        }
      }

      const { credentials } = await authAndEnsureDaemon();

      await runAgy({
        credentials,
        startedBy,
        verbose,
      });
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'logout') {
    // Keep for backward compatibility - redirect to auth logout
    console.log(chalk.yellow('Note: "drover logout" is deprecated. Use "drover auth logout" instead.\n'));
    try {
      const { handleAuthCommand } = await import('./commands/auth')
      await handleAuthCommand(['logout']);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'notify') {
    // Handle notification command
    try {
      await handleNotifyCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'daemon') {
    // Show daemon management help
    const daemonSubcommand = args[1]

    if (daemonSubcommand === 'list') {
      try {
        const { listDaemonSessions } = await import('./daemon/controlClient')
        const sessions = await listDaemonSessions()

        if (sessions.length === 0) {
          console.log('No active sessions this daemon is aware of (they might have been started by a previous version of the daemon)')
        } else {
          console.log('Active sessions:')
          console.log(JSON.stringify(sessions, null, 2))
        }
      } catch (error) {
        console.log('No daemon running')
      }
      return

    } else if (daemonSubcommand === 'stop-session') {
      const sessionId = args[2]
      if (!sessionId) {
        console.error('Session ID required')
        process.exit(1)
      }

      try {
        const { stopDaemonSession } = await import('./daemon/controlClient')
        const success = await stopDaemonSession(sessionId)
        console.log(success ? 'Session stopped' : 'Failed to stop session')
      } catch (error) {
        console.log('No daemon running')
      }
      return

    } else if (daemonSubcommand === 'start') {
      // Spawn detached daemon process
      const [{ spawnHappyCLI }, { sanitizeSessionEnvironment }, { checkIfDaemonRunningAndCleanupStaleState }] = await Promise.all([
        import('./utils/spawnHappyCLI'),
        import('./daemon/sessionEnvironment'),
        import('./daemon/controlClient'),
      ])
      const child = spawnHappyCLI(['daemon', 'start-sync'], {
        detached: true,
        stdio: 'ignore',
        env: sanitizeSessionEnvironment(process.env)
      });
      child.unref();

      // Wait for daemon to write state file (up to 5 seconds)
      let started = false;
      for (let i = 0; i < 50; i++) {
        if (await checkIfDaemonRunningAndCleanupStaleState()) {
          started = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (started) {
        console.log('Daemon started successfully');
      } else {
        console.error('Failed to start daemon');
        process.exit(1);
      }
      process.exit(0);
    } else if (daemonSubcommand === 'start-sync') {
      const { startDaemon } = await import('./daemon/run')
      await startDaemon()
      process.exit(0)
    } else if (daemonSubcommand === 'stop') {
      const { stopDaemon } = await import('./daemon/controlClient')
      await stopDaemon()
      process.exit(0)
    } else if (daemonSubcommand === 'status') {
      const { runDoctorDaemon } = await import('./ui/doctor')
      await runDoctorDaemon()
      process.exit(0)
    } else if (daemonSubcommand === 'logs') {
      // Simply print the path to the latest daemon log file
      const { getLatestDaemonLog } = await import('./ui/logger')
      const latest = await getLatestDaemonLog()
      if (!latest) {
        console.log('No daemon logs found')
      } else {
        console.log(latest.path)
      }
      process.exit(0)
    } else if (daemonSubcommand === 'install') {
      try {
        const { install } = await import('./daemon/install')
        await install()
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
        process.exit(1)
      }
    } else if (daemonSubcommand === 'uninstall') {
      try {
        const { uninstall } = await import('./daemon/uninstall')
        await uninstall()
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
        process.exit(1)
      }
    } else {
      console.log(`
${chalk.bold('drover daemon')} - Daemon management

${chalk.bold('Usage:')}
  drover daemon start              Start the daemon (detached)
  drover daemon stop               Stop the daemon (sessions stay alive)
  drover daemon status             Show daemon status
  drover daemon list               List active sessions

  If you want to kill all drover related processes run 
  ${chalk.cyan('drover doctor clean')}

${chalk.bold('Note:')} The daemon runs in the background and manages Claude sessions.

${chalk.bold('To clean up runaway processes:')} Use ${chalk.cyan('drover doctor clean')}
`)
    }
    return;
  } else {

    // DROVE-315: a drover verb that has moved into node. bin/drover routes the
    // live name to libexec/ until that verb's arm is flipped there (other lanes
    // own the flip), so in production this branch is not reached for a ported
    // verb yet; `drover.mjs <verb>` reaches it directly, which is how the port
    // is run and tested. Lazy on purpose (DROVE-288/314): the table is its own
    // chunk that loads only after every fork subcommand above has declined, and
    // the verb's module loads only when the name is one the table carries — so a
    // bare `drover` session start (no subcommand) and a `drover claude ...` or a
    // flag never touch either. flushExit drains stdout first, because a big
    // `--json` is written past node's 64KiB pipe buffer and process.exit drops
    // the rest (engine/mcp.js learned this the hard way).
    if (subcommand && !subcommand.startsWith('-') && subcommand !== 'claude') {
      const { runDroverVerb } = await import('./drover/cli')
      const code = await runDroverVerb(subcommand, args.slice(1))
      if (code !== null) {
        const { flushExit } = await import('./drover/cli/exit')
        await flushExit(code)
      }
    }

    // If the first argument is claude, remove it
    if (args.length > 0 && args[0] === 'claude') {
      args.shift()
    }

    // Parse command line arguments for main command
    const { z } = await import('zod')
    const options: StartOptions = {}
    let showHelp = false
    let showVersion = false
    let chromeOverride: boolean | undefined = undefined  // Track explicit --chrome or --no-chrome
    const unknownArgs: string[] = [] // Collect unknown args to pass through to claude
    const parsedSandboxFlag = extractNoSandboxFlag(args)
    options.noSandbox = parsedSandboxFlag.noSandbox
    args.length = 0
    args.push(...parsedSandboxFlag.args)

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]

      if (arg === '-h' || arg === '--help') {
        showHelp = true
        // Also pass through to claude
        unknownArgs.push(arg)
      } else if (arg === '-v' || arg === '--version') {
        showVersion = true
        // Also pass through to claude (will show after our version)
        unknownArgs.push(arg)
      } else if (arg === '--happy-starting-mode') {
        options.startingMode = z.enum(['local', 'remote']).parse(args[++i])
      } else if (arg === '--yolo') {
        // Shortcut for --dangerously-skip-permissions
        unknownArgs.push('--dangerously-skip-permissions')
      } else if (arg === '--managed') {
        // The session's kind (DROVE-388): the relay holds its key too.
        options.managed = true
      } else if (arg === '--private') {
        options.managed = false
      } else if (arg === '--model') {
        options.model = args[++i]
      } else if (arg === '--permission-mode') {
        options.permissionMode = args[++i] as StartOptions['permissionMode']
      } else if (arg === '--effort') {
        options.effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']).parse(args[++i])
      } else if (arg === '--seed') {
        // The clone's seed (DROVE-58): a FILE holding the first prompt.
        // `drover clone` writes one and `bin/drover` passes the path through,
        // because a seed is tens of kilobytes and a command line is where one
        // stray quote turns it into a syntax error. Read here, handed to the
        // first child only.
        options.seedFile = args[++i]
      } else if (arg === '--started-by') {
        options.startedBy = args[++i] as 'daemon' | 'terminal'
      } else if (arg === '--js-runtime') {
        const runtime = args[++i]
        if (runtime !== 'node' && runtime !== 'bun') {
          console.error(chalk.red(`Invalid --js-runtime value: ${runtime}. Must be 'node' or 'bun'`))
          process.exit(1)
        }
        options.jsRuntime = runtime
      } else if (arg === '--claude-env') {
        // Parse KEY=VALUE environment variable to pass to Claude
        const envArg = args[++i]
        if (envArg && envArg.includes('=')) {
          const eqIndex = envArg.indexOf('=')
          const key = envArg.substring(0, eqIndex)
          const value = envArg.substring(eqIndex + 1)
          options.claudeEnvVars = options.claudeEnvVars || {}
          options.claudeEnvVars[key] = value
        } else {
          console.error(chalk.red(`Invalid --claude-env format: ${envArg}. Expected KEY=VALUE`))
          process.exit(1)
        }
      } else if (arg === '--chrome') {
        chromeOverride = true
        // We'll add --chrome to claudeArgs after resolving settings default
      } else if (arg === '--no-chrome') {
        chromeOverride = false
        // Happy-specific flag to disable chrome even if default is on
      } else if (arg === '--settings') {
        // Intercept --settings flag - Happy uses this internally for session hooks
        const settingsValue = args[++i] // consume the value
        console.warn(chalk.yellow(`⚠️  Warning: --settings is used internally by Cattle Drover for session tracking.`))
        console.warn(chalk.yellow(`   Your settings file "${settingsValue}" will be ignored.`))
        console.warn(chalk.yellow(`   To configure Claude, edit ~/.claude/settings.json instead.`))
        // Don't pass through to claudeArgs
      } else {
        // Pass unknown arguments through to claude
        unknownArgs.push(arg)
        // Check if this arg expects a value (simplified check for common patterns)
        if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          unknownArgs.push(args[++i])
        }
      }
    }

    // Add unknown args to claudeArgs
    if (unknownArgs.length > 0) {
      options.claudeArgs = [...(options.claudeArgs || []), ...unknownArgs]
    }

    // Resolve Chrome mode: explicit flag > settings > false
    const { readSettings } = await import('./persistence')
    const settings = await readSettings()
    const chromeEnabled = chromeOverride ?? settings.chromeMode ?? false
    if (chromeEnabled) {
      options.claudeArgs = [...(options.claudeArgs || []), '--chrome']
    }

    // Show help. Bare `drover --help` is handled by the fast path at the top of
    // this file (DROVE-314); this branch only runs when --help arrives mixed
    // with a claude passthrough (e.g. `drover claude --help`), so it keeps the
    // slower `claude --help` append that spawns the claude binary.
    if (showHelp) {
      printDroverHelp()
      console.log(`
${chalk.gray('─'.repeat(60))}
${chalk.bold.cyan('Claude Code Options (from `claude --help`):')}
`)

      // Run claude --help and display its output
      // Use execFileSync directly with claude CLI for runtime-agnostic compatibility
      try {
        const { claudeCliPath } = await import('./claude/claudeLocal')
        const claudeHelp = execFileSync(claudeCliPath, ['--help'], { encoding: 'utf8', windowsHide: true })
        console.log(claudeHelp)
      } catch (e) {
        console.log(chalk.yellow('Could not retrieve claude help. Make sure claude is installed.'))
      }

      process.exit(0)
    }

    // Show version
    if (showVersion) {
      console.log(`drover version: ${packageJson.version}`)
      // Don't exit - continue to pass --version to Claude Code
    }

    // Normal flow - auth and machine setup
    const { credentials } = await authAndEnsureDaemon();

    // Start the CLI
    try {
      const { runClaude } = await import('@/claude/runClaude')
      await runClaude(credentials, options);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
  }
})();


/**
 * The drover-native help text. Kept synchronous and dependency-free (chalk and
 * packageJson are the entry's only eager imports) so `drover --help` can print
 * it and exit without loading persistence, the api layer or runClaude
 * (DROVE-314). The `claude --help` append lives at the call site, not here,
 * because it spawns the claude binary and only the mixed-args path wants it.
 */
function printDroverHelp(): void {
  console.log(`
${chalk.bold('drover')} - Cattle Drover · Claude Code on the go

${chalk.bold('Usage:')}
  drover [options]         Start Claude with mobile control
  drover auth              Manage authentication
  drover pair              QR-pair a phone or watch (= drover auth login)
  drover resume            Resume a previous Drover session by Drover session ID
  drover codex             Start Codex mode
  drover pi                Start a pi session (local models: LM Studio, GLM)
  drover gemini            Start Gemini mode (ACP) [deprecated — use agy]
  drover agy               Start agy (Antigravity CLI) mode
  drover acp               Start a generic ACP-compatible agent
  drover connect           Connect AI vendor API keys
  drover sandbox           Configure and manage OS-level sandboxing
  drover notify            Send push notification
  drover daemon            Manage background service that allows
                            to spawn new sessions away from your computer
  drover doctor            System diagnostics & troubleshooting

${chalk.bold('Also, from the wrapper (run `drover help` for the full list):')}
  drover status            Bus health, pending prompts, services
  drover sessions          What is running, where, on which account
  drover accounts          Accounts, which are cooling and until when
  drover account <name>    Run on that Claude subscription (short: -a <name>)
  drover flip [account]    Move this session to another account, keeping it
  drover bus|bridge|relay  The services launchd supervises

${chalk.bold('Examples:')}
  drover                    Start session
  drover resume cmmij8      Resume a previous session by Drover session ID
  drover --yolo             Start with bypassing permissions
                            drover sugar for --dangerously-skip-permissions
  drover --chrome           Enable Chrome browser access for this session
  drover --no-chrome        Disable Chrome even if default is on
  drover --no-sandbox       Disable Drover sandbox for this session
  drover --managed          Let the relay hold this session's key, so it can share it
  drover --private          Keep this session's key off the relay (the default)
  drover --js-runtime bun   Use bun instead of node to spawn Claude Code
  drover --claude-env ANTHROPIC_BASE_URL=http://127.0.0.1:3456
                           Use a custom API endpoint (e.g., claude-code-router)
  drover acp gemini         Start Gemini via generic ACP runner
  drover acp -- opencode --acp
                           Start a custom ACP command
  drover acp opencode --verbose
                           Print raw ACP backend/envelope events
  drover auth login --force Authenticate
  drover doctor             Run diagnostics

${chalk.bold('Cattle Drover supports ALL Claude options!')}
  Use any claude flag with drover as you would with claude. Our favorite:

  drover --resume
`)
}

/**
 * Handle notification command
 */
async function handleNotifyCommand(args: string[]): Promise<void> {
  let message = ''
  let title = ''
  let showHelp = false

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '-p' && i + 1 < args.length) {
      message = args[++i]
    } else if (arg === '-t' && i + 1 < args.length) {
      title = args[++i]
    } else if (arg === '-h' || arg === '--help') {
      showHelp = true
    } else {
      console.error(chalk.red(`Unknown argument for notify command: ${arg}`))
      process.exit(1)
    }
  }

  if (showHelp) {
    console.log(`
${chalk.bold('drover notify')} - Send notification

${chalk.bold('Usage:')}
  drover notify -p <message> [-t <title>]    Send notification with custom message and optional title
  drover notify -h, --help                   Show this help

${chalk.bold('Options:')}
  -p <message>    Notification message (required)
  -t <title>      Notification title (optional, defaults to "Cattle Drover")

${chalk.bold('Examples:')}
  drover notify -p "Deployment complete!"
  drover notify -p "System update complete" -t "Server Status"
  drover notify -t "Alert" -p "Database connection restored"
`)
    return
  }

  if (!message) {
    console.error(chalk.red('Error: Message is required. Use -p "your message" to specify the notification text.'))
    console.log(chalk.gray('Run "drover notify --help" for usage information.'))
    process.exit(1)
  }

  // Load credentials
  const { readCredentials } = await import('./persistence')
  let credentials = await readCredentials()
  if (!credentials) {
    console.error(chalk.red('Error: Not authenticated. Please run "drover auth login" first.'))
    process.exit(1)
  }

  console.log(chalk.blue('📱 Sending push notification...'))

  try {
    // Create API client and send push notification
    const { ApiClient } = await import('./api/api')
    const api = await ApiClient.create(credentials);

    // Use custom title or default to "Happy"
    const notificationTitle = title || 'Cattle Drover'

    // Send the push notification
    api.push().sendToAllDevices(
      notificationTitle,
      message,
      {
        source: 'cli',
        timestamp: Date.now()
      }
    )

    console.log(chalk.green('✓ Push notification sent successfully!'))
    console.log(chalk.gray(`  Title: ${notificationTitle}`))
    console.log(chalk.gray(`  Message: ${message}`))
    console.log(chalk.gray('  Check your mobile device for the notification.'))

    // Give a moment for the async operation to start
    await new Promise(resolve => setTimeout(resolve, 1000))

  } catch (error) {
    console.error(chalk.red('✗ Failed to send push notification'))
    throw error
  }
}

/**
 * Auth + machine setup, then make sure the daemon is up — the shared preamble
 * of every session-starting verb. A function so each branch dynamic-imports
 * the auth and daemon arms only when a session is actually starting
 * (DROVE-288).
 */
async function authAndEnsureDaemon() {
  const { authAndSetupMachineIfNeeded } = await import('./ui/auth')
  const { ensureDaemonRunning } = await import('./daemon/ensureDaemonRunning')
  const { credentials } = await authAndSetupMachineIfNeeded()
  await ensureDaemonRunning()
  return { credentials }
}
