'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getPaths, tryParseJson } = require('./discovery');
const { scanServerSecrets } = require('./redact');

function writeJsonAtomic(p, obj) {
    const tmp = `${p}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, p);
}

function upsertDotEnv(envPath, entries) {
    let existing = '';
    try { existing = fs.readFileSync(envPath, 'utf8'); } catch {}
    const lines = existing ? existing.split(/\r?\n/) : [];
    const map = new Map();
    const order = [];
    for (const line of lines) {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (m) {
            if (!map.has(m[1])) order.push(m[1]);
            map.set(m[1], m[2]);
        } else if (line.trim()) {
            order.push(line);
        }
    }
    for (const [k, v] of entries) {
        if (!map.has(k)) order.push(k);
        const safe = /[\s"'\\$`]/.test(v) ? `'${v.replace(/'/g, "'\\''")}'` : v;
        map.set(k, safe);
    }
    const out = order.map(item => (map.has(item) ? `${item}=${map.get(item)}` : item)).join('\n') + '\n';
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, out, { encoding: 'utf8', mode: 0o600 });
}

function writeOsUserEnv(entries, opts = {}) {
    if (typeof opts.envWriter === 'function') {
        for (const [k, v] of entries) opts.envWriter(k, v);
        return { method: 'custom', count: entries.length };
    }
    if (opts.skipOsEnv) return { method: 'skipped', count: 0 };

    if (process.platform === 'win32') {
        for (const [k, v] of entries) {
            execFileSync('setx', [k, v], { windowsHide: true, stdio: 'ignore' });
        }
        return { method: 'setx', count: entries.length };
    }

    const homeDir = opts.homeDir || require('os').homedir();
    const profilePath = ['.zshrc', '.bashrc', '.profile'].map(f => path.join(homeDir, f)).find(p => fs.existsSync(p))
        || path.join(homeDir, '.profile');
    let content = '';
    try { content = fs.readFileSync(profilePath, 'utf8'); } catch {}
    const startTag = '# >>> ctxpilot-secrets >>>';
    const endTag = '# <<< ctxpilot-secrets <<<';
    const existingVars = new Map();
    const blockRe = new RegExp(`${startTag}[\\s\\S]*?${endTag}\\r?\\n?`);
    const prevBlock = content.match(blockRe);
    if (prevBlock) {
        for (const line of prevBlock[0].split(/\r?\n/)) {
            const m = line.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
            if (m) existingVars.set(m[1], m[2]);
        }
        content = content.replace(blockRe, '');
    }
    for (const [k, v] of entries) {
        existingVars.set(k, `'${v.replace(/'/g, "'\\''")}'`);
    }
    const block = [startTag, ...[...existingVars.entries()].map(([k, v]) => `export ${k}=${v}`), endTag].join('\n') + '\n';
    const next = (content ? content.replace(/\s*$/, '\n\n') : '') + block;
    fs.writeFileSync(profilePath, next, { encoding: 'utf8', mode: 0o600 });
    return { method: path.basename(profilePath), count: entries.length };
}

function extractReplacement(sec, rawValue) {
    const envVar = sec.suggestion.envVar;
    const isBearer = sec.secretType === 'bearer-token' || (/^authorization$/i.test(sec.key) && /^Bearer\s+/i.test(rawValue));
    if (isBearer) {
        const token = rawValue.replace(/^Bearer\s+/i, '').trim();
        return { envVar, rawSecret: token, placeholder: `Bearer \${${envVar}}` };
    }
    return { envVar, rawSecret: rawValue, placeholder: `\${${envVar}}` };
}

function applySecretFixesToDef(serverId, def, envEntries, changes, filePath) {
    const secrets = scanServerSecrets(serverId, def);
    let modified = false;
    for (const sec of secrets) {
        let rawValue = null;
        if (sec.location === 'headers' && def.headers) rawValue = def.headers[sec.key];
        else if (sec.location === 'env' && def.env) rawValue = def.env[sec.key];
        else if (sec.location.startsWith('args[') && Array.isArray(def.args)) {
            const idx = Number(sec.location.slice(5, -1));
            rawValue = def.args[idx];
        }
        if (typeof rawValue !== 'string') continue;

        const { envVar, rawSecret, placeholder } = extractReplacement(sec, rawValue);
        envEntries.set(envVar, rawSecret);
        changes.push({ file: filePath, serverId, location: sec.location, key: sec.key, envVar, redacted: sec.redacted });

        if (sec.location === 'headers') def.headers[sec.key] = placeholder;
        else if (sec.location === 'env') def.env[sec.key] = placeholder;
        else if (sec.location.startsWith('args[')) {
            const idx = Number(sec.location.slice(5, -1));
            def.args[idx] = placeholder;
        }
        modified = true;
    }
    return modified;
}

function fixSecrets(opts = {}) {
    const paths = getPaths(opts);
    const envEntries = new Map();
    const changes = [];
    const backups = [];

    for (const cfgPath of paths.mcpConfigs) {
        const parsed = tryParseJson(cfgPath);
        if (!parsed.exists || !parsed.data || !parsed.data.mcpServers) continue;
        let dirty = false;
        for (const [id, def] of Object.entries(parsed.data.mcpServers)) {
            if (applySecretFixesToDef(id, def, envEntries, changes, cfgPath)) dirty = true;
        }
        if (dirty && !opts.dryRun) {
            const bak = `${cfgPath}.bak`;
            fs.copyFileSync(cfgPath, bak);
            backups.push(bak);
            writeJsonAtomic(cfgPath, parsed.data);
        }
    }

    const disabledParsed = tryParseJson(paths.disabledPath);
    if (disabledParsed.exists && disabledParsed.data && typeof disabledParsed.data === 'object') {
        let dirty = false;
        for (const [id, entry] of Object.entries(disabledParsed.data)) {
            if (entry && entry.def && applySecretFixesToDef(id, entry.def, envEntries, changes, paths.disabledPath)) dirty = true;
        }
        if (dirty && !opts.dryRun) {
            const bak = `${paths.disabledPath}.bak`;
            fs.copyFileSync(paths.disabledPath, bak);
            backups.push(bak);
            writeJsonAtomic(paths.disabledPath, disabledParsed.data);
        }
    }

    const dotEnvPath = path.join(paths.geminiDir, '.env');
    let osEnv = { method: 'none', count: 0 };
    if (changes.length > 0 && !opts.dryRun) {
        upsertDotEnv(dotEnvPath, envEntries);
        osEnv = writeOsUserEnv(envEntries, opts);
    }

    return {
        action: 'doctor-fix',
        dryRun: Boolean(opts.dryRun),
        fixedCount: changes.length,
        changes,
        backups,
        dotEnvPath: changes.length > 0 ? dotEnvPath : null,
        osEnv,
    };
}

module.exports = { fixSecrets };
