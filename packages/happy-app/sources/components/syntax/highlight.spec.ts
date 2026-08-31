import { beforeEach, describe, expect, it } from 'vitest';
import {
    highlight,
    highlightCacheSize,
    highlightShell,
    maxHighlightChars,
    maxHighlightLines,
    resetHighlightCache,
    type Span,
} from './highlight';

const text = (spans: Span[]) => spans.map((span) => span.text).join('');
const roleOf = (spans: Span[], needle: string) =>
    spans.find((span) => span.text.includes(needle))?.role;

beforeEach(() => {
    resetHighlightCache();
});

describe('highlighting a block (DROVE-159)', () => {
    /**
     * Nothing else matters if this fails. The block on screen has to be the
     * text the agent ran, character for character.
     */
    it('never changes the text', () => {
        const samples = [
            ['def go(x):\n    return x + 1', 'python'],
            ['{"a": [1, 2], "b": null}', 'json'],
            ['cd /tmp && ls -la # look', 'bash'],
            ['const x = `a ${b} c`;', 'typescript'],
            ['plain english, no language', null],
            ['', null],
        ] as const;
        for (const [code, label] of samples) {
            expect(text(highlight(code, label))).toBe(code);
        }
    });

    it('colours what it should', () => {
        const spans = highlight('def go(x):\n    return x + 1', 'python');
        expect(roleOf(spans, 'def')).toBe('keyword');
        expect(roleOf(spans, 'go')).toBe('function');
        expect(roleOf(spans, '1')).toBe('number');
    });

    it('sniffs when the fence named nothing', () => {
        const spans = highlight('import os\n\ndef go(x):\n    return os.path.join(x)', null);
        expect(spans.length).toBeGreaterThan(1);
        expect(roleOf(spans, 'import')).toBe('keyword');
    });

    describe('an undetected block renders exactly as it did before', () => {
        it('is one plain span for prose', () => {
            const prose = 'The deploy finished and nothing caught fire.';
            expect(highlight(prose, null)).toEqual([{ text: prose, role: 'plain' }]);
        });

        it('is one plain span for a label we have no grammar for', () => {
            const code = 'graph TD;\n  A-->B;';
            expect(highlight(code, 'mermaid')).toEqual([{ text: code, role: 'plain' }]);
        });

        it('does not fall back to sniffing when a label was given', () => {
            // Real Python, labelled with something we cannot place. It stays
            // plain rather than being run through the nearest grammar.
            expect(highlight('def go(x):\n    return x', 'mermaid')).toEqual([
                { text: 'def go(x):\n    return x', role: 'plain' },
            ]);
        });
    });

    describe('a diff keeps its own colours', () => {
        it('leaves added and removed lines plain', () => {
            const patch = 'diff --git a/x.ts b/x.ts\n-const a = 1;\n+const a = 2;';
            expect(highlight(patch, null)).toEqual([{ text: patch, role: 'plain' }]);
        });
    });

    describe('scroll cost', () => {
        it('merges neighbouring spans of the same role', () => {
            const spans = highlight('{"aaa": 1, "bbb": 2, "ccc": 3}', 'json');
            for (let i = 1; i < spans.length; i++) {
                expect(spans[i].role).not.toBe(spans[i - 1].role);
            }
        });

        it('gives up on a block too long to be code', () => {
            const long = 'x = 1\n'.repeat(maxHighlightLines + 10);
            expect(highlight(long, 'python')).toEqual([{ text: long, role: 'plain' }]);

            const wide = 'a'.repeat(maxHighlightChars + 1);
            expect(highlight(wide, 'python')).toEqual([{ text: wide, role: 'plain' }]);
        });

        it('hands back the same array on the second look, so a re-render costs nothing', () => {
            const code = 'def go(x):\n    return x';
            const first = highlight(code, 'python');
            const second = highlight(code, 'python');
            expect(second).toBe(first);
            expect(highlightCacheSize()).toBe(1);
        });

        it('does not grow without bound', () => {
            for (let i = 0; i < 500; i++) highlight(`x = ${i}`, 'python');
            expect(highlightCacheSize()).toBeLessThanOrEqual(240);
        });

        it('does not confuse a cached block with one of another language', () => {
            const code = 'a b';
            expect(highlight(code, 'python')).not.toBe(highlight(code, 'bash'));
        });
    });
});

describe('highlighting a shell command (DROVE-159)', () => {
    it('never changes the text', () => {
        const command = "python3 - <<'PY'\nimport json\nprint(json.dumps({}))\nPY\necho done";
        expect(text(highlightShell(command))).toBe(command);
    });

    /**
     * The block Clay photographed. Tokenised as bash, `import` is nothing and
     * the wall stays a wall; the heredoc has to reach Python's grammar.
     */
    it('gives a Python heredoc Python keywords, not shell ones', () => {
        const command = ["python3 - <<'PY'", 'import json', 'if True:', '    print(1)', 'PY'].join('\n');
        const spans = highlightShell(command);
        expect(roleOf(spans, 'import')).toBe('keyword');
        expect(roleOf(spans, 'if')).toBe('keyword');
    });

    it('still tokenises the shell around the heredoc', () => {
        const spans = highlightShell("cat <<'PY'\nx = 1\nPY\ngit status # done");
        expect(roleOf(spans, '# done')).toBe('comment');
    });

    it('leaves a body it cannot place plain', () => {
        const command = ["cat <<'EOF'", 'Dear Clay, nothing caught fire.', 'EOF'].join('\n');
        const spans = highlightShell(command);
        expect(roleOf(spans, 'Dear Clay')).toBe('plain');
    });

    it('caches, and gives up on a command too long to be one', () => {
        const command = 'echo hi';
        expect(highlightShell(command)).toBe(highlightShell(command));
        const huge = 'echo hi\n'.repeat(maxHighlightLines + 10);
        expect(highlightShell(huge)).toEqual([{ text: huge, role: 'plain' }]);
    });

    it('returns nothing for an empty command', () => {
        expect(highlightShell('')).toEqual([]);
    });
});
