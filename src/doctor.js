'use strict';
const fs = require('fs');
const path = require('path');
const { getPaths, discoverMcp, discoverRules, tryParseJson, RULE_MAX_BYTES, RULES_AGGREGATE_TOKEN_BUDGET } = require('./discovery');
const { scanServerSecrets } = require('./redact');
const { patchStatus } = require('./patcher');

const DB_SERVER_RE = /(mssql|postgres|postgresql|mysql|sqlite|mariadb|oracle|mongo)/i;

function resolveCommandOnPath(cmd) {
    if (!cmd || typeof cmd !== 'string') return null;
    if (path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) {
        return fs.existsSync(cmd) ? cmd : null;
    }
    const pathVar = process.env.PATH || '';
    const dirs = pathVar.split(path.delimiter).filter(Boolean);
    const exts = process.platform === 'win32'
        ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
        : [''];
    for (const dir of dirs) {
        for (const ext of exts) {
            const candidate = path.join(dir, cmd.endsWith(ext.toLowerCase()) || !ext ? cmd : cmd + ext);
            if (fs.existsSync(candidate)) return candidate;
            if (process.platform === 'win32') {
                const exact = path.join(dir, cmd);
                if (fs.existsSync(exact)) return exact;
            }
        }
    }
    return null;
}

function isDatabaseServer(srv) {
    if (DB_SERVER_RE.test(srv.id)) return true;
    const env = srv.def && srv.def.env;
    if (env && (Object.prototype.hasOwnProperty.call(env, 'READONLY') || Object.prototype.hasOwnProperty.call(env, 'DB_READONLY') || Object.prototype.hasOwnProperty.call(env, 'DATABASE_NAME'))) {
        return true;
    }
    return false;
}

function checkDatabaseSafety(srv) {
    if (!isDatabaseServer(srv)) return null;
    const env = (srv.def && srv.def.env) || {};
    const roKey = ['READONLY', 'DB_READONLY'].find(k => Object.prototype.hasOwnProperty.call(env, k));
    const host = env.SERVER_NAME || env.PGHOST || env.DB_HOST || env.HOST || null;
    const hostNote = host ? ` | host=${host}` : '';
    if (roKey && String(env[roKey]).toLowerCase() === 'true') {
        return { level: 'OK', detail: `${roKey}=true (safe)${hostNote}` };
    }
    if (roKey) {
        return { level: 'WARN', detail: `${roKey}=${String(env[roKey])} (write/DDL enabled)${hostNote}` };
    }
    return { level: 'WARN', detail: `READONLY flag not set on database MCP${hostNote}` };
}

async function pingUrl(urlStr) {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2500);
        const res = await fetch(urlStr, { method: 'HEAD', signal: ctrl.signal });
        clearTimeout(timer);
        return { ok: res.status < 500, status: res.status };
    } catch (e) {
        return { ok: false, error: e.name === 'AbortError' ? 'timeout (2.5s)' : e.message };
    }
}

