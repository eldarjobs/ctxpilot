'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runDoctor } = require('../src/doctor');
const { parseTranscriptV1 } = require('../src/transcript-adapter');
const { createCheckpoint, listCheckpoints, rewindCheckpoint, dropCheckpoint, createWorktreeSubChat, listWorktrees, removeWorktree } = require('../src/checkpoint');
const { runVerify, detectVerifyCommand } = require('../src/verify');

function gitRun(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('v0.5.0 Multi-Client MCP, Checkpoints/Rewind, Worktree, Verify & Session Burn', () => {
    let tmp, home, repo;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxpilot-v05-'));
        home = path.join(tmp, 'home');
        repo = path.join(tmp, 'repo');
        fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
        fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
        fs.mkdirSync(repo, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('audits Claude Code and Cursor MCP configs alongside Antigravity without leaking secrets', async () => {
        fs.writeFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: {} }));
        fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
            mcpServers: { github: { url: 'https://api.githubcopilot.com/mcp', headers: { Authorization: 'Bearer ' + 'ghp_' + '1234567890abcdef1234567890abcdef1234' } } },
        }));
        fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({
            mcpServers: { docs: { url: 'https://docs.example.com/mcp' } },
        }));

        const doc = await runDoctor({ homeDir: home, workspaceDir: repo });
        assert.equal(doc.findings.some(f => f.target === 'github (claude-code)' && f.level === 'FAIL'), true);
        assert.equal(doc.findings.some(f => f.target === 'docs (cursor)' && f.level === 'OK'), true);
        assert.equal(JSON.stringify(doc).includes('ghp_1234'), false);
    });

    it('creates hidden git checkpoints, rewinds tracked/untracked edits, preserves gitignored files, and manages worktrees', () => {
        gitRun(['init'], repo);
        gitRun(['config', 'core.autocrlf', 'false'], repo);
        gitRun(['config', 'user.email', 'test@example.com'], repo);
        gitRun(['config', 'user.name', 'Test'], repo);
        fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
        fs.writeFileSync(path.join(repo, 'app.txt'), 'v1\n');
        gitRun(['add', '.gitignore', 'app.txt'], repo);
        gitRun(['commit', '-m', 'init'], repo);
        const headBefore = gitRun(['rev-parse', 'HEAD'], repo);

        // Dirty tracked + untracked + gitignored before checkpoint
        fs.writeFileSync(path.join(repo, 'app.txt'), 'v2\n');
        fs.writeFileSync(path.join(repo, 'draft.txt'), 'keep-me\n');
        fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');

        const cp = createCheckpoint('before-refactor', { homeDir: home, workspaceDir: repo });
        assert.equal(listCheckpoints({ homeDir: home, workspaceDir: repo }).length, 1);
        assert.equal(gitRun(['rev-parse', 'HEAD'], repo), headBefore);

        // Further edits after checkpoint
        fs.writeFileSync(path.join(repo, 'app.txt'), 'broken-v3\n');
        fs.writeFileSync(path.join(repo, 'junk.txt'), 'remove-me\n');

        const rw = rewindCheckpoint(cp.id, { homeDir: home, workspaceDir: repo });
        assert.equal(rw.rewound, true);
        assert.equal(fs.readFileSync(path.join(repo, 'app.txt'), 'utf8'), 'v2\n');
        assert.equal(fs.readFileSync(path.join(repo, 'draft.txt'), 'utf8'), 'keep-me\n');
        assert.equal(fs.existsSync(path.join(repo, 'junk.txt')), false);
        assert.equal(fs.readFileSync(path.join(repo, '.env'), 'utf8'), 'SECRET=1\n');
        assert.equal(gitRun(['rev-parse', 'HEAD'], repo), headBefore);

        dropCheckpoint(cp.id, { homeDir: home, workspaceDir: repo });
        assert.equal(listCheckpoints({ homeDir: home, workspaceDir: repo }).length, 0);

        // Parallel git worktree sub-chat
        const wt = createWorktreeSubChat('fix-auth', { homeDir: home, workspaceDir: repo });
        assert.equal(fs.existsSync(wt.worktreeDir), true);
        assert.equal(listWorktrees({ homeDir: home, workspaceDir: repo }).length, 1);
        assert.match(wt.markdown, /Isolated Sub-Chat/);

        const rmWt = removeWorktree(wt.worktreeDir, { homeDir: home, workspaceDir: repo });
        assert.equal(rmWt.removed, true);
        assert.equal(listWorktrees({ homeDir: home, workspaceDir: repo }).length, 0);
    });

    it('runs silent background verification and computes session burn + cache health warnings', async () => {
        fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
            name: 'sample',
            scripts: { test: 'node -e "console.log(\'3 passed\')"' },
        }));
        assert.equal(detectVerifyCommand(repo), 'npm test');
        const okRes = await runVerify({ homeDir: home, workspaceDir: repo });
        assert.equal(okRes.ok, true);
        assert.match(okRes.summaryLine, /3 passed/);

        const raw = [
            JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 9000, cache_read_tokens: 1000, output_tokens: 100 }),
            JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 8000, cache_read_tokens: 2000, output_tokens: 150 }),
            JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 8500, cache_read_tokens: 1500, output_tokens: 200 }),
        ].join('\n');
        const parsed = parseTranscriptV1(raw, 'conv-burn');
        assert.equal(parsed.sessionInputTokens, 25500);
        assert.equal(parsed.sessionCacheReadTokens, 4500);
        assert.equal(parsed.sessionOutputTokens, 450);
        assert.equal(parsed.cacheHealth.status, 'WARN');
    });
});
