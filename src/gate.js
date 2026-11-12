'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getPaths } = require('./discovery');
const { buildTurnTimeline } = require('./handoff');
const { scanTextSecrets } = require('./redact');
const { runDoctor } = require('./doctor');
const { runVerify } = require('./verify');

function gitOut(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function getWorkingTreeFiles(root) {
    const raw = execFileSync('git', ['status', '--porcelain', '-uall'], {
        cwd: root, encoding: 'utf8', windowsHide: true, timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\r?\n$/, '');
    if (!raw) return [];
    return raw.split(/\r?\n/).filter(Boolean).map(line => {
        const status = line.slice(0, 2);
        let file = line.slice(3).trim();
        if (file.includes(' -> ')) file = file.split(' -> ').pop().trim();
        return { status, file: file.replace(/^"|"$/g, '').replace(/\\/g, '/') };
    });
}

function scanDiffAndFiles(root, dirtyFiles) {
    const blockers = [];
    const warnings = [];

    for (const item of dirtyFiles) {
        if (/(^|\/)\.env(\.|$)/i.test(item.file) && !/\.env\.(example|template|sample)$/i.test(item.file)) {
            blockers.push({ type: 'env-file', file: item.file, message: `Sensitive env file in working tree: ${item.file}` });
        }
    }

    try {
        const diff = gitOut(['diff', 'HEAD'], root);
        const addedLines = diff.split(/\r?\n/).filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1)).join('\n');
        for (const hit of scanTextSecrets(addedLines)) {
            blockers.push({ type: 'diff-secret', file: 'git diff', message: `Added ${hit.redacted} detected in diff` });
        }
        if (/\bdebugger\b/.test(addedLines)) {
            warnings.push({ type: 'debugger', file: 'git diff', message: 'debugger statement found in added diff lines' });
        }
    } catch {}

    for (const item of dirtyFiles) {
        if (!item.status.includes('?')) continue;
        const full = path.join(root, item.file);
        try {
            const st = fs.statSync(full);
            if (!st.isFile() || st.size > 256 * 1024) continue;
            const txt = fs.readFileSync(full, 'utf8');
            for (const hit of scanTextSecrets(txt)) {
                blockers.push({ type: 'untracked-secret', file: item.file, message: `Plaintext ${hit.redacted} in untracked ${item.file}` });
            }
        } catch {}
    }

    return { blockers, warnings };
}

/**
 * Runs the Pre-Push Attribution Gate: separates chat-touched files from local files,
 * scans diffs/.env for secrets, runs doctor (strict on failures), and runs silent verify.
 */
async function runPrePushGate(opts = {}) {
    const paths = getPaths(opts);
    const root = gitOut(['rev-parse', '--show-toplevel'], paths.workspaceDir);
    const dirty = getWorkingTreeFiles(root);

    const tl = buildTurnTimeline(opts);
    const chatEditedSet = new Set();
    for (const t of tl.turns) {
        for (const f of t.filesEdited) chatEditedSet.add(f);
    }

    const chatFiles = dirty.filter(d => chatEditedSet.has(d.file)).map(d => d.file);
    const otherFiles = dirty.filter(d => !chatEditedSet.has(d.file)).map(d => d.file);

    const scan = scanDiffAndFiles(root, dirty);
    const blockers = [...scan.blockers];
    const warnings = [...scan.warnings];

    const doc = await runDoctor({ ...opts, skipPatchCheck: true });
    for (const f of doc.findings.filter(x => x.level === 'FAIL')) {
        if (f.category === 'mcp-secret' && !opts.strict) {
            warnings.push({ type: 'doctor-global', file: f.target, message: f.message });
        } else {
            blockers.push({ type: 'doctor', file: f.target, message: f.message });
        }
    }
    if (opts.strict && doc.summary.warn > 0) {
        for (const f of doc.findings.filter(x => x.level === 'WARN')) {
            blockers.push({ type: 'doctor-strict', file: f.target, message: f.message });
        }
    }

    let verify = { ok: true, skipped: true };
    if (!opts.skipVerify) {
        verify = await runVerify({ ...opts, workspaceDir: root });
        if (!verify.skipped && !verify.ok) {
            blockers.push({ type: 'verify', file: verify.command, message: `${verify.command} failed: ${verify.summaryLine}` });
        }
    }

    return {
        ok: blockers.length === 0,
        workspace: root,
        dirtyCount: dirty.length,
        chatFiles,
        otherFiles,
        blockers,
        warnings,
        verify,
        doctorSummary: doc.summary,
    };
}

module.exports = { runPrePushGate, getWorkingTreeFiles };
