'use strict';
const fs = require('fs');
const path = require('path');
const { getPaths, discoverMcp, tryParseJson } = require('./discovery');

const BUILTIN_PROFILES = {
    full: {
        description: 'Enable all configured MCP servers',
        keep: '*',
    },
    'code-docs': {
        description: 'Keep code intelligence & docs servers; park DB/browser servers',
        keep: ['serena', 'context7', 'graphify', 'sequential-thinking', 'microsoft-learn', 'github'],
    },
    'db-ro': {
        description: 'Keep database servers in READONLY=true mode + serena; park others',
        keep: ['mssql', 'postgres', 'postgresql', 'mysql', 'sqlite', 'serena'],
        forceReadonly: true,
    },
    lean: {
        description: 'Minimal context: park all servers except serena',
        keep: ['serena'],
    },
};

function readJsonOrEmpty(p, fallback) {
    const parsed = tryParseJson(p);
    return parsed.data || fallback;
}

function writeJsonAtomic(p, obj) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, p);
}

function findReadonlyKey(env) {
    if (!env || typeof env !== 'object') return null;
    return ['READONLY', 'DB_READONLY'].find(k => Object.prototype.hasOwnProperty.call(env, k)) || null;
}

function syncActiveMcpRule(opts = {}) {
    const paths = getPaths(opts);
    const mcp = discoverMcp(paths);
    const rulesDir = path.join(paths.workspaceDir, '.agents', 'rules');
    const ruleFile = path.join(rulesDir, '00-active-mcps.md');
    const active = mcp.servers.filter(s => !s.parked && !s.disabledInConfig && mcp.toggles[s.id] !== false);
    const off = mcp.servers.filter(s => s.parked || s.disabledInConfig || mcp.toggles[s.id] === false).map(s => s.id);

    if (active.length === 0) {
        if (!opts.dryRun && fs.existsSync(ruleFile)) fs.unlinkSync(ruleFile);
        return { updated: true, activeCount: 0, ruleFile };
    }

    let md = '---\nname: active-mcp-servers\ndescription: MCP servers enabled via ctxpilot and how to use them proactively.\ntrigger: always_on\n---\n\n';
    md += '# Proactive MCP Tool Usage Policy\n\n';
    md += 'Active MCP servers in this workspace. Use their tools proactively when relevant:\n\n';
    if (active.some(s => s.id === 'serena')) {
        md += '**Serena first for code navigation**: call serena `initial_instructions` once per session, then prefer Serena symbol tools over text grep.\n\n';
    }
    for (const s of active) {
        const roKey = findReadonlyKey(s.def && s.def.env);
        const roNote = roKey ? ` (READONLY=${String(s.def.env[roKey]).toLowerCase() === 'true'})` : '';
        const toolsNote = s.tools.length ? ` Tools: ${s.tools.join(', ')}.` : '';
        md += `- **${s.id}**${roNote}:${toolsNote || ' Active MCP server.'}\n`;
    }
    if (off.length) {
        md += `\nParked/disabled servers (do not rely on them): ${off.join(', ')}.\n`;
    }

    if (!opts.dryRun) {
        fs.mkdirSync(rulesDir, { recursive: true });
        fs.writeFileSync(ruleFile, md, 'utf8');
    }
    return { updated: true, activeCount: active.length, ruleFile };
}

function parkServer(id, opts = {}) {
    const paths = getPaths(opts);
    const parked = readJsonOrEmpty(paths.disabledPath, {});
    const mcp = discoverMcp(paths);
    const srv = mcp.servers.find(s => s.id === id);
    if (!srv) throw new Error(`MCP server "${id}" not found.`);
    if (srv.parked) return { id, action: 'noop', reason: 'already parked', dryRun: Boolean(opts.dryRun) };
    if (!paths.mcpConfigs.includes(srv.source)) {
        throw new Error(`MCP server "${id}" comes from "${srv.source}" (plugin-managed, cannot park).`);
    }

    if (!opts.dryRun) {
        const cfg = readJsonOrEmpty(srv.source, { mcpServers: {} });
        parked[id] = { source: srv.source, def: cfg.mcpServers[id], parkedAt: new Date().toISOString() };
        delete cfg.mcpServers[id];
        writeJsonAtomic(srv.source, cfg);
        writeJsonAtomic(paths.disabledPath, parked);
        syncActiveMcpRule(opts);
    }
    return { id, action: 'park', source: srv.source, dryRun: Boolean(opts.dryRun), restartRequired: true };
}

