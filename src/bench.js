'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const { performance } = require('perf_hooks');
const { getPaths, discoverRules, tryParseJson, RULE_MAX_BYTES, RULES_AGGREGATE_TOKEN_BUDGET } = require('./discovery');

const HOOK_BUDGET_MS = 150;
const HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop'];

function extractHookCommands(hooksData) {
    const list = [];
    if (!hooksData || typeof hooksData !== 'object') return list;
    for (const [name, cfg] of Object.entries(hooksData)) {
        if (!cfg || typeof cfg !== 'object') continue;
        const enabled = cfg.enabled !== false;
        for (const ev of HOOK_EVENTS) {
            const entries = Array.isArray(cfg[ev]) ? cfg[ev] : (cfg[ev] ? [cfg[ev]] : []);
            for (const entry of entries) {
                const hooksArr = Array.isArray(entry.hooks) ? entry.hooks : [entry];
                for (const h of hooksArr) {
                    const cmd = typeof h === 'string' ? h : h && h.command;
                    if (cmd) list.push({ name, event: ev, enabled, command: String(cmd) });
                }
            }
        }
    }
    return list;
}

function analyzeRuleBloat(rules) {
    const lineOwners = new Map();
    const duplicates = [];
    const heavyAlwaysOn = [];
    let alwaysOnBytes = 0;

    for (const r of rules.items) {
        if (r.trigger === 'always_on') alwaysOnBytes += r.bytes;
        if (r.source === '.agents/rules' && r.trigger === 'always_on' && r.name !== '00-active-mcps.md' && r.bytes > 4096) {
            heavyAlwaysOn.push({ name: r.name, bytes: r.bytes, tokensEst: Math.round(r.bytes / 4) });
        }
        if (!r.text) continue;
        const body = r.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
        const seenInFile = new Set();
        for (const rawLine of body.split(/\r?\n/)) {
            const norm = rawLine.trim().replace(/\s+/g, ' ').toLowerCase();
            if (norm.length < 28 || seenInFile.has(norm)) continue;
            seenInFile.add(norm);
            const owners = lineOwners.get(norm) || [];
            owners.push(r.name);
            lineOwners.set(norm, owners);
        }
    }

    for (const [line, owners] of lineOwners.entries()) {
        if (owners.length > 1) {
            duplicates.push({ files: owners, snippet: line.slice(0, 72) });
        }
    }

    const alwaysOnTokensEst = Math.round(alwaysOnBytes / 4);
    return {
        totalFiles: rules.items.length,
        alwaysOnTokensEst,
        budgetTokens: RULES_AGGREGATE_TOKEN_BUDGET,
        budgetPct: Math.round((alwaysOnTokensEst / RULES_AGGREGATE_TOKEN_BUDGET) * 100),
        oversized: rules.items.filter(r => r.bytes > RULE_MAX_BYTES).map(r => ({ name: r.name, bytes: r.bytes })),
        heavyAlwaysOn,
        duplicates: duplicates.slice(0, 10),
    };
}

function benchmarkHook(hook, workspaceDir) {
    const t0 = performance.now();
    const res = spawnSync(hook.command, {
        cwd: workspaceDir,
        input: '{}\n',
        encoding: 'utf8',
        shell: true,
        timeout: 2000,
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore'],
    });
    const durationMs = Math.round((performance.now() - t0) * 10) / 10;
    const failed = Boolean(res.error) || res.status !== 0;
    const status = failed ? 'FAIL' : durationMs > HOOK_BUDGET_MS ? 'WARN' : 'OK';
    return {
        ...hook,
        executed: true,
        durationMs,
        exitStatus: res.status,
        error: res.error ? res.error.message : null,
        status,
    };
}

function runBench(opts = {}) {
    const paths = getPaths(opts);
    const rules = discoverRules(paths.workspaceDir);
    const ruleAnalysis = analyzeRuleBloat(rules);

    const hooksPath = path.join(paths.workspaceDir, '.agents', 'hooks.json');
    const parsedHooks = tryParseJson(hooksPath);
    const hookDefs = parsedHooks.data ? extractHookCommands(parsedHooks.data) : [];
    const hooks = hookDefs.map(h => {
        if (!opts.runHooks || !h.enabled) {
            return { ...h, executed: false, durationMs: null, status: h.enabled ? 'STATIC' : 'DISABLED' };
        }
        return benchmarkHook(h, paths.workspaceDir);
    });

    return {
        workspace: paths.workspaceDir,
        hookBudgetMs: HOOK_BUDGET_MS,
        runHooks: Boolean(opts.runHooks),
        rules: ruleAnalysis,
        hooks,
    };
}

function formatBench(report) {
    const out = [];
    out.push(`ctxpilot bench (workspace: ${report.workspace})`);
    out.push('─'.repeat(66));
    out.push(`1. Rules Bloat & Overlap`);
    out.push(`   Always-on: ~${report.rules.alwaysOnTokensEst.toLocaleString()} / ${report.rules.budgetTokens.toLocaleString()} tok (${report.rules.budgetPct}%) across ${report.rules.totalFiles} file(s)`);
    for (const r of report.rules.oversized) out.push(`   [FAIL] ${r.name}: ${r.bytes} bytes exceeds 24,000 limit`);
    for (const r of report.rules.heavyAlwaysOn) out.push(`   [TIP]  ${r.name}: ~${r.tokensEst} tok always_on — consider trigger: model_decision`);
    for (const d of report.rules.duplicates) out.push(`   [DUP]  ${d.files.join(' <-> ')}: "${d.snippet}"`);
    if (!report.rules.oversized.length && !report.rules.heavyAlwaysOn.length && !report.rules.duplicates.length) {
        out.push('   [OK]   No oversized rules, heavy always_on bloat, or duplicate lines detected.');
    }

    out.push('');
    out.push(`2. Hooks Profiler (budget: <${report.hookBudgetMs} ms)`);
    if (report.hooks.length === 0) {
        out.push('   No hooks configured in .agents/hooks.json.');
    } else {
        for (const h of report.hooks) {
            const timing = h.executed ? `${h.durationMs} ms` : h.status.toLowerCase();
            out.push(`   [${h.status.padEnd(6)}] ${h.name} (${h.event}): ${timing} — ${h.command}`);
        }
        if (!report.runHooks) {
            out.push('   Tip: pass --run-hooks to spawn enabled hooks with empty "{}" stdin (2s timeout).');
        }
    }
    return out.join('\n');
}

module.exports = { runBench, formatBench, HOOK_BUDGET_MS };
