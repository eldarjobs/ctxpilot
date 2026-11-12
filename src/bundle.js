'use strict';
const fs = require('fs');
const path = require('path');
const { getPaths, discoverMcp, tryParseJson } = require('./discovery');
const { scanServerSecrets } = require('./redact');
const { syncActiveMcpRule } = require('./mcp-control');

function sanitizeDef(serverId, def, strict) {
    const clone = JSON.parse(JSON.stringify(def || {}));
    const findings = scanServerSecrets(serverId, clone);
    const requiredEnvVars = [];

    if (findings.length > 0 && strict) {
        const list = findings.map(f => `${f.serverId}.${f.location}.${f.key}`).join(', ');
        throw new Error(`Plaintext secret detected (${list}). Run "ctx doctor --fix" or omit --strict to sanitize.`);
    }

    for (const sec of findings) {
        const envVar = sec.suggestion.envVar;
        requiredEnvVars.push(envVar);
        const isBearer = sec.secretType === 'bearer-token' || (/^authorization$/i.test(sec.key) && clone.headers && /^Bearer\s+/i.test(String(clone.headers[sec.key])));
        const placeholder = isBearer ? `Bearer \${${envVar}}` : `\${${envVar}}`;
        if (sec.location === 'headers' && clone.headers) clone.headers[sec.key] = placeholder;
        else if (sec.location === 'env' && clone.env) clone.env[sec.key] = placeholder;
        else if (sec.location.startsWith('args[') && Array.isArray(clone.args)) {
            clone.args[Number(sec.location.slice(5, -1))] = placeholder;
        }
    }
    return { def: clone, sanitizedCount: findings.length, requiredEnvVars };
}

function exportBundle(opts = {}) {
    const paths = getPaths(opts);
    const mcp = discoverMcp(paths);
    const outFile = path.resolve(opts.workspaceDir ? paths.workspaceDir : process.cwd(), opts.out || 'ctxpilot-bundle.json');

    const rulesDir = path.join(paths.workspaceDir, '.agents', 'rules');
    const rules = {};
    if (fs.existsSync(rulesDir)) {
        for (const f of fs.readdirSync(rulesDir).filter(x => x.endsWith('.md') && x !== '00-active-mcps.md').sort()) {
            rules[f] = fs.readFileSync(path.join(rulesDir, f), 'utf8');
        }
    }

    const hooks = tryParseJson(path.join(paths.workspaceDir, '.agents', 'hooks.json')).data || null;
    const hub = tryParseJson(path.join(paths.workspaceDir, '.agents', 'hub.json')).data || null;

    const mcpServers = {};
    const requiredEnvVars = new Set();
    let sanitizedSecrets = 0;

    for (const srv of mcp.servers) {
        if (!paths.mcpConfigs.includes(srv.source) || srv.parked) continue;
        const res = sanitizeDef(srv.id, srv.def, Boolean(opts.strict));
        mcpServers[srv.id] = res.def;
        sanitizedSecrets += res.sanitizedCount;
        for (const v of res.requiredEnvVars) requiredEnvVars.add(v);
    }

    const bundle = {
        version: 1,
        exportedAt: new Date().toISOString(),
        rules,
        hooks,
        hub,
        mcpServers,
        requiredEnvVars: [...requiredEnvVars],
    };

    if (!opts.dryRun) {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
    }

    return {
        action: 'bundle-export',
        dryRun: Boolean(opts.dryRun),
        outFile,
        ruleCount: Object.keys(rules).length,
        hasHooks: Boolean(hooks),
        hasHub: Boolean(hub),
        mcpCount: Object.keys(mcpServers).length,
        sanitizedSecrets,
        requiredEnvVars: bundle.requiredEnvVars,
    };
}

function writeTargetFile(filePath, content, opts, results) {
    const existed = fs.existsSync(filePath);
    if (existed && !opts.overwrite) {
        results.push({ path: filePath, status: 'skipped' });
        return;
    }
    if (!opts.dryRun) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf8');
    }
    results.push({ path: filePath, status: opts.dryRun ? 'would-write' : (existed ? 'overwritten' : 'created') });
}

function importBundle(bundleFile, opts = {}) {
    if (!bundleFile) throw new Error('Usage: ctx bundle import <file> [--dry-run] [--overwrite]');
    const fullBundlePath = path.resolve(bundleFile);
    const parsed = tryParseJson(fullBundlePath);
    if (!parsed.exists || !parsed.data || parsed.data.version !== 1) {
        throw new Error(`Invalid or missing ctxpilot bundle (expected version 1): ${fullBundlePath}`);
    }

    const bundle = parsed.data;
    const paths = getPaths(opts);
    const files = [];
    const rulesDir = path.join(paths.workspaceDir, '.agents', 'rules');

    if (bundle.rules && typeof bundle.rules === 'object') {
        for (const [name, text] of Object.entries(bundle.rules)) {
            if (!/^[\w.-]+\.md$/.test(name) || name === '00-active-mcps.md') {
                throw new Error(`Unsafe rule filename in bundle: ${name}`);
            }
            writeTargetFile(path.join(rulesDir, name), String(text), opts, files);
        }
    }

    if (bundle.hooks && typeof bundle.hooks === 'object') {
        writeTargetFile(path.join(paths.workspaceDir, '.agents', 'hooks.json'), JSON.stringify(bundle.hooks, null, 2) + '\n', opts, files);
    }
    if (bundle.hub && typeof bundle.hub === 'object') {
        writeTargetFile(path.join(paths.workspaceDir, '.agents', 'hub.json'), JSON.stringify(bundle.hub, null, 2) + '\n', opts, files);
    }

    const mcpResults = [];
    if (bundle.mcpServers && typeof bundle.mcpServers === 'object' && Object.keys(bundle.mcpServers).length > 0) {
        const targetCfg = paths.mcpConfigs.find(p => fs.existsSync(p)) || paths.mcpConfigs[0];
        const cfg = tryParseJson(targetCfg).data || { mcpServers: {} };
        cfg.mcpServers = cfg.mcpServers || {};
        let cfgDirty = false;

        for (const [id, rawDef] of Object.entries(bundle.mcpServers)) {
            const sanitized = sanitizeDef(id, rawDef, true);
            const existed = Object.prototype.hasOwnProperty.call(cfg.mcpServers, id);
            if (existed && !opts.overwrite) {
                mcpResults.push({ id, status: 'skipped' });
                continue;
            }
            cfg.mcpServers[id] = sanitized.def;
            cfgDirty = true;
            mcpResults.push({ id, status: opts.dryRun ? 'would-write' : (existed ? 'overwritten' : 'added') });
        }

        if (cfgDirty && !opts.dryRun) {
            fs.mkdirSync(path.dirname(targetCfg), { recursive: true });
            const tmp = `${targetCfg}.tmp.${process.pid}`;
            fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
            fs.renameSync(tmp, targetCfg);
            syncActiveMcpRule(opts);
        }
    }

    return {
        action: 'bundle-import',
        dryRun: Boolean(opts.dryRun),
        bundleFile: fullBundlePath,
        files,
        mcpResults,
    };
}

module.exports = { exportBundle, importBundle };