async function runDoctor(opts = {}) {
    const paths = getPaths(opts);
    const mcp = discoverMcp(paths);
    const rules = discoverRules(paths.workspaceDir);
    const findings = [];
    const suggestions = [];

    const add = (category, target, level, message, extra) => {
        findings.push({ category, target, level, message, ...(extra || {}) });
    };

    // 1. MCP config files
    if (mcp.configFiles.length === 0) {
        add('mcp-config', paths.mcpConfigs[0], 'WARN', 'No mcp_config.json found');
    } else {
        for (const cf of mcp.configFiles) {
            if (cf.error) add('mcp-config', cf.path, 'FAIL', `Malformed JSON: ${cf.error}`);
            else add('mcp-config', cf.path, 'OK', 'Valid JSON');
        }
    }

    // 2. Each discovered MCP server
    for (const srv of mcp.servers) {
        if (srv.parked) {
            add('mcp-server', srv.id, 'OK', 'Parked (disabled in mcp_disabled.json)');
            continue;
        }
        if (srv.transport === 'stdio') {
            const cmd = srv.def.command;
            const resolved = resolveCommandOnPath(cmd);
            if (!cmd) {
                add('mcp-server', srv.id, 'FAIL', 'stdio server missing "command"');
            } else if (!resolved) {
                const isExplicitPath = path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\');
                add('mcp-server', srv.id, isExplicitPath ? 'FAIL' : 'WARN', `command not found: ${path.basename(cmd)}`);
            } else {
                // If node/python runs a script arg, check if first existing-looking arg exists
                const firstArg = Array.isArray(srv.def.args) && srv.def.args[0];
                if (firstArg && (path.isAbsolute(firstArg) || /\.(js|mjs|cjs|py)$/i.test(firstArg)) && !fs.existsSync(firstArg)) {
                    add('mcp-server', srv.id, 'FAIL', `entrypoint missing: ${path.basename(firstArg)}`);
                } else {
                    add('mcp-server', srv.id, 'OK', `stdio (${path.basename(cmd)})`);
                }
            }
        } else if (srv.transport === 'http') {
            const rawUrl = srv.def.serverUrl || srv.def.url;
            let parsedUrl = null;
            try { parsedUrl = new URL(rawUrl); } catch { }
            if (!parsedUrl) {
                add('mcp-server', srv.id, 'FAIL', 'Invalid HTTP server URL');
            } else if (parsedUrl.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname)) {
                add('mcp-server', srv.id, 'WARN', `Non-TLS HTTP endpoint (${parsedUrl.hostname})`);
            } else if (opts.ping) {
                const probe = await pingUrl(rawUrl);
                add('mcp-server', srv.id, probe.ok ? 'OK' : 'WARN', probe.ok ? `http reachable (HTTP ${probe.status})` : `http unreachable (${probe.error || probe.status})`);
            } else {
                add('mcp-server', srv.id, 'OK', `http (${parsedUrl.host})`);
            }
        } else {
            add('mcp-server', srv.id, 'OK', `${srv.transport} (${srv.tools.length} tool schema(s))`);
        }

        // Database safety check (READONLY=true is OK, false/missing is WARN)
        const dbCheck = checkDatabaseSafety(srv);
        if (dbCheck) add('mcp-db', srv.id, dbCheck.level, dbCheck.detail);

        // Plaintext secret scan (prefix-free redaction)
        const secrets = scanServerSecrets(srv.id, srv.def);
        for (const sec of secrets) {
            add('mcp-secret', srv.id, 'FAIL', `Plaintext ${sec.redacted} in ${sec.location}.${sec.key}`, {
                location: sec.location,
                key: sec.key,
                secretType: sec.secretType,
            });
            suggestions.push({
                serverId: srv.id,
                location: sec.location,
                envVar: sec.suggestion.envVar,
                snippet: sec.suggestion.snippet,
            });
        }
    }

    // 3. Rules & Hygiene
    let alwaysOnBytes = 0;
    let largestRule = { name: null, bytes: 0 };
    for (const r of rules.items) {
        if (r.bytes > largestRule.bytes) largestRule = { name: r.name, bytes: r.bytes };
        if (r.bytes > RULE_MAX_BYTES) {
            add('rules', r.name, 'FAIL', `Exceeds ${RULE_MAX_BYTES} byte limit (${r.bytes} bytes; will be truncated)`);
        }
        if (r.trigger === 'always_on') alwaysOnBytes += r.bytes;
    }

    if (rules.items.length > 0 && !findings.some(f => f.category === 'rules' && f.level === 'FAIL')) {
        add('rules', '.agents/rules/', 'OK', `${rules.items.length} file(s) | largest: ${(largestRule.bytes / 1024).toFixed(1)} KB / ${(RULE_MAX_BYTES / 1000).toFixed(1)} KB limit`);
    }

    const estRuleTokens = Math.round(alwaysOnBytes / 4);
    if (estRuleTokens > RULES_AGGREGATE_TOKEN_BUDGET) {
        add('rules-budget', 'always_on', 'WARN', `Always-on rules ~${estRuleTokens.toLocaleString()} tok exceed ${RULES_AGGREGATE_TOKEN_BUDGET.toLocaleString()} defaultRulesBudget`);
    }

    // Stale 00-active-mcps.md check
    const activeRule = rules.items.find(r => r.name === '00-active-mcps.md' && r.text);
    if (activeRule) {
        const knownIds = new Set(mcp.servers.map(s => s.id));
        const referenced = [...activeRule.text.matchAll(/^- \*\*([a-z0-9_-]+)\*\*/gim)].map(m => m[1]);
        const stale = referenced.filter(id => !knownIds.has(id));
        if (stale.length > 0) {
            add('rules', '00-active-mcps.md', 'WARN', `References unknown server(s): ${stale.join(', ')}`);
        }
    }

    // 4. Hooks JSON check
    const hooksPath = path.join(paths.workspaceDir, '.agents', 'hooks.json');
    const hooksParsed = tryParseJson(hooksPath);
    if (hooksParsed.exists) {
        if (hooksParsed.error) {
            add('hooks', '.agents/hooks.json', 'FAIL', `Malformed JSON: ${hooksParsed.error}`);
        } else {
            const count = Object.keys(hooksParsed.data || {}).length;
            add('hooks', '.agents/hooks.json', 'OK', `Valid JSON (${count} hook group(s))`);
        }
    }

    // 5. Antigravity Overview Hub patch resilience check
    if (!opts.skipPatchCheck && (opts.resources || !opts.homeDir)) {
        try {
            const ps = patchStatus({ resources: opts.resources });
            if (ps.found) {
                if (ps.patched && ps.upToDate) {
                    add('patch', 'Antigravity app.asar', 'OK', `Overview Hub patched (v${ps.version}, build ${ps.sourceBuild})`);
                } else if (ps.patched && !ps.upToDate) {
                    add('patch', 'Antigravity app.asar', 'WARN', `Overview Hub build outdated (${ps.installedBuild || 'legacy'} -> ${ps.sourceBuild}); run "ctx patch ensure"`);
                } else if (!ps.patched && ps.hasBackup) {
                    add('patch', 'Antigravity app.asar', 'WARN', `Antigravity update wiped Overview Hub patch (v${ps.version}); run "ctx patch ensure"`);
                }
            }
        } catch { }
    }

    const summary = {
        ok: findings.filter(f => f.level === 'OK').length,
        warn: findings.filter(f => f.level === 'WARN').length,
        fail: findings.filter(f => f.level === 'FAIL').length,
    };
    const exitCode = summary.fail > 0 || (opts.strict && summary.warn > 0) ? 1 : 0;

    return {
        workspace: paths.workspaceDir,
        findings,
        suggestions,
        summary,
        exitCode,
    };
}

