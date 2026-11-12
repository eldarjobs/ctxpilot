'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const RULE_MAX_BYTES = 24000;
const RULES_AGGREGATE_TOKEN_BUDGET = 20000;

function safeReadText(p) {
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function tryParseJson(p) {
    if (!fs.existsSync(p)) return { exists: false, data: null, error: null };
    try {
        return { exists: true, data: JSON.parse(fs.readFileSync(p, 'utf8')), error: null };
    } catch (e) {
        return { exists: true, data: null, error: e.message };
    }
}

function decodeFolderUri(uri) {
    if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
    try {
        let p = decodeURIComponent(uri.replace(/^file:\/\//, ''));
        if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
        return path.normalize(p);
    } catch {
        return null;
    }
}

function resolveWorkspace(opts = {}) {
    if (opts.workspaceDir) return path.resolve(opts.workspaceDir);
    const homeDir = opts.homeDir || os.homedir();
    const cwd = opts.cwd || process.cwd();
    const cfgDir = path.join(homeDir, '.gemini', 'config');

    const pinned = tryParseJson(path.join(cfgDir, 'hub_workspace.json'));
    if (pinned.data && typeof pinned.data.workspace === 'string' && fs.existsSync(pinned.data.workspace)) {
        return pinned.data.workspace;
    }

    const isGenericCwd = /\\(AppData|System32|Windows|Programs\\Antigravity)/i.test(cwd);
    if (!isGenericCwd && (fs.existsSync(path.join(cwd, '.git')) || fs.existsSync(path.join(cwd, '.agents')) || fs.existsSync(path.join(cwd, 'package.json')))) {
        return cwd;
    }

    const projDir = path.join(cfgDir, 'projects');
    if (fs.existsSync(projDir)) {
        try {
            const files = fs.readdirSync(projDir)
                .filter(f => f.endsWith('.json') && f !== 'outside-of-project.json')
                .map(f => ({ full: path.join(projDir, f), mtime: fs.statSync(path.join(projDir, f)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);
            for (const f of files) {
                const parsed = tryParseJson(f.full);
                const res = parsed.data?.projectResources?.resources;
                if (!Array.isArray(res)) continue;
                for (const r of res) {
                    const p = decodeFolderUri(r.folderUri);
                    if (p && fs.existsSync(p)) return p;
                }
            }
        } catch {}
    }

    return cwd;
}

function getPaths(opts = {}) {
    const homeDir = opts.homeDir || os.homedir();
    const geminiDir = path.join(homeDir, '.gemini');
    const cfgDir = path.join(geminiDir, 'config');
    const workspaceDir = resolveWorkspace({ homeDir, workspaceDir: opts.workspaceDir, cwd: opts.cwd });
    return {
        homeDir,
        geminiDir,
        cfgDir,
        workspaceDir,
        mcpConfigs: [
            path.join(cfgDir, 'mcp_config.json'),
            path.join(geminiDir, 'antigravity', 'mcp_config.json'),
            path.join(geminiDir, 'antigravity-ide', 'mcp_config.json'),
        ],
        mcpToolDirs: [
            path.join(geminiDir, 'antigravity', 'mcp'),
            path.join(geminiDir, 'antigravity-ide', 'mcp'),
        ],
        togglesPath: path.join(cfgDir, 'mcp_toggles.json'),
        disabledPath: path.join(cfgDir, 'mcp_disabled.json'),
        brainDir: path.join(geminiDir, 'antigravity', 'brain'),
    };
}

function discoverMcp(paths) {
    const configFiles = [];
    const servers = new Map();

    for (const cfgPath of paths.mcpConfigs) {
        const parsed = tryParseJson(cfgPath);
        if (!parsed.exists) continue;
        configFiles.push({ path: cfgPath, error: parsed.error });
        if (!parsed.data || !parsed.data.mcpServers || typeof parsed.data.mcpServers !== 'object') continue;
        for (const [id, def] of Object.entries(parsed.data.mcpServers)) {
            if (servers.has(id)) continue;
            const transport = def.command ? 'stdio' : (def.serverUrl || def.url) ? 'http' : 'unknown';
            servers.set(id, {
                id,
                transport,
                def,
                source: cfgPath,
                disabledInConfig: Boolean(def.disabled),
                parked: false,
                tools: [],
                schemaBytes: 0,
            });
        }
    }

    const disabledParsed = tryParseJson(paths.disabledPath);
    if (disabledParsed.data && typeof disabledParsed.data === 'object') {
        for (const [id, entry] of Object.entries(disabledParsed.data)) {
            if (servers.has(id)) continue;
            const def = (entry && entry.def) || {};
            servers.set(id, {
                id,
                transport: def.command ? 'stdio' : (def.serverUrl || def.url) ? 'http' : 'unknown',
                def,
                source: entry?.source || paths.disabledPath,
                disabledInConfig: true,
                parked: true,
                tools: [],
                schemaBytes: 0,
            });
        }
    }

    for (const dir of paths.mcpToolDirs) {
        if (!fs.existsSync(dir)) continue;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const ent of entries) {
            if (!ent.isDirectory()) continue;
            const srvDir = path.join(dir, ent.name);
            let files = [];
            try { files = fs.readdirSync(srvDir).filter(f => f.endsWith('.json')); } catch { continue; }
            let totalBytes = 0;
            const tools = [];
            for (const f of files) {
                const full = path.join(srvDir, f);
                try {
                    totalBytes += fs.statSync(full).size;
                    tools.push(f.slice(0, -5));
                } catch {}
            }
            const existing = servers.get(ent.name) || {
                id: ent.name,
                transport: 'plugin',
                def: {},
                source: dir,
                disabledInConfig: false,
                parked: false,
                tools: [],
                schemaBytes: 0,
            };
            if (totalBytes > existing.schemaBytes || tools.length > existing.tools.length) {
                existing.tools = tools;
                existing.schemaBytes = totalBytes;
            }
            servers.set(ent.name, existing);
        }
    }

    const togglesParsed = tryParseJson(paths.togglesPath);
    const toggles = (togglesParsed.data && typeof togglesParsed.data === 'object') ? togglesParsed.data : {};

    return {
        configFiles,
        toggles,
        servers: [...servers.values()],
    };
}

function parseFrontmatter(text) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return {};
    const out = {};
    for (const line of m[1].split(/\r?\n/)) {
        const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
        if (kv) out[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '');
    }
    return out;
}

function discoverRules(workspaceDir) {
    const rulesDir = path.join(workspaceDir, '.agents', 'rules');
    const items = [];

    for (const rootDoc of ['AGENTS.md', 'GEMINI.md']) {
        const p = path.join(workspaceDir, rootDoc);
        if (fs.existsSync(p)) {
            const text = safeReadText(p) || '';
            items.push({
                name: rootDoc,
                path: p,
                trigger: 'always_on',
                bytes: Buffer.byteLength(text, 'utf8'),
                source: 'root',
            });
        }
    }

    if (fs.existsSync(rulesDir)) {
        let files = [];
        try { files = fs.readdirSync(rulesDir).filter(f => f.endsWith('.md')).sort(); } catch {}
        for (const f of files) {
            const p = path.join(rulesDir, f);
            const text = safeReadText(p) || '';
            const fm = parseFrontmatter(text);
            items.push({
                name: f,
                path: p,
                trigger: fm.trigger || 'always_on',
                bytes: Buffer.byteLength(text, 'utf8'),
                text,
                source: '.agents/rules',
            });
        }
    }

    return { rulesDir, items };
}

function discoverSkills(paths) {
    const dirs = [
        { dir: path.join(paths.workspaceDir, '.agents', 'skills'), scope: 'project' },
        { dir: path.join(paths.cfgDir, 'skills'), scope: 'global' },
    ];
    const pluginsDir = path.join(paths.cfgDir, 'plugins');
    if (fs.existsSync(pluginsDir)) {
        try {
            for (const p of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
                if (p.isDirectory()) dirs.push({ dir: path.join(pluginsDir, p.name, 'skills'), scope: `plugin:${p.name}` });
            }
        } catch {}
    }

    const skills = [];
    for (const entry of dirs) {
        if (!fs.existsSync(entry.dir)) continue;
        let subs = [];
        try { subs = fs.readdirSync(entry.dir, { withFileTypes: true }); } catch { continue; }
        for (const sub of subs) {
            if (!sub.isDirectory()) continue;
            const skillFile = path.join(entry.dir, sub.name, 'SKILL.md');
            if (!fs.existsSync(skillFile)) continue;
            const head = (safeReadText(skillFile) || '').slice(0, 1200);
            const fm = parseFrontmatter(head);
            const headerBytes = Buffer.byteLength(`${sub.name}: ${fm.description || ''}`, 'utf8');
            skills.push({ name: sub.name, scope: entry.scope, headerBytes });
        }
    }
    return skills;
}

module.exports = {
    RULE_MAX_BYTES,
    RULES_AGGREGATE_TOKEN_BUDGET,
    tryParseJson,
    resolveWorkspace,
    getPaths,
    discoverMcp,
    discoverRules,
    discoverSkills,
};
