import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const coreDir = fs.existsSync(path.join(__dirname, 'core')) ? path.join(__dirname, 'core') : path.resolve(__dirname, '../../../src');

const { analyzeContext } = require(path.join(coreDir, 'context.js'));
const { runDoctor } = require(path.join(coreDir, 'doctor.js'));
const { getPaths, discoverMcp, discoverRules, tryParseJson } = require(path.join(coreDir, 'discovery.js'));
const { parkServer, unparkServer, setReadonly, applyProfile, listProfiles } = require(path.join(coreDir, 'mcp-control.js'));

let restartPending = false;

function listRulesAndDisabled(workspaceDir) {
    const rulesDir = path.join(workspaceDir, '.agents', 'rules');
    const active = discoverRules(workspaceDir).items.filter(r => r.source === '.agents/rules' && r.name !== '00-active-mcps.md')
        .map(r => ({ name: r.name, enabled: true, trigger: r.trigger, bytes: r.bytes }));
    const disabled = [];
    if (fs.existsSync(rulesDir)) {
        for (const f of fs.readdirSync(rulesDir)) {
            if (!f.endsWith('.md.disabled')) continue;
            const p = path.join(rulesDir, f);
            disabled.push({ name: f.slice(0, -'.disabled'.length), enabled: false, trigger: 'disabled', bytes: fs.statSync(p).size });
        }
    }
    return [...active, ...disabled].sort((a, b) => a.name.localeCompare(b.name));
}

function listHooks(workspaceDir) {
    const hp = path.join(workspaceDir, '.agents', 'hooks.json');
    const parsed = tryParseJson(hp);
    if (!parsed.data || typeof parsed.data !== 'object') return [];
    return Object.entries(parsed.data).map(([name, cfg]) => ({
        name,
        enabled: cfg.enabled !== false,
        events: ['SessionStart', 'PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop'].filter(e => Boolean(cfg[e])),
    }));
}

async function buildSnapshot(convId) {
    const paths = getPaths({});
    const mcp = discoverMcp(paths);
    const ctx = analyzeContext({ conv: convId || undefined });
    const doc = await runDoctor({});
    return {
        workspace: paths.workspaceDir,
        restartPending,
        context: ctx,
        doctor: doc,
        servers: mcp.servers.map(s => {
            const env = (s.def && s.def.env) || {};
            const roKey = ['READONLY', 'DB_READONLY'].find(k => Object.prototype.hasOwnProperty.call(env, k));
            return {
                id: s.id,
                transport: s.transport,
                parked: s.parked,
                configurable: paths.mcpConfigs.includes(s.source) || s.parked,
                toolCount: s.tools.length,
                tools: s.tools,
                schemaBytes: s.schemaBytes,
                readonly: roKey ? String(env[roKey]).toLowerCase() === 'true' : null,
            };
        }),
        profiles: Object.entries(listProfiles({})).map(([id, p]) => ({ id, description: p.description || '' })),
        rules: listRulesAndDisabled(paths.workspaceDir),
        hooks: listHooks(paths.workspaceDir),
    };
}

async function handleAction(body) {
    const { action, id, name, enabled, profile } = body || {};
    const paths = getPaths({});

    if (action === 'park') { parkServer(id); restartPending = true; }
    else if (action === 'unpark') { unparkServer(id); restartPending = true; }
    else if (action === 'toggle-ro') { setReadonly(id, Boolean(enabled)); restartPending = true; }
    else if (action === 'profile') {
        const res = applyProfile(profile);
        if (res.changes.length > 0) restartPending = true;
    } else if (action === 'toggle-rule') {
        if (!/^[\w.-]+\.md$/.test(String(name)) || name === '00-active-mcps.md') throw new Error('Invalid rule name');
        const rulesDir = path.join(paths.workspaceDir, '.agents', 'rules');
        const on = path.join(rulesDir, name);
        const off = on + '.disabled';
        if (enabled && fs.existsSync(off)) fs.renameSync(off, on);
        if (!enabled && fs.existsSync(on)) fs.renameSync(on, off);
    } else if (action === 'toggle-hook') {
        const hp = path.join(paths.workspaceDir, '.agents', 'hooks.json');
        const parsed = tryParseJson(hp);
        if (parsed.data && parsed.data[name]) {
            parsed.data[name].enabled = Boolean(enabled);
            fs.writeFileSync(hp, JSON.stringify(parsed.data, null, 2) + '\n', 'utf8');
        }
    }
    return buildSnapshot();
}

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
    const { SidecarApp } = await import('sidecar_sdk');
    const app = new SidecarApp();
    app.page('/', () => html);
    app.api('/api/state', (data) => buildSnapshot(data?.conversationId || app.config.conversationId), 'GET');
    app.api('/api/action', (data) => handleAction(data), 'POST');
    app.run();
} else {
    // Standalone preview fallback when run outside Antigravity
    const http = require('node:http');
    const port = Number(process.env.PORT || 47123);
    http.createServer(async (req, res) => {
        try {
            if (req.method === 'GET' && req.url.startsWith('/api/state')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(await buildSnapshot()));
                return;
            }
            if (req.method === 'POST' && req.url === '/api/action') {
                let raw = '';
                req.on('data', c => { raw += c; });
                req.on('end', async () => {
                    try {
                        const out = await handleAction(JSON.parse(raw || '{}'));
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(out));
                    } catch (e) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                });
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
        } catch (e) {
            res.writeHead(500);
            res.end(e.message);
        }
    }).listen(port, '127.0.0.1', () => {
        console.log(`CtxPilot UI running at http://127.0.0.1:${port}`);
    });
}
