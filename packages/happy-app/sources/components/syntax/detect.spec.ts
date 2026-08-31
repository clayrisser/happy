import { describe, expect, it } from 'vitest';
import { detectLanguage, detectOutputLanguage } from './detect';

describe('guessing a language (DROVE-159)', () => {
    it('reads a shebang before anything else', () => {
        expect(detectLanguage('#!/usr/bin/env python3\nx = 1')).toBe('python');
        expect(detectLanguage('#!/bin/sh\ncd /tmp')).toBe('bash');
        expect(detectLanguage('#!/usr/bin/env node\nlet x = 1')).toBe('javascript');
    });

    it('places the languages this app actually shows', () => {
        expect(detectLanguage('def go(x):\n    import os\n    return os.path.join(x)')).toBe('python');
        expect(detectLanguage("const a = 1;\nconsole.log(a);\nmodule.exports = a;")).toBe('javascript');
        expect(detectLanguage('interface Session {\n  id: string;\n  seq: number;\n}')).toBe('typescript');
        expect(detectLanguage('cd /tmp && git status --short | grep foo')).toBe('bash');
        expect(detectLanguage('SELECT id, name FROM sessions WHERE seq > 10')).toBe('sql');
        expect(detectLanguage('<html>\n<body>\n<div>hi</div>\n</body>\n</html>')).toBe('markup');
        expect(detectLanguage('package main\n\nfunc main() {\n\tx := 1\n}')).toBe('go');
    });

    it('parses JSON rather than guessing at it', () => {
        expect(detectLanguage('{"a": 1, "b": [2, 3]}')).toBe('json');
        // Looks like JSON, is not JSON. A parse says so and a heuristic would not.
        expect(detectLanguage('{this is not json at all}')).toBeNull();
    });

    /**
     * The refusal is the acceptance criterion. Everything here would match a
     * rule or two, and every one of them has to come back null so the block
     * renders exactly as it did before highlighting existed.
     */
    describe('declines when nothing wins clearly', () => {
        it.each([
            ['English prose', 'The deploy finished and the tests are green. Nothing else to report.'],
            ['a bare word', 'ok'],
            ['a stack trace', 'Error: connect ECONNREFUSED 127.0.0.1:3000\n    at TCPConnectWrap.afterConnect'],
            ['a table of numbers', 'a  1  2\nb  3  4\nc  5  6'],
            ['empty', ''],
            ['a file listing', 'README.md\npackage.json\nsources\n'],
        ])('declines %s', (_name, text) => {
            expect(detectLanguage(text)).toBeNull();
        });

        it('declines a diff, because the diff view owns those colours', () => {
            const patch = [
                'diff --git a/x.ts b/x.ts',
                '@@ -1,3 +1,3 @@',
                '-const a = 1;',
                '+const a = 2;',
            ].join('\n');
            expect(detectLanguage(patch)).toBeNull();
        });

        it('declines a language we have no grammar for', () => {
            // Scores nothing, so it never gets as far as the grammar lookup.
            expect(detectLanguage('graph TD;\n  A-->B;')).toBeNull();
        });
    });

    describe('terminal output is not sniffed at all', () => {
        it('takes a JSON payload, because a parse is exact', () => {
            expect(detectOutputLanguage('{"ok": true, "count": 3}')).toBe('json');
            expect(detectOutputLanguage('[\n  {"id": 1}\n]')).toBe('json');
        });

        it('declines everything else, including output a rule would have matched', () => {
            expect(detectOutputLanguage('cd /tmp && git status')).toBeNull();
            expect(detectOutputLanguage('def go(x):\n    return x')).toBeNull();
            expect(detectOutputLanguage('  3 files changed, 12 insertions(+)')).toBeNull();
            expect(detectOutputLanguage('')).toBeNull();
        });
    });
});
