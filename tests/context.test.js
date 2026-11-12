'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyzeContext, formatContext } = require('../src/context');
const { getPaths } = require('../src/discovery');
const { parseTranscriptV1 } = require('../src/transcript-adapter');

let tmp;
let home;
let ws;

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxpilot-ctx-'));
    home = path.join(tmp, 'home');
    ws = path.join(tmp, 'sample-app');
    fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity', 'mcp', 'db-mcp'), { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity', 'mcp', 'docs-mcp'), { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity', 'brain', 'conv-1234', '.system_generated', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.agents', 'rules'), { recursive: true });
});

afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('context analyzer & transcript adapter', () => {
    it('computes rules, MCP schema bytes, shares, and transcript usage accurately', () => {
        fs.writeFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({
            mcpServers: {
                'db-mcp': { command: 'node', args: [] },
                'docs-mcp': { url: 'https://docs.example.com/mcp' },
                'off-mcp': { command: 'node', disabled: true },
            },
        }));
        fs.writeFileSync(path.join(home, '.gemini', 'antigravity', 'mcp', 'db-mcp', 'query.json'), 'a'.repeat(3500));
        fs.writeFileSync(path.join(home, '.gemini', 'antigravity', 'mcp', 'docs-mcp', 'search.json'), 'b'.repeat(700));
        fs.writeFileSync(path.join(ws, 'AGENTS.md'), 'c'.repeat(800));
        fs.writeFileSync(
            path.join(home, '.gemini', 'antigravity', 'brain', 'conv-1234', '.system_generated', 'logs', 'transcript.jsonl'),
            JSON.stringify({ type: 'USER_INPUT', content: 'hi' }) + '\n' +
            JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 1000, cache_read_tokens: 9000, output_tokens: 250 }) + '\n',
        );

        const report = analyzeContext({ homeDir: home, workspaceDir: ws });
        assert.equal(report.rules.alwaysOnTokensEst, 200);
        assert.equal(report.mcp.activeServerCount, 2);
        assert.equal(report.mcp.totalTokensEst, 1200); // (3500 + 700) / 3.5 = 1200
        assert.equal(report.staticOverheadTokensEst, 1400);
        assert.equal(report.mcp.shareOfStaticOverheadPct, 86); // Math.round(1200/1400*100)
        assert.equal(report.transcript.available, true);
        assert.equal(report.transcript.totalContextTokens, 10000);
        assert.equal(report.transcript.cacheHitPct, 90);
        assert.match(report.recommendation, /db-mcp/);

        const text = formatContext(report);
        assert.match(text, /est \+\/-20%/);
        assert.match(text, /86% of ~1,400 tok static overhead/);
    });

    it('degrades gracefully on corrupt or unknown transcript formats', () => {
        const corrupt = parseTranscriptV1('not-json\n{"foo":1}\n', 'conv-x');
        assert.equal(corrupt.available, false);
        assert.equal(corrupt.adapterVersion, 'v1');
    });

    it('auto-detects workspace from Antigravity gitFolder project files and titleHint', () => {
        const { pathToFileURL } = require('node:url');
        const repoA = path.join(tmp, 'alpha-repo');
        const repoB = path.join(tmp, 'beta-repo');
        fs.mkdirSync(repoA, { recursive: true });
        fs.mkdirSync(repoB, { recursive: true });
        fs.mkdirSync(path.join(home, '.gemini', 'config', 'projects'), { recursive: true });
        fs.writeFileSync(path.join(home, '.gemini', 'config', 'projects', 'a.json'), JSON.stringify({
            name: 'alpha-repo',
            projectResources: { resources: [{ gitFolder: { folderUri: pathToFileURL(repoA).href } }] },
        }));
        fs.writeFileSync(path.join(home, '.gemini', 'config', 'projects', 'b.json'), JSON.stringify({
            name: 'beta-repo',
            projectResources: { resources: [{ folderUri: pathToFileURL(repoB).href }] },
        }));

        const resolvedByTitle = getPaths({ homeDir: home, cwd: home, titleHint: 'alpha-repo - Antigravity' });
        assert.equal(resolvedByTitle.workspaceDir, path.resolve(repoA));
    });
});