function shortTarget(target, homeDir) {
    if (!path.isAbsolute(target)) return target;
    if (homeDir && target.startsWith(homeDir)) return '~' + target.slice(homeDir.length).replace(/\\/g, '/');
    return path.basename(target);
}

function formatDoctor(report, opts = {}) {
    const out = [];
    const os = require('os');
    const homeDir = opts.homeDir || os.homedir();
    out.push('ctxpilot doctor (read-only)');
    out.push(`Workspace: ${report.workspace}`);
    out.push('─'.repeat(68));

    for (const f of report.findings) {
        const tag = f.level === 'OK' ? '[OK]  ' : f.level === 'WARN' ? '[WARN]' : '[FAIL]';
        const target = shortTarget(f.target, homeDir);
        out.push(`  ${tag} ${target.padEnd(42)} ${f.message}`);
    }

    if (opts.fixSuggest && report.suggestions.length > 0) {
        out.push('');
        out.push('Suggested ${ENV_VAR} replacements (no files were modified):');
        for (const s of report.suggestions) {
            out.push(`  - ${s.serverId}.${s.location}: ${s.snippet}`);
        }
    }

    out.push('─'.repeat(62));
    out.push(`Summary: ${report.summary.ok} ok, ${report.summary.warn} warning(s), ${report.summary.fail} failure(s).`);
    return out.join('\n');
}

module.exports = { runDoctor, formatDoctor, resolveCommandOnPath };
