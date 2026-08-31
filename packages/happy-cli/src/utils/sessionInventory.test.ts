import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
    builtinCommandFloor,
    collapseHome,
    discoverSessionInventory,
    formatSkillsAnswer,
    frontmatterDescription,
    type SessionInventory,
    type SessionInventoryEntry,
} from './sessionInventory';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'happy-session-inventory-'));
    tempRoots.push(root);
    return root;
}

async function writeMarkdown(path: string[], body: string): Promise<void> {
    const file = join(...path);
    await mkdir(join(...path.slice(0, -1)), { recursive: true });
    await writeFile(file, body);
}

async function addSkill(root: string, parts: string[], description?: string): Promise<void> {
    await writeMarkdown(
        [root, ...parts, 'SKILL.md'],
        description === undefined
            ? '---\nname: whatever\n---\nbody\n'
            : `---\nname: whatever\ndescription: ${description}\n---\nbody\n`,
    );
}

async function addCommand(root: string, parts: string[], description?: string): Promise<void> {
    await writeMarkdown(
        [root, ...parts],
        description === undefined ? 'just a body\n' : `---\ndescription: ${description}\n---\nbody\n`,
    );
}

afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('frontmatterDescription', () => {
    it('reads a plain scalar', () => {
        expect(frontmatterDescription('---\nname: x\ndescription: Does a thing\n---\nbody'))
            .toBe('Does a thing');
    });

    it('strips quotes and collapses whitespace', () => {
        expect(frontmatterDescription('---\ndescription: "Does   a\tthing"\n---\n'))
            .toBe('Does a thing');
    });

    it('joins a folded block', () => {
        expect(frontmatterDescription('---\ndescription: >-\n  first line\n  second line\nname: x\n---\n'))
            .toBe('first line second line');
    });

    it('clips a description that would not fit one dropdown row', () => {
        const long = 'x'.repeat(400);
        const clipped = frontmatterDescription(`---\ndescription: ${long}\n---\n`);
        expect(clipped!.length).toBe(160);
        expect(clipped!.endsWith('…')).toBe(true);
    });

    it('is undefined when there is no frontmatter or no description', () => {
        expect(frontmatterDescription('no frontmatter here')).toBeUndefined();
        expect(frontmatterDescription('---\nname: x\n---\nbody')).toBeUndefined();
    });
});

