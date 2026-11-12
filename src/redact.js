'use strict';

const ENV_REF_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const BEARER_ENV_RE = /^Bearer\s+\$\{[A-Za-z_][A-Za-z0-9_]*\}$/i;

const TOKEN_PATTERNS = [
    { type: 'bearer-token', re: /^Bearer\s+(?!\$\{[A-Za-z_][A-Za-z0-9_]*\}$).+/i },
    { type: 'api-key', re: /\b(ctx7sk-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{16,})\b/ },
    { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

const SENSITIVE_KEY_RE = /(authorization|api[_-]?key|token|secret|password|passwd|pwd|private[_-]?key|connection[_-]?string|dsn|pat)/i;

function isEnvReference(val) {
    if (typeof val !== 'string') return false;
    const trimmed = val.trim();
    return ENV_REF_RE.test(trimmed) || BEARER_ENV_RE.test(trimmed);
}

function classifySecret(key, value) {
    if (typeof value !== 'string' || !value.trim() || isEnvReference(value)) return null;
    const trimmed = value.trim();
    for (const p of TOKEN_PATTERNS) {
        if (p.re.test(trimmed)) return p.type;
    }
    if (key && SENSITIVE_KEY_RE.test(key)) {
        // Ignore harmless boolean/mode flags or placeholder words
        if (/^(true|false|none|null|windows|integrated|env)$/i.test(trimmed)) return null;
        return /pass|pwd/i.test(key) ? 'password' : 'credential';
    }
    return null;
}

function redactLabel(secretType) {
    return `[REDACTED: ${secretType || 'secret'}]`;
}

function toEnvVarName(serverId, key) {
    const clean = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const sPart = clean(serverId || 'MCP');
    const kPart = clean(key || 'TOKEN');
    if (kPart === 'AUTHORIZATION') return `${sPart}_API_KEY`;
    return `${sPart}_${kPart}`;
}

function suggestReplacement(serverId, location, key, value, secretType) {
    const envVar = toEnvVarName(serverId, key);
    if (secretType === 'bearer-token' || (/^authorization$/i.test(key) && /^Bearer\s+/i.test(String(value)))) {
        return { envVar, snippet: `"${key}": "Bearer \${${envVar}}"` };
    }
    return { envVar, snippet: `"${key}": "\${${envVar}}"` };
}

function scanServerSecrets(serverId, def) {
    const findings = [];
    if (!def || typeof def !== 'object') return findings;

    const inspectMap = (obj, location) => {
        if (!obj || typeof obj !== 'object') return;
        for (const [k, v] of Object.entries(obj)) {
            if (typeof v !== 'string') continue;
            const kind = classifySecret(k, v);
            if (kind) {
                findings.push({
                    serverId,
                    location,
                    key: k,
                    secretType: kind,
                    redacted: redactLabel(kind),
                    suggestion: suggestReplacement(serverId, location, k, v, kind),
                });
            }
        }
    };

    inspectMap(def.headers, 'headers');
    inspectMap(def.env, 'env');

    if (Array.isArray(def.args)) {
        for (let i = 0; i < def.args.length; i++) {
            const arg = String(def.args[i]);
            const kind = classifySecret('', arg);
            if (kind) {
                findings.push({
                    serverId,
                    location: `args[${i}]`,
                    key: `arg_${i}`,
                    secretType: kind,
                    redacted: redactLabel(kind),
                    suggestion: { envVar: toEnvVarName(serverId, `ARG_${i}`), snippet: `"\${${toEnvVarName(serverId, `ARG_${i}`)}}"` },
                });
            }
        }
    }
    return findings;
}

module.exports = {
    isEnvReference,
    classifySecret,
    redactLabel,
    scanServerSecrets,
};
