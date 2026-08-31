import { describe, expect, it } from 'vitest';
import { segmentShell } from './shell';

/** The whole point: nothing may be added to or dropped from the command. */
function rebuild(command: string): string {
    return segmentShell(command).map((segment) => segment.text).join('');
}

function languages(command: string): Array<string | null> {
    return segmentShell(command).map((segment) => segment.lang);
}

/** The body of the first segment that is not shell. */
function embedded(command: string) {
    return segmentShell(command).find((segment) => segment.lang !== 'bash');
}

describe('segmenting a shell command (DROVE-159)', () => {
    it('leaves a plain command as one bash segment', () => {
        expect(segmentShell('git status --short')).toEqual([
            { text: 'git status --short', lang: 'bash' },
        ]);
    });

    it('returns nothing for an empty command', () => {
        expect(segmentShell('')).toEqual([]);
    });

    describe('a heredoc body gets the language that reads it', () => {
        it('names Python from the interpreter, which is the case in the screenshot', () => {
            const command = [
                "python3 - <<'PY'",
                'import json',
                'print(json.dumps({"ok": True}))',
                'PY',
            ].join('\n');
            expect(embedded(command)).toEqual({
                text: 'import json\nprint(json.dumps({"ok": True}))\n',
                lang: 'python',
            });
            // The shell around it is still shell.
            expect(languages(command)).toEqual(['bash', 'python', 'bash']);
        });

        it('names it from an unquoted delimiter too', () => {
            expect(embedded('python3 <<EOF\nx = 1\nEOF')?.lang).toBe('python');
        });

        it('reads through sudo and env', () => {
            expect(embedded("sudo env FOO=1 python3 - <<'EOF'\nx = 1\nEOF")?.lang).toBe('python');
        });

        it('reads an absolute interpreter path', () => {
            expect(embedded("/usr/bin/python3 - <<'EOF'\nx = 1\nEOF")?.lang).toBe('python');
        });

        it('follows a redirect target extension when the command is cat', () => {
            expect(embedded("cat > /tmp/run.py <<'EOF'\nx = 1\nEOF")?.lang).toBe('python');
            expect(embedded("cat > conf.yaml <<'EOF'\na: 1\nEOF")?.lang).toBe('yaml');
            expect(embedded("tee /etc/app.json <<'EOF'\n{}\nEOF")?.lang).toBe('json');
        });

        it('falls back to the delimiter name', () => {
            expect(embedded("cat <<'PY'\nx = 1\nPY")?.lang).toBe('python');
            expect(embedded("cat <<'SQL'\nselect 1\nSQL")?.lang).toBe('sql');
            // Suffix noise is stripped, so PYEOF and PY_EOF mean the same.
            expect(embedded("cat <<'PYEOF'\nx = 1\nPYEOF")?.lang).toBe('python');
            expect(embedded("cat <<'PYTHON_EOF'\nx = 1\nPYTHON_EOF")?.lang).toBe('python');
        });

        it('sniffs the body when nothing else says', () => {
            const command = ["cat <<'EOF'", 'def go(x):', '    return x + 1', 'EOF'].join('\n');
            expect(embedded(command)?.lang).toBe('python');
        });

        it('knows kubectl apply -f - is YAML whatever the delimiter says', () => {
            const command = ["kubectl apply -f - <<'EOF'", 'kind: Pod', 'metadata:', '  name: a', 'EOF'].join('\n');
            expect(embedded(command)?.lang).toBe('yaml');
        });

        it('leaves prose alone rather than colouring it as shell', () => {
            const command = [
                "cat <<'EOF'",
                'Dear Clay, the deploy finished and nothing caught fire.',
                'Regards, the robot.',
                'EOF',
            ].join('\n');
            expect(embedded(command)?.lang).toBeNull();
        });
    });

    describe('the walk itself', () => {
        it('rebuilds the command byte for byte', () => {
            const commands = [
                "python3 - <<'PY'\nimport os\nPY",
                'echo hi',
                "cat <<-EOF\n\tindented\n\tEOF\necho done",
                "node <<'JS'\nconsole.log(1)\nJS\ngit status",
                'grep -r "<<" .',
                "cat <<'A' && cat <<'B'\nfirst\nA\nsecond\nB",
            ];
            for (const command of commands) {
                expect(rebuild(command)).toBe(command);
            }
        });

        it('keeps the terminator on the shell side', () => {
            const segments = segmentShell("python3 <<'PY'\nx = 1\nPY\necho done");
            expect(segments.map((s) => s.text)).toEqual([
                "python3 <<'PY'\n",
                'x = 1\n',
                'PY\necho done',
            ]);
        });

        it('accepts an indented terminator only after <<-', () => {
            expect(segmentShell("cat <<-'EOF'\n\tbody\n\tEOF").map((s) => s.text)).toEqual([
                "cat <<-'EOF'\n",
                '\tbody\n',
                '\tEOF',
            ]);
            // Without the dash the indented line is still body, so the heredoc
            // runs to the end. Bash would agree.
            expect(segmentShell("cat <<'EOF'\n\tbody\n\tEOF").length).toBe(2);
        });

        it('handles two heredocs opened on one line, in order', () => {
            const command = ["python3 - <<'PY' <<'SQL'", 'x = 1', 'PY', 'select 1', 'SQL'].join('\n');
            expect(languages(command)).toEqual(['bash', 'python', 'bash', 'python', 'bash']);
        });

        it('is not fooled by a herestring', () => {
            expect(segmentShell('grep foo <<< "$body"')).toEqual([
                { text: 'grep foo <<< "$body"', lang: 'bash' },
            ]);
        });

        it('still places the body of a truncated heredoc', () => {
            const command = "python3 - <<'PY'\nimport os\nprint(os.getcwd())";
            expect(embedded(command)).toEqual({
                text: 'import os\nprint(os.getcwd())',
                lang: 'python',
            });
        });
    });

    describe('an interpreter handed a script argument', () => {
        it('splits out a python -c body', () => {
            const segments = segmentShell(`python3 -c 'import sys; print(sys.version)'`);
            // The quotes stay on the shell side, because they are shell
            // quoting. Only what they hold is Python.
            expect(segments).toEqual([
                { text: "python3 -c '", lang: 'bash' },
                { text: 'import sys; print(sys.version)', lang: 'python' },
                { text: "'", lang: 'bash' },
            ]);
        });

        it('splits out a node -e body', () => {
            expect(embedded(`node -e "console.log(1)"`)).toEqual({
                text: 'console.log(1)',
                lang: 'javascript',
            });
        });

        it('leaves an interpreter we have no grammar for as shell', () => {
            expect(languages(`perl -e 'print 1'`)).toEqual(['bash']);
        });

        it('rebuilds the command byte for byte', () => {
            const command = `cd /tmp && python3 -c 'print(1)' && echo done`;
            expect(rebuild(command)).toBe(command);
        });
    });
});