describe('discoverSessionInventory (claude)', () => {
    it('separates commands from skills and namespaces a subdirectory with a colon', async () => {
        const root = await makeTempRoot();
        const cwd = join(root, 'project');
        const configDir = join(root, 'config');

        await addCommand(configDir, ['commands', 'flip.md'], 'Move this session');
        await addCommand(configDir, ['commands', 'agent-os', 'plan-new-product.md']);
        await addSkill(configDir, ['skills', 'huly-ticket'], 'File a ticket');
        await addSkill(cwd, ['.claude', 'skills', 'release'], 'Cut a release');
        await addCommand(cwd, ['.claude', 'commands', 'deploy.md']);

        const inventory = await discoverSessionInventory({ cwd, configDir, homeDir: root });

        expect(inventory.commands.map((c) => c.name)).toEqual(
            expect.arrayContaining(['flip', 'agent-os:plan-new-product', 'deploy']),
        );
        expect(inventory.skills.map((s) => s.name)).toEqual(['huly-ticket', 'release']);
        // A skill is never reported as a command, which is the distinction the
        // harness's own flat slash_commands list cannot make.
        expect(inventory.commands.map((c) => c.name)).not.toContain('huly-ticket');
        expect(inventory.skills.find((s) => s.name === 'release')?.origin).toBe('project');
        expect(inventory.commands.find((c) => c.name === 'flip')?.description).toBe('Move this session');
        expect(inventory.source).toBe('scan');
    });

    it('reads plugin commands and skills off the installed manifest', async () => {
        const root = await makeTempRoot();
        const configDir = join(root, 'config');
        const installPath = join(configDir, 'plugins', 'cache', 'market', 'swift-lsp', '1.0.0');

        await writeMarkdown(
            [configDir, 'plugins', 'installed_plugins.json'],
            JSON.stringify({ version: 2, plugins: { 'swift-lsp@market': [{ installPath }] } }),
        );
        await addSkill(installPath, ['skills', 'swift-build'], 'Build swift');
        await addCommand(installPath, ['commands', 'lsp-restart.md']);

        const inventory = await discoverSessionInventory({
            cwd: join(root, 'project'),
            configDir,
            homeDir: root,
        });

        expect(inventory.skills.map((s) => s.name)).toContain('swift-lsp:swift-build');
        expect(inventory.commands.map((c) => c.name)).toContain('swift-lsp:lsp-restart');
    });

    it('a project entry shadows the user entry of the same name', async () => {
        const root = await makeTempRoot();
        const cwd = join(root, 'project');
        const configDir = join(root, 'config');

        await addSkill(configDir, ['skills', 'release'], 'user copy');
        await addSkill(cwd, ['.claude', 'skills', 'release'], 'project copy');

        const inventory = await discoverSessionInventory({ cwd, configDir, homeDir: root });

        expect(inventory.skills.filter((s) => s.name === 'release')).toHaveLength(1);
        expect(inventory.skills[0].description).toBe('project copy');
    });

    it('follows a symlinked skill directory', async () => {
        // Not hypothetical: 5 of this repo's own 7 project skills are links
        // into .agents/skills, and a walk that skips links reported 73 of the
        // 78 skills Claude Code itself listed.
        const root = await makeTempRoot();
        const cwd = join(root, 'project');
        await addSkill(cwd, ['.agents', 'skills', 'release'], 'Cut a release');
        await mkdir(join(cwd, '.claude', 'skills'), { recursive: true });
        await symlink(join(cwd, '.agents', 'skills', 'release'), join(cwd, '.claude', 'skills', 'release'));

        const inventory = await discoverSessionInventory({
            cwd,
            configDir: join(root, 'missing'),
            homeDir: root,
        });

        expect(inventory.skills.map((s) => s.name)).toEqual(['release']);
        expect(inventory.skills[0].description).toBe('Cut a release');
    });

    it('does not loop on a symlink pointing back up its own tree', async () => {
        const root = await makeTempRoot();
        const configDir = join(root, 'config');
        await addSkill(configDir, ['skills', 'one']);
        await symlink(join(configDir, 'skills'), join(configDir, 'skills', 'one', 'loop'));

        const inventory = await discoverSessionInventory({
            cwd: join(root, 'project'),
            configDir,
            homeDir: root,
        });

        expect(inventory.skills.map((s) => s.name)).toEqual(['one']);
    });

    it('answers with the built-in floor when nothing is on disk', async () => {
        const root = await makeTempRoot();

        const inventory = await discoverSessionInventory({
            cwd: join(root, 'nowhere'),
            configDir: join(root, 'missing'),
            homeDir: root,
        });

        expect(inventory.skills).toEqual([]);
        expect(inventory.commands.map((c) => c.name))
            .toEqual(builtinCommandFloor().map((c) => c.name));
    });

    it('a user command of the same name wins over the built-in floor', async () => {
        const root = await makeTempRoot();
        const configDir = join(root, 'config');
        await addCommand(configDir, ['commands', 'clear.md'], 'my own clear');

        const inventory = await discoverSessionInventory({
            cwd: join(root, 'project'),
            configDir,
            homeDir: root,
        });

        expect(inventory.commands.filter((c) => c.name === 'clear')).toHaveLength(1);
        expect(inventory.commands.find((c) => c.name === 'clear')?.origin).toBe('user');
    });

    it('follows the config dir it is given, which is how a flip stays correct', async () => {
        const root = await makeTempRoot();
        const cwd = join(root, 'project');
        const accountOne = join(root, 'account-1');
        const accountTwo = join(root, 'account-2');

        await addSkill(accountOne, ['skills', 'only-on-one']);
        await addSkill(accountTwo, ['skills', 'only-on-two']);

        const one = await discoverSessionInventory({ cwd, configDir: accountOne, homeDir: root });
        const two = await discoverSessionInventory({ cwd, configDir: accountTwo, homeDir: root });

        expect(one.skills.map((s) => s.name)).toEqual(['only-on-one']);
        expect(two.skills.map((s) => s.name)).toEqual(['only-on-two']);
    });
});

