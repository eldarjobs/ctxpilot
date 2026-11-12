'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getPaths, tryParseJson } = require('./discovery');
const { estTokensFromBytes } = require('./context');

const TAIL_BYTES = 2 * 1024 * 1024;
const MAX_FIXES = 50;

/**
 * Finds the target (or most recently updated non-empty) transcript.jsonl in brainDir.
 */
function findTranscriptFile(brainDir, requestedConvId) {
    if (!brainDir || !fs.existsSync(brainDir)) return null;
    if (requestedConvId) {
        const safeId = path.basename(String(requestedConvId));
        const p = path.join(brainDir, safeId, '.system_generated', 'logs', 'transcript.jsonl');
        return fs.existsSync(p) ? { convId: safeId, file: p } : null;
    }
    let best = null;
    for (const ent of fs.readdirSync(brainDir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const p = path.join(brainDir, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
        try {
            const st = fs.statSync(p);
            if (st.size > 0 && (!best || st.mtimeMs > best.mtimeMs)) {
                best = { convId: ent.name, file: p, mtimeMs: st.mtimeMs };
            }
        } catch {}
    }
    return best;
}

function cleanPromptText(raw) {
    if (typeof raw !== 'string') return '';
    return raw
        .replace(/<USER_REQUEST>|<\/USER_REQUEST>/g, '')
        .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
        .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function unquoteArg(val) {
    if (typeof val !== 'string') return '';
    let s = val.trim();
    if (s.startsWith('"') && s.endsWith('"')) {
        try { s = String(JSON.parse(s)); } catch { s = s.slice(1, -1); }
    }
    return s.trim();
}

function extractFileArg(args) {
    if (!args || typeof args !== 'object') return null;
    for (const k of ['Path', 'path', 'TargetFile', 'file']) {
        const clean = unquoteArg(args[k]);
        if (clean) return clean;
    }
    return null;
}

function shortPath(p, workspaceDir) {
    if (!p) return '';
    const normWs = workspaceDir ? path.resolve(workspaceDir) : '';
    const normP = path.resolve(p);
    if (normWs && normP.toLowerCase().startsWith(normWs.toLowerCase() + path.sep)) {
        return normP.slice(normWs.length + 1).replace(/\\/g, '/');
    }
    return normP.replace(/\\/g, '/');
}

/**
 * Extracts structured signals from a transcript.jsonl tail for compaction/handoff.
 */
function extractTranscriptSignals(rawText, workspaceDir) {
    const userPrompts = [];
    const filesEdited = new Set();
    const filesRead = new Set();
    const commands = [];
    const seenCmds = new Set();
    let lastPlannerText = '';
    let sourceTokens = 0;

    for (const line of String(rawText || '').split(/\r?\n/)) {
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (!obj || typeof obj !== 'object') continue;

        if (obj.type === 'USER_INPUT') {
            const txt = cleanPromptText(obj.content);
            if (txt && txt !== '/compact') userPrompts.push(txt);
        } else if (obj.type === 'PLANNER_RESPONSE') {
            if (typeof obj.input_tokens === 'number' || typeof obj.cache_read_tokens === 'number') {
                sourceTokens = (Number(obj.input_tokens) || 0) + (Number(obj.cache_read_tokens) || 0);
            }
            if (typeof obj.content === 'string' && obj.content.trim()) {
                lastPlannerText = cleanPromptText(obj.content);
            }
            if (Array.isArray(obj.tool_calls)) {
                for (const tc of obj.tool_calls) {
                    const name = String(tc && tc.name || '');
                    const args = (tc && tc.args) || {};
                    const fp = extractFileArg(args);
                    if (fp) {
                        const rel = shortPath(fp, workspaceDir);
                        if (/edit|write|replace/i.test(name)) filesEdited.add(rel);
                        else if (/read|view/i.test(name)) filesRead.add(rel);
                    }
                    if (/command|run/i.test(name)) {
                        const label = unquoteArg(args.toolSummary || args.CommandLine || '');
                        if (label && !seenCmds.has(label)) {
                            seenCmds.add(label);
                            commands.push(label.slice(0, 120));
                        }
                    }
                }
            }
        }
    }

    return {
        userPrompts,
        filesEdited: [...filesEdited],
        filesRead: [...filesRead].filter(f => !filesEdited.has(f)),
        commands: commands.slice(-8),
        lastPlannerText,
        sourceTokens,
    };
}

function getGitSnapshot(workspaceDir) {
    if (!workspaceDir || !fs.existsSync(workspaceDir)) return { branch: '', dirtyFiles: [] };
    try {
        const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd: workspaceDir, encoding: 'utf8', windowsHide: true, timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const status = execFileSync('git', ['status', '--porcelain'], {
            cwd: workspaceDir, encoding: 'utf8', windowsHide: true, timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const dirtyFiles = status ? status.split(/\r?\n/).map(l => l.trim()).slice(0, 15) : [];
        return { branch, dirtyFiles };
    } catch {
        return { branch: '', dirtyFiles: [] };
    }
}

function fixesFilePath(opts = {}) {
    return path.join(getPaths(opts).cfgDir, 'ctxpilot_fixes.json');
}

function readFixesStore(file) {
    const parsed = tryParseJson(file);
    return Array.isArray(parsed.data) ? parsed.data : [];
}

/**
 * Lists saved fix notes, prioritizing the current workspace unless opts.all is set.
 */
function listFixes(opts = {}) {
    const paths = getPaths(opts);
    const all = readFixesStore(fixesFilePath(opts));
    if (opts.all) return all;
    const normWs = path.normalize(paths.workspaceDir).toLowerCase();
    return all.filter(f => !f.workspace || path.normalize(f.workspace).toLowerCase() === normWs);
}

/**
 * Saves a fix / root-cause note into ctxpilot_fixes.json.
 */
function addFix(title, detail, opts = {}) {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) throw new Error('Fix note cannot be empty.');
    const paths = getPaths(opts);
    const file = fixesFilePath(opts);
    const items = readFixesStore(file);
    const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        workspace: paths.workspaceDir,
        title: cleanTitle.slice(0, 160),
        detail: String(detail || '').trim().slice(0, 500),
        convId: opts.convId ? String(opts.convId).slice(0, 8) : null,
        createdAt: new Date().toISOString(),
    };
    const next = [entry, ...items].slice(0, MAX_FIXES);
    if (!opts.dryRun) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
    }
    return { action: 'fix-add', dryRun: Boolean(opts.dryRun), entry, total: next.length };
}

function removeFix(id, opts = {}) {
    const file = fixesFilePath(opts);
    const items = readFixesStore(file);
    const next = items.filter(f => f.id !== id);
    if (!opts.dryRun && next.length !== items.length) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
    }
    return { action: 'fix-rm', removed: items.length - next.length, remaining: next.length };
}

function readTranscriptTail(file) {
    const st = fs.statSync(file);
    const size = Math.min(st.size, TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    return buf.toString('utf8');
}

/**
 * Builds a lean, structured New-Chat handoff prompt from the active transcript and git state.
 */
function buildHandoff(opts = {}) {
    const paths = getPaths(opts);
    const found = findTranscriptFile(paths.brainDir, opts.conv);
    let signals = { userPrompts: [], filesEdited: [], filesRead: [], commands: [], lastPlannerText: '', sourceTokens: 0 };
    let convId = null;

    if (found) {
        convId = found.convId;
        signals = extractTranscriptSignals(readTranscriptTail(found.file), paths.workspaceDir);
    }

    const git = getGitSnapshot(paths.workspaceDir);
    const fixes = listFixes(opts).slice(0, 3);
    const prompts = signals.userPrompts;
    const goalPrompts = prompts.length <= 3 ? prompts : [prompts[0], ...prompts.slice(-2)];

    const lines = [
        `# Session Handoff${convId ? ` (from chat ${convId.slice(0, 8)}` : ''}${signals.sourceTokens ? `, ~${Math.round(signals.sourceTokens / 1000)}k tok` : ''}${convId ? ')' : ''}`,
        `- Workspace: \`${paths.workspaceDir}\`${git.branch ? ` (branch \`${git.branch}\`)` : ''}`,
    ];

    if (goalPrompts.length) {
        lines.push('', '## Goal & Recent Requests');
        for (const p of goalPrompts) lines.push(`- ${p.slice(0, 220)}`);
    }
    if (signals.filesEdited.length || git.dirtyFiles.length) {
        lines.push('', '## Modified & Working Tree Files');
        for (const f of signals.filesEdited.slice(0, 12)) lines.push(`- edited: \`${f}\``);
        for (const d of git.dirtyFiles.slice(0, 10)) lines.push(`- git: \`${d}\``);
    }
    if (signals.commands.length) {
        lines.push('', '## Recent Commands & Checks');
        for (const c of signals.commands) lines.push(`- ${c}`);
    }
    if (signals.lastPlannerText) {
        lines.push('', '## Latest Status', signals.lastPlannerText.slice(0, 600));
    }
    if (fixes.length) {
        lines.push('', '## Saved Workspace Fixes');
        for (const fx of fixes) lines.push(`- ${fx.title}${fx.detail ? `: ${fx.detail}` : ''}`);
    }
    lines.push('', 'Continue from this compacted handoff without re-reading unchanged files.');

    const markdown = lines.join('\n');
    return {
        convId,
        workspace: paths.workspaceDir,
        branch: git.branch,
        sourceTokens: signals.sourceTokens,
        handoffTokensEst: estTokensFromBytes(Buffer.byteLength(markdown, 'utf8'), 4.0),
        filesEdited: signals.filesEdited,
        dirtyFiles: git.dirtyFiles,
        markdown,
    };
}

/**
 * Builds a minimal isolated Sub-Chat prompt for side-tasks or bugfix isolation.
 */
function buildSubChat(opts = {}) {
    const paths = getPaths(opts);
    const found = findTranscriptFile(paths.brainDir, opts.conv);
    const git = getGitSnapshot(paths.workspaceDir);
    const topic = String(opts.topic || '').trim();
    const convTag = found ? found.convId.slice(0, 8) : null;

    let touched = [];
    if (found) {
        const sig = extractTranscriptSignals(readTranscriptTail(found.file), paths.workspaceDir);
        touched = sig.filesEdited.slice(0, 8);
    }

    const header = topic
        ? [`# Sub-Chat: ${topic}`, `> Isolated Sub-Chat${convTag ? ` (branched from ${convTag})` : ''}`]
        : [`# Isolated Sub-Chat${convTag ? ` (branched from ${convTag})` : ''}`];
    const lines = [
        ...header,
        `- Workspace: \`${paths.workspaceDir}\`${git.branch ? ` (branch \`${git.branch}\`)` : ''}`,
        `- Task / Fix: ${topic || 'Investigate and fix the side issue cleanly without main-chat context bloat.'}`,
    ];
    if (touched.length || git.dirtyFiles.length) {
        lines.push('', '## Relevant Files');
        for (const f of touched) lines.push(`- \`${f}\``);
        if (!touched.length) {
            for (const d of git.dirtyFiles.slice(0, 8)) lines.push(`- \`${d}\``);
        }
    }
    lines.push(
        '',
        'Work ONLY on this isolated task/fix. When resolved, end with a 3-bullet summary (Root Cause, Fix, Verification) so it can be logged or carried back cleanly.',
    );

    const markdown = lines.join('\n');
    return {
        convId: found ? found.convId : null,
        topic: topic || null,
        workspace: paths.workspaceDir,
        branch: git.branch,
        promptTokensEst: estTokensFromBytes(Buffer.byteLength(markdown, 'utf8'), 4.0),
        markdown,
    };
}

/**
 * Extracts lightweight contextual hints from the tail of the latest transcript for UI action buttons.
 */
function getChatSignals(opts = {}) {
    const empty = { fixHint: '', asksProceed: false, issueTopic: '', subChatOffer: '', isSubChat: false, parentConvId: '', lastSummary: '' };
    try {
        const paths = getPaths(opts);
        const found = findTranscriptFile(paths.brainDir, opts.conv);
        if (!found) return empty;
        const st = fs.statSync(found.file);
        const size = Math.min(st.size, 64 * 1024);
        const fd = fs.openSync(found.file, 'r');
        const buf = Buffer.alloc(size);
        fs.readSync(fd, buf, 0, size, st.size - size);
        fs.closeSync(fd);
        let lastText = '';
        let firstUser = '';
        for (const line of buf.toString('utf8').split(/\r?\n/)) {
            if (!line.includes('PLANNER_RESPONSE') && !line.includes('USER_INPUT')) continue;
            try {
                const o = JSON.parse(line);
                if (!firstUser && o.type === 'USER_INPUT' && typeof o.content === 'string') {
                    firstUser = cleanPromptText(o.content);
                } else if (o.type === 'PLANNER_RESPONSE' && typeof o.content === 'string' && o.content.trim()) {
                    lastText = cleanPromptText(o.content);
                }
            } catch {}
        }
        const parentMatch = firstUser.match(/(?:[#>]+\s*)?(?:Isolated|Forked) Sub-Chat \((?:branched )?from ([a-f0-9-]+)[^)]*\)/i);
        const isSubChat = Boolean(parentMatch);
        const parentConvId = parentMatch ? parentMatch[1] : '';
        if (!lastText) return { ...empty, isSubChat, parentConvId };

        const firstSentence = lastText.split(/(?<=[.!?])\s+/)[0].slice(0, 110).trim();
        const fixHint = /\b(fix(ed)?|root cause|resolved|bug|crash|workaround|düzəl|səbəb)\b/i.test(lastText) ? firstSentence : '';
        const asksProceed = /\?|\b(proceed|continue|confirm|next step|ready|hazır|edək|edim)\b/i.test(lastText.slice(-300));
        const offerMatch = lastText.match(/[^.!?]*\b(unrelated|side[\s-]?(?:issue|task|bug)|separate\s+(?:chat|session)|sub[\s-]?(?:chat|session|agent)|alt\s*(?:session|chat)|dexlisiz|ayrıca)\b[^.!?]*/i);
        const subChatOffer = offerMatch ? offerMatch[0].trim().slice(0, 90) : '';
        const issueMatch = lastText.match(/[^.!?]*\b(fail(ed|ing)?|error|warn(ing)?|flake|broken|exception|timeout)\b[^.!?]*/i);
        const issueTopic = subChatOffer || (issueMatch ? issueMatch[0].trim().slice(0, 90) : '');
        const lastSummary = lastText.slice(0, 800);
        return { fixHint, asksProceed, issueTopic, subChatOffer, isSubChat, parentConvId, lastSummary };
    } catch {
        return empty;
    }
}

function buildSubChatResult(opts = {}) {
    const sig = getChatSignals(opts);
    const paths = getPaths(opts);
    const found = findTranscriptFile(paths.brainDir, opts.conv);
    const convTag = found ? found.convId.slice(0, 8) : 'subchat';
    const summary = sig.lastSummary
        ? `[Sub-Chat ${convTag} result]:\n${sig.lastSummary}`
        : `[Sub-Chat ${convTag} result]: (no assistant summary found yet)`;
    return { convId: found ? found.convId : null, parentConvId: sig.parentConvId, summary };
}

function getQuickDiffContext(workspaceDir) {
    if (!workspaceDir || !fs.existsSync(workspaceDir)) return '';
    try {
        const st = execFileSync('git', ['status', '--short'], {
            cwd: workspaceDir, encoding: 'utf8', windowsHide: true, timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const diffStat = execFileSync('git', ['diff', '--stat'], {
            cwd: workspaceDir, encoding: 'utf8', windowsHide: true, timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const parts = [];
        if (st) parts.push(`Git status:\n${st}`);
        if (diffStat) parts.push(`Diff stat:\n${diffStat}`);
        return parts.join('\n\n').slice(0, 1800);
    } catch {
        return '';
    }
}

/**
 * Builds a per-turn timeline (user prompt, touched files, token footprint) from the active transcript.
 */
function buildTurnTimeline(opts = {}) {
    const paths = getPaths(opts);
    const found = findTranscriptFile(paths.brainDir, opts.conv);
    if (!found) return { convId: null, turns: [] };
    const raw = readTranscriptTail(found.file);
    const turns = [];
    let current = null;

    for (const line of raw.split(/\r?\n/)) {
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (!obj || typeof obj !== 'object') continue;
        if (obj.type === 'USER_INPUT') {
            const txt = cleanPromptText(obj.content);
            if (!txt || txt === '/compact') continue;
            current = {
                turn: turns.length + 1,
                prompt: txt.slice(0, 120),
                filesEdited: [],
                tokens: 0,
                outputTokens: 0,
                assistantSnippet: '',
            };
            turns.push(current);
        } else if (obj.type === 'PLANNER_RESPONSE') {
            if (!current) {
                current = { turn: turns.length + 1, prompt: '(session start)', filesEdited: [], tokens: 0, outputTokens: 0, assistantSnippet: '' };
                turns.push(current);
            }
            if (typeof obj.input_tokens === 'number' || typeof obj.cache_read_tokens === 'number') {
                current.tokens = (Number(obj.input_tokens) || 0) + (Number(obj.cache_read_tokens) || 0);
            }
            current.outputTokens += Number(obj.output_tokens) || 0;
            if (typeof obj.content === 'string' && obj.content.trim()) {
                current.assistantSnippet = cleanPromptText(obj.content).slice(0, 260);
            }
            if (Array.isArray(obj.tool_calls)) {
                for (const tc of obj.tool_calls) {
                    const fp = extractFileArg(tc && tc.args);
                    if (fp && /edit|write|replace/i.test(String(tc && tc.name || ''))) {
                        const rel = shortPath(fp, paths.workspaceDir);
                        if (!current.filesEdited.includes(rel)) current.filesEdited.push(rel);
                    }
                }
            }
        }
    }

    return { convId: found.convId, turns: turns.slice(-12) };
}

/**
 * Forks an isolated Sub-Chat seeded from a specific historical turn in the timeline.
 */
function buildSubChatFromTurn(turnNumber, opts = {}) {
    const paths = getPaths(opts);
    const tl = buildTurnTimeline(opts);
    const target = tl.turns.find(t => t.turn === Number(turnNumber)) || tl.turns[tl.turns.length - 1];
    const git = getGitSnapshot(paths.workspaceDir);
    const convTag = tl.convId ? tl.convId.slice(0, 8) : null;
    const lines = [
        `# Forked Sub-Chat${convTag ? ` (from ${convTag} · Turn ${target ? target.turn : '?'})` : ''}`,
        `- Workspace: \`${paths.workspaceDir}\`${git.branch ? ` (branch \`${git.branch}\`)` : ''}`,
    ];
    if (target) {
        lines.push(`- Seeded Turn Request: ${target.prompt}`);
        if (target.filesEdited.length) lines.push('', '## Turn Files', ...target.filesEdited.map(f => `- \`${f}\``));
        if (target.assistantSnippet) lines.push('', '## State at Fork', target.assistantSnippet);
    }
    lines.push('', 'Continue independently from this turn snapshot without carrying full conversation bloat.');
    const markdown = lines.join('\n');
    return {
        convId: tl.convId,
        turn: target ? target.turn : null,
        promptTokensEst: estTokensFromBytes(Buffer.byteLength(markdown, 'utf8'), 4.0),
        markdown,
    };
}

module.exports = {
    extractTranscriptSignals,
    buildHandoff,
    buildSubChat,
    buildTurnTimeline,
    buildSubChatFromTurn,
    listFixes,
    addFix,
    removeFix,
    getChatSignals,
    buildSubChatResult,
    getQuickDiffContext,
};