function unparkServer(id, opts = {}) {
    const paths = getPaths(opts);
    const parked = readJsonOrEmpty(paths.disabledPath, {});
    const entry = parked[id];
    if (!entry) {
        const mcp = discoverMcp(paths);
        if (mcp.servers.some(s => s.id === id)) return { id, action: 'noop', reason: 'already active', dryRun: Boolean(opts.dryRun) };
        throw new Error(`MCP server "${id}" not found in mcp_disabled.json.`);
    }

    const targetCfg = entry.source && fs.existsSync(path.dirname(entry.source)) ? entry.source : paths.mcpConfigs[0];
    if (!opts.dryRun) {
        const cfg = readJsonOrEmpty(targetCfg, { mcpServers: {} });
        cfg.mcpServers = cfg.mcpServers || {};
        cfg.mcpServers[id] = entry.def;
        writeJsonAtomic(targetCfg, cfg);
        delete parked[id];
        writeJsonAtomic(paths.disabledPath, parked);
        syncActiveMcpRule(opts);
    }
    return { id, action: 'unpark', target: targetCfg, dryRun: Boolean(opts.dryRun), restartRequired: true };
}

function setReadonly(id, readonlyBool, opts = {}) {
    const paths = getPaths(opts);
    const mcp = discoverMcp(paths);
    const srv = mcp.servers.find(s => s.id === id);
    if (!srv) throw new Error(`MCP server "${id}" not found.`);
    const roKey = findReadonlyKey(srv.def && srv.def.env) || 'READONLY';
    const nextVal = readonlyBool ? 'true' : 'false';

    if (!opts.dryRun) {
        if (srv.parked) {
            const parked = readJsonOrEmpty(paths.disabledPath, {});
            parked[id].def.env = parked[id].def.env || {};
            parked[id].def.env[roKey] = nextVal;
            writeJsonAtomic(paths.disabledPath, parked);
        } else {
            const cfg = readJsonOrEmpty(srv.source, { mcpServers: {} });
            cfg.mcpServers[id].env = cfg.mcpServers[id].env || {};
            cfg.mcpServers[id].env[roKey] = nextVal;
            writeJsonAtomic(srv.source, cfg);
        }
        syncActiveMcpRule(opts);
    }
    return { id, action: 'readonly', key: roKey, value: nextVal, dryRun: Boolean(opts.dryRun), restartRequired: !srv.parked };
}

function listProfiles(opts = {}) {
    const paths = getPaths(opts);
    const custom = readJsonOrEmpty(path.join(paths.cfgDir, 'mcp_profiles.json'), {});
    return { ...BUILTIN_PROFILES, ...custom };
}

function applyProfile(profileName, opts = {}) {
    const profiles = listProfiles(opts);
    const prof = profiles[profileName];
    if (!prof) {
        throw new Error(`Unknown profile "${profileName}". Available: ${Object.keys(profiles).join(', ')}`);
    }
    const paths = getPaths(opts);
    const mcp = discoverMcp(paths);
    const changes = [];

    for (const srv of mcp.servers) {
        if (!paths.mcpConfigs.includes(srv.source) && !srv.parked) continue;
        const shouldKeep = prof.keep === '*' || (Array.isArray(prof.keep) && prof.keep.includes(srv.id));
        if (shouldKeep && srv.parked) {
            changes.push(unparkServer(srv.id, opts));
        } else if (!shouldKeep && !srv.parked) {
            changes.push(parkServer(srv.id, opts));
        }
        if (shouldKeep && prof.forceReadonly && findReadonlyKey(srv.def && srv.def.env)) {
            changes.push(setReadonly(srv.id, true, opts));
        }
    }

    return { profile: profileName, description: prof.description || '', dryRun: Boolean(opts.dryRun), changes };
}

module.exports = {
    BUILTIN_PROFILES,
    parkServer,
    unparkServer,
    setReadonly,
    listProfiles,
    applyProfile,
    syncActiveMcpRule,
};
