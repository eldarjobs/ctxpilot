'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { syncAgents } = require('../src/sync');
const { maybeAutoCheckpoint, listCheckpoints } = require('../src/checkpoint');
const { addFix, buildTurnTimeline, buildSubChatFromTurn } = require('../src/handoff');
const { runPrePushGate } = require('../src/gate');

function gitRun(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('Cross-Agent Sync, Auto-Checkpoint, Pre-Push Gate & Turn Timeline', () => {
    let tmp, home, repo;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxpilot-v06-'));
        home = path.join(tmp, 'home');
        repo = path.join(tmp, 'repo');
        fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
        fs.mkdirSync(path.join(repo, '.agents', 'rules'), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('syncs canonical AGENTS.md + rules + fixes into Claude, Cursor, Windsurf and sanitizes MCPs', () => {
        fs.writeFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({
            mcpServers: {
                context7: { url: 'https://mcp.context7.com/mcp', headers: { Authorization: 'Bearer ' + 'ctx7sk-' + 'supersecret12345' } },
            },
        }));
        fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Repo Conventions\n- Keep modules small.\n');
        fs.writeFileSync(path.join(repo, '.agents', 'rules', 'testing.md'), '---\ntrigger: always_on\n---\n- Run node --test before commit.\n');
        addFix('syncCoreCache copies patcher/', 'Avoids MODULE_NOT_FOUND', { homeDir: home, workspaceDir: repo });

        const res = syncAgents({ homeDir: home, workspaceDir: repo, mcp: true });
        assert.equal(res.written.some(w => w.target === 'claude' && w.status === 'created'), true);
        assert.equal(res.written.some(w => w.target === 'cursor' && w.status === 'created'), true);
        assert.equal(res.written.some(w => w.target === 'windsurf' && w.status === 'created'), true);

        const claudeMd = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
        assert.match(claudeMd, /Repo Conventions/);
        assert.match(claudeMd, /Run node --test/);
        assert.match(claudeMd, /syncCoreCache copies patcher\//);

        const mcpJson = fs.readFileSync(path.join(repo, '.mcp.json'), 'utf8');
        assert.equal(mcpJson.includes('ctx7sk-' + 'supersecret12345'), false);
        assert.match(mcpJson, /\$\{CONTEXT7_API_KEY\}/);
    });

    it('creates deduped auto-checkpoints, builds turn timeline, forks from any turn, and enforces pre-push gate', async () => {
        gitRun(['init'], repo);
        gitRun(['config', 'core.autocrlf', 'false'], repo);
        gitRun(['config', 'user.email', 'test@example.com'], repo);
        gitRun(['config', 'user.name', 'Test'], repo);
        fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 1;\n');
        fs.writeFileSync(path.join(repo, 'local.js'), 'export const l = 1;\n');
        gitRun(['add', 'a.js', 'local.js'], repo);
        gitRun(['commit', '-m', 'init'], repo);

        // Create transcript with 2 turns
        const convDir = path.join(home, '.gemini', 'antigravity', 'brain', 'conv-tl-1', '.system_generated', 'logs');
        fs.mkdirSync(convDir, { recursive: true });
        fs.writeFileSync(path.join(convDir, 'transcript.jsonl'), [
            JSON.stringify({ type: 'USER_INPUT', content: 'Update a.js to 2' }),
            JSON.stringify({
                type: 'PLANNER_RESPONSE',
                input_tokens: 2000,
                cache_read_tokens: 18000,
                output_tokens: 120,
                content: 'Updated a.js cleanly.',
                tool_calls: [{ name: 'edit_file', args: { Path: path.join(repo, 'a.js') } }],
            }),
            JSON.stringify({ type: 'USER_INPUT', content: 'Now add helper b' }),
            JSON.stringify({
                type: 'PLANNER_RESPONSE',
                input_tokens: 2500,
                cache_read_tokens: 20000,
                output_tokens: 140,
                content: 'Added helper b.',
            }),
        ].join('\n') + '\n');

        const tl = buildTurnTimeline({ homeDir: home, workspaceDir: repo });
        assert.equal(tl.turns.length, 2);
        assert.equal(tl.turns[0].filesEdited[0], 'a.js');

        const fork1 = buildSubChatFromTurn(1, { homeDir: home, workspaceDir: repo });
        assert.equal(fork1.turn, 1);
        assert.match(fork1.markdown, /Update a\.js to 2/);

        fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 2;\n');
        fs.writeFileSync(path.join(repo, 'local.js'), 'export const l = 99;\n');

        const cp1 = maybeAutoCheckpoint(1, tl.convId, { homeDir: home, workspaceDir: repo });
        assert.ok(cp1 && cp1.auto);
        // Same tree at turn 2 -> deduped (skipped)
        const cp2 = maybeAutoCheckpoint(2, tl.convId, { homeDir: home, workspaceDir: repo });
        assert.equal(cp2.skipped, true);
        assert.equal(listCheckpoints({ homeDir: home, workspaceDir: repo }).length, 1);

        // Gate clean run: attributes a.js to chatFiles and local.js to otherFiles
        fs.writeFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: {} }));
        const cleanGate = await runPrePushGate({ homeDir: home, workspaceDir: repo, skipVerify: true });
        assert.equal(cleanGate.ok, true);
        assert.deepEqual(cleanGate.chatFiles, ['a.js']);
        assert.deepEqual(cleanGate.otherFiles, ['local.js']);

        // Gate blocked when plaintext secret is added to diff
        fs.writeFileSync(path.join(repo, 'a.js'), 'const k = "' + 'ghp_' + '1234567890abcdef1234567890abcdef1234";\n');
        const blockedGate = await runPrePushGate({ homeDir: home, workspaceDir: repo, skipVerify: true });
        assert.equal(blockedGate.ok, false);
        assert.equal(blockedGate.blockers.some(b => b.type === 'diff-secret'), true);
    });
});
