import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const ENVIRONMENTS_MODULE_URL = pathToFileURL(join(REPO_ROOT, 'environments', 'environments.ts')).href;

export type EnvironmentTemplate = 'authenticated-empty' | 'empty';

export type IntegrationEnvironment = {
    name: string;
    envDir: string;
    projectPath: string;
    serverPort: number;
    expoPort: number;
};

type EnvironmentConfig = {
    projectPath: string;
    serverPort: number;
    expoPort: number;
};

type EnvironmentsModule = {
    createEnvironment: (opts?: { noSwitch?: boolean }) => Promise<string>;
    getEnvironmentConfig: (name: string) => EnvironmentConfig;
    getEnvironmentDir: (name: string) => string;
    removeEnvironment: (name: string) => void;
    seedEnvironment: (name: string) => Promise<void>;
    setEnvironmentTemplate: (name: string, template: EnvironmentTemplate) => void;
    startEnvironmentServices: (name: string) => Promise<void>;
    stopEnvironment: (name: string) => void;
    sweepDeadHarnessEnvironments: () => Array<{ name: string; owner: number }>;
    writeHarnessOwner: (name: string, pid: number) => void;
};

/**
 * Loaded once and kept: the stop that runs from a signal handler or the exit
 * hook cannot await an import, so it needs the module already here
 * (DROVE-389).
 */
let loaded: EnvironmentsModule | undefined;

async function loadEnvironmentManager(): Promise<EnvironmentsModule> {
    if (!loaded) loaded = await import(ENVIRONMENTS_MODULE_URL) as EnvironmentsModule;
    return loaded;
}

export async function createIntegrationEnvironment(options?: { template?: EnvironmentTemplate; up?: boolean }): Promise<IntegrationEnvironment> {
    const template = options?.template ?? 'authenticated-empty';
    const shouldStart = options?.up ?? true;
    const environments = await loadEnvironmentManager();
    const name = await environments.createEnvironment({ noSwitch: true });

    try {
        // Ours, and this process's, before a single service starts: the sweep
        // at the next run and cattle-drover's reaper both read this pid to tell
        // a run that is still going from one that was killed (DROVE-389).
        environments.writeHarnessOwner(name, process.pid);
        environments.setEnvironmentTemplate(name, template);

        if (shouldStart) {
            await environments.startEnvironmentServices(name);
            if (template === 'authenticated-empty') {
                await environments.seedEnvironment(name);
            }
        }

        const config = environments.getEnvironmentConfig(name);
        return {
            name,
            envDir: environments.getEnvironmentDir(name),
            projectPath: config.projectPath,
            serverPort: config.serverPort,
            expoPort: config.expoPort,
        };
    } catch (error) {
        try {
            environments.stopEnvironment(name);
        } catch {}

        try {
            environments.removeEnvironment(name);
        } catch {}

        throw error;
    }
}

export function applyEnvironmentToProcess(env: IntegrationEnvironment) {
    process.env.HAPPY_SERVER_URL = `http://localhost:${env.serverPort}`;
    process.env.HAPPY_WEBAPP_URL = `http://localhost:${env.expoPort}`;
    process.env.HAPPY_HOME_DIR = join(env.envDir, 'cli', 'home');
    process.env.HAPPY_PROJECT_DIR = env.projectPath;
    process.env.HAPPY_VARIANT = 'dev';
    process.env.DEBUG = '1';
}

export async function destroyIntegrationEnvironment(env: IntegrationEnvironment) {
    const environments = await loadEnvironmentManager();
    environments.stopEnvironment(env.name);
    environments.removeEnvironment(env.name);
}

/**
 * The same, synchronously, for the paths where nothing can await: a SIGTERM
 * or SIGINT landing on the worker, or its exit. Only stops and removes what
 * createIntegrationEnvironment already loaded the manager for; a call before
 * that is a no-op rather than an import.
 */
export function destroyIntegrationEnvironmentNow(env: IntegrationEnvironment): boolean {
    if (!loaded) return false;
    try {
        loaded.stopEnvironment(env.name);
    } finally {
        loaded.removeEnvironment(env.name);
    }
    return true;
}
