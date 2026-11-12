'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parkServer, unparkServer, setReadonly, applyProfile } = require('../src/mcp-control');

let tmp, home, ws, cfgPath;

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxpilot-ctrl-'));
    home = path.join(tmp, 'home');
    ws = path.join(tmp, 'ws');
    cfgPath = path.join(home, '.gemini', 'config', 'mcp_config.json');
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.mkdirSync(path.join(ws, '.agents', 'rules'), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify({
        mcpServers: {
            serena: { command: 'serena', args: [] },
            context7: { url: 'https://mcp.context7.com/mcp' },
            mssql: { command: 'node', args: [], env: { READONLY: 'false' } },
        },
    }));
});

afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('MCP park/unpark, RO/RW & profiles', () => {
    it('supports --dry-run without modifying files', () => {
        const res = parkServer('mssql', { homeDir: home, workspaceDir: ws, dryRun: true });
        assert.equal(res.dryRun, true);
        assert.equal(Boolean(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).mcpServers.mssql), true);
    });

    it('parks, unparks, toggles RO, and writes 00-active-mcps.md with frontmatter', () => {
        parkServer('mssql', { homeDir: home, workspaceDir: ws });
        assert.equal(Boolean(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).mcpServers.mssql), false);
        const rule = fs.readFileSync(path.join(ws, '.agents', 'rules', '00-active-mcps.md'), 'utf8');
        assert.match(rule, /^---\ntrigger: always_on|trigger: always_on/);
        assert.match(rule, /mssql/);

        unparkServer('mssql', { homeDir: home, workspaceDir: ws });
        assert.equal(Boolean(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).mcpServers.mssql), true);

        setReadonly('mssql', true, { homeDir: home, workspaceDir: ws });
        assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).mcpServers.mssql.env.READONLY, 'true');
    });

    it('applies db-ro profile: parks context7 and enforces READONLY=true on mssql', () => {
        applyProfile('db-ro', { homeDir: home, workspaceDir: ws });
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).mcpServers;
        assert.equal(Boolean(cfg.context7), false);
        assert.equal(Boolean(cfg.serena), true);
        assert.equal(cfg.mssql.env.READONLY, 'true');
    });
});