describe('discoverSessionInventory (codex)', () => {
    it('walks codex home and .agents/skills instead of the claude layout', async () => {
        const root = await makeTempRoot();
        const cwd = join(root, 'project');
        const codexHome = join(root, 'codex-home');

        await addSkill(cwd, ['.agents', 'skills', 'agent-browser']);
        await addSkill(codexHome, ['skills', 'plan-to-beads']);
        await addCommand(codexHome, ['commands', 'ignored.md']);

        const inventory = await discoverSessionInventory({
            flavor: 'codex',
            cwd,
            configDir: codexHome,
            homeDir: root,
        });

        expect(inventory.skills.map((s) => s.name)).toEqual(['agent-browser', 'plan-to-beads']);
        expect(inventory.commands).toEqual([]);
    });
});

describe('formatSkillsAnswer', () => {
    const home = '/home/clay';

    function inventory(
        skills: SessionInventoryEntry[],
        commands: SessionInventoryEntry[] = [],
    ): SessionInventory {
        return { skills, commands, source: 'scan', updatedAt: 0 };
    }

    it('lists the skills it found, with their descriptions', () => {
        const answer = formatSkillsAnswer(
            inventory(
                [
                    { name: 'huly-ticket', description: 'File and update tickets' },
                    { name: 'grug', origin: 'user' },
                ],
                [{ name: 'clear' }],
            ),
            { account: 'main', configDir: `${home}/.claude`, homeDir: home },
        );
        expect(answer).toContain('**2 skills** on account `main`, from `~/.claude/skills`.');
        expect(answer).toContain('- **/huly-ticket** — File and update tickets');
        expect(answer).toContain('- **/grug**');
        expect(answer).toContain('1 command is available too.');
    });

    it('never says a session may still be initializing', () => {
        const answer = formatSkillsAnswer(
            inventory([], [{ name: 'clear' }, { name: 'compact' }]),
            { account: 'jamrizzi', configDir: `${home}/.claude-accounts/jamrizzi`, homeDir: home },
        );
        // The old answer was "No skills available. Session may still be
        // initializing — try again after sending a message." It was the answer
        // for the LIFE of every pane session, and nothing was initializing.
        expect(answer).not.toMatch(/initializ/i);
        expect(answer).toContain('**No skills** on account `jamrizzi`');
        expect(answer).toContain('`~/.claude-accounts/jamrizzi/skills`');
        expect(answer).toContain('2 commands are available too.');
    });

    it('names the default account when a flip is what emptied the list', () => {
        const answer = formatSkillsAnswer(
            inventory([]),
            {
                account: 'jamrizzi',
                configDir: `${home}/.claude-accounts/jamrizzi`,
                elsewhere: { configDir: `${home}/.claude`, skills: 71 },
                homeDir: home,
            },
        );
        expect(answer).toContain('The default account has 71 of them, in `~/.claude/skills`.');
    });

    it('says nothing about the default account when it has no skills either', () => {
        const answer = formatSkillsAnswer(
            inventory([]),
            {
                account: 'alt',
                configDir: `${home}/.claude-accounts/alt`,
                elsewhere: { configDir: `${home}/.claude`, skills: 0 },
                homeDir: home,
            },
        );
        expect(answer).not.toContain('default account');
    });

    it('drops the account clause when the session is not on a drover account', () => {
        const answer = formatSkillsAnswer(
            inventory([{ name: 'flip' }]),
            { configDir: `${home}/.claude`, homeDir: home },
        );
        expect(answer).toContain('**1 skill**, from `~/.claude/skills`.');
        expect(answer).not.toContain('account');
    });
});

describe('collapseHome', () => {
    it('collapses the home prefix and leaves anything else alone', () => {
        expect(collapseHome('/home/clay/.claude', '/home/clay')).toBe('~/.claude');
        expect(collapseHome('/home/clay', '/home/clay')).toBe('~');
        expect(collapseHome('/opt/claude', '/home/clay')).toBe('/opt/claude');
        // A sibling directory that merely starts with the same characters.
        expect(collapseHome('/home/clayton/.claude', '/home/clay')).toBe('/home/clayton/.claude');
    });
});
