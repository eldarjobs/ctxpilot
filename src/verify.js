'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getPaths, tryParseJson } = require('./discovery');

/**
 * Detects the project's primary verification command (test/typecheck/lint).
 */
function detectVerifyCommand(workspaceDir) {
    if (!workspaceDir || !fs.existsSync(workspaceDir)) return null;
    const hub = tryParseJson(path.join(workspaceDir, '.agents', 'hub.json'));
    if (hub.data && typeof hub.data.verify === 'string' && hub.data.verify.trim()) {
        return hub.data.verify.trim();
    }

    const pkg = tryParseJson(path.join(workspaceDir, 'package.json'));
    if (pkg.data && pkg.data.scripts && typeof pkg.data.scripts === 'object') {
        const s = pkg.data.scripts;
        if (s.test && !/no test specified/i.test(s.test)) return 'npm test';
        if (s.typecheck) return 'npm run typecheck';
        if (s.lint) return 'npm run lint';
    }

    try {
        const entries = fs.readdirSync(workspaceDir);
        if (entries.some(f => f.endsWith('.sln') || f.endsWith('.csproj'))) return 'dotnet test';
        if (entries.includes('pyproject.toml') || entries.includes('pytest.ini')) return 'pytest';
        if (entries.includes('Cargo.toml')) return 'cargo test';
        if (entries.includes('go.mod')) return 'go test ./...';
    } catch {}

    return null;
}

function summarizeVerifyOutput(output, ok) {
    const lines = String(output || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const passMatch = lines.find(l => /\b(\d+\s+passed|pass\s+\d+|passed!\s*-|0\s+failed)\b/i.test(l));
    const failMatch = lines.find(l => /\b(fail(ed|s)?\s+\d+|\d+\s+failed|ERR_ASSERTION|AssertionError|FAIL\b)\b/i.test(l));
    if (ok && passMatch) return passMatch.slice(0, 80);
    if (!ok && failMatch) return failMatch.slice(0, 80);
    return (lines[lines.length - 1] || (ok ? 'Passed' : 'Failed')).slice(0, 80);
}

/**
 * Runs the workspace verification command silently in the background with a 60s timeout.
 */
function runVerify(opts = {}) {
    const paths = getPaths(opts);
    const command = opts.command || detectVerifyCommand(paths.workspaceDir);
    if (!command) {
        return Promise.resolve({ ok: false, skipped: true, reason: 'No test/verify command detected', workspace: paths.workspaceDir });
    }

    const t0 = Date.now();
    const timeoutMs = opts.timeoutMs || 60000;
    return new Promise((resolve) => {
        let out = '';
        let done = false;
        const child = spawn(command, {
            cwd: paths.workspaceDir,
            shell: true,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const append = (chunk) => {
            out += chunk.toString('utf8');
            if (out.length > 8000) out = out.slice(-6000);
        };
        if (child.stdout) child.stdout.on('data', append);
        if (child.stderr) child.stderr.on('data', append);

        const finish = (code, timedOut) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            const ok = !timedOut && code === 0;
            resolve({
                ok,
                command,
                workspace: paths.workspaceDir,
                exitCode: timedOut ? -1 : code,
                timedOut: Boolean(timedOut),
                durationMs: Date.now() - t0,
                summaryLine: timedOut ? `Timed out after ${Math.round(timeoutMs / 1000)}s` : summarizeVerifyOutput(out, ok),
                outputTail: out.trim().slice(-2000),
            });
        };

        const timer = setTimeout(() => {
            try { child.kill(); } catch {}
            finish(-1, true);
        }, timeoutMs);

        child.on('error', (err) => {
            out += `\n${err.message}`;
            finish(1, false);
        });
        child.on('close', (code) => finish(code ?? 1, false));
    });
}

module.exports = { detectVerifyCommand, runVerify };
