'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runDoctor, formatDoctor } = require('../src/doctor');

let tmp;
let home;
let ws;

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxpilot-doc-'));
    home = path.join(tmp, 'home');
    ws = path.join(tmp, 'sample-app');
    fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.agents', 'rules'), { recursive: true });
});

afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('doctor rules & exit codes', () => {
    it('marks READONLY=true DB server as OK (not WARN)', async () => {
        const fakeBin = path.join(tmp, 'fake-db-mcp.js');
        fs.writeFileSync(fakeBin, '// stub');
        fs.writeFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({
            mcpServers: {
                mssql: {
                    command: process.execPath,
                    args: [fakeBin],
                    env: { SERVER_NAME: 'localhost', READONLY: 'true' },
                },
            },
        }));
        fs.writeFileSync(path.join(ws, '.agents', 'rules', '01-style.md'), '---\ntrigger: always_on\n---\nKeep functions small.\n');

        const report = await runDoctor({ homeDir: home, workspaceDir: ws });
        assert.equal(report.exitCode, 0);
        assert.equal(report.summary.fail, 0);
        assert.equal(report.summary.warn, 0);
        const dbFinding = report.findings.find(f => f.category === 'mcp-db');
        assert.equal(dbFinding.level, 'OK');
        assert.match(dbFinding.message, /READONLY=true \(safe\) \| host=localhost/);
    });

    it('marks READONLY=false DB server as WARN and respects --strict exit code', async () => {
        fs.writeFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({
            mcpServers: {
                postgres: {
                    command: process.execPath,
                    args: [],
                    env: { PGHOST: 'db.internal', READONLY: 'false' },
                },
            },
        }));

        const normal = await runDoctor({ homeDir: home, workspaceDir: ws });
        assert.equal(normal.exitCode, 0);
        assert.equal(normal.summary.warn, 1);

        const strict = await runDoctor({ homeDir: home, workspaceDir: ws, strict: true });
        assert.equal(strict.exitCode, 1);
    });

    it('fails with exitCode 1 on plaintext secret, missing binary, and oversized rule without leaking prefix', async () => {
        const secret = 'sk-proj-fakeSecretPrefix9876543210';
        fs.writeFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({
            mcpServers: {
                remoteApi: {
                    url: 'https://mcp.example.com/mcp',
                    headers: { Authorization: `Bearer ${secret}` },
                },
                brokenBin: {
                    command: path.join(tmp, 'does-not-exist.exe'),
                },
            },
        }));
        fs.writeFileSync(path.join(ws, '.agents', 'rules', 'huge.md'), 'x'.repeat(25000));

        const report = await runDoctor({ homeDir: home, workspaceDir: ws, fixSuggest: true });
        assert.equal(report.exitCode, 1);
        assert.equal(report.summary.fail >= 3, true);

        const rendered = formatDoctor(report, { fixSuggest: true });
        const jsonOut = JSON.stringify(report);
        assert.equal(rendered.includes('sk-proj'), false);
        assert.equal(jsonOut.includes('sk-proj'), false);
        assert.equal(rendered.includes('[REDACTED: bearer-token]'), true);
        assert.equal(rendered.includes('${REMOTEAPI_API_KEY}'), true);
    });
});
