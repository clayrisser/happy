import { afterAll } from 'vitest';
import {
    applyEnvironmentToProcess,
    createIntegrationEnvironment,
    destroyIntegrationEnvironment,
    destroyIntegrationEnvironmentNow,
    type EnvironmentTemplate,
    type IntegrationEnvironment,
} from './integrationEnvironment';

type IntegrationEnvironmentProfile = {
    template: EnvironmentTemplate;
    up: boolean;
};

declare global {
    // eslint-disable-next-line no-var
    var __happyIntegrationEnv: IntegrationEnvironment | undefined;
}

/**
 * The signals that end a vitest run from outside: Ctrl-C on the terminal,
 * `timeout` running out, the terminal going away. Each reaches the worker as
 * the group signal, and a worker that dies on it never runs afterAll. SIGKILL
 * is not here because it cannot be: that case is the sweep at the start of
 * the next run (src/test-setup.ts) and cattle-drover's reaper (DROVE-389).
 */
const ENDING_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export async function installIntegrationEnvironment(profile: IntegrationEnvironmentProfile) {
    const previousEnv = {
        HAPPY_SERVER_URL: process.env.HAPPY_SERVER_URL,
        HAPPY_WEBAPP_URL: process.env.HAPPY_WEBAPP_URL,
        HAPPY_HOME_DIR: process.env.HAPPY_HOME_DIR,
        HAPPY_PROJECT_DIR: process.env.HAPPY_PROJECT_DIR,
        HAPPY_VARIANT: process.env.HAPPY_VARIANT,
        DEBUG: process.env.DEBUG,
    };

    const env = await createIntegrationEnvironment(profile);
    applyEnvironmentToProcess(env);
    globalThis.__happyIntegrationEnv = env;

    // The net under afterAll. Three services and a daemon are up, detached,
    // in process groups of their own, and only this process knows they are
    // this run's. If the run is cut short by a signal, stop them here and
    // then let the signal do what it was going to do; if the worker exits
    // any other way without afterAll having run, the exit hook is the last
    // chance, and it is synchronous because that is all an exit hook gets.
    let destroyed = false;
    const destroyNow = (): void => {
        if (destroyed) return;
        destroyed = true;
        try {
            destroyIntegrationEnvironmentNow(env);
        } catch {
            // Nothing to report to from a dying process.
        }
    };
    const onSignal = (signal: NodeJS.Signals): void => {
        destroyNow();
        process.removeListener(signal, onSignal);
        // Somebody else (vitest's own worker plumbing) may hold the signal
        // too; only when nobody does is the default disposition ours to
        // restore.
        if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    for (const signal of ENDING_SIGNALS) process.on(signal, onSignal);
    process.on('exit', destroyNow);

    afterAll(async () => {
        try {
            if (!destroyed) {
                destroyed = true;
                await destroyIntegrationEnvironment(env);
            }
        } finally {
            for (const signal of ENDING_SIGNALS) process.removeListener(signal, onSignal);
            process.removeListener('exit', destroyNow);

            for (const [key, value] of Object.entries(previousEnv)) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }

            if (globalThis.__happyIntegrationEnv?.name === env.name) {
                globalThis.__happyIntegrationEnv = undefined;
            }
        }
    });
}
