'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { getPaths, tryParseJson } = require('./discovery');
const { buildSubChat } = require('./handoff');

const MAX_CHECKPOINTS = 20;

function git(args, cwd, envExtra) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000,
        env: envExtra ? { ...process.env, ...envExtra } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function getRepoInfo(workspaceDir) {
    const root = git(['rev-parse', '--show-toplevel'], workspaceDir);
    const rawGitDir = git(['rev-parse', '--git-dir'], root);
    const gitDir = path.isAbsolute(rawGitDir) ? rawGitDir : path.resolve(root, rawGitDir);
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
    const head = git(['rev-parse', 'HEAD'], root);
    return { root, gitDir, branch, head };
}

function metaFile(gitDir) {
    return path.join(gitDir, 'ctxpilot-checkpoints.json');
}

function readMeta(gitDir) {
    const parsed = tryParseJson(metaFile(gitDir));
    return Array.isArray(parsed.data) ? parsed.data : [];
}

function writeMeta(gitDir, items) {
    fs.writeFileSync(metaFile(gitDir), JSON.stringify(items.slice(0, MAX_CHECKPOINTS), null, 2) + '\n', 'utf8');
}

/**
 * Creates a hidden git checkpoint snapshot (tracked + untracked) without altering git log or stash.
 */
function createCheckpoint(label, opts = {}) {
    const paths = getPaths(opts);
    const repo = getRepoInfo(paths.workspaceDir);
    const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const cleanLabel = String(label || 'snapshot').trim().slice(0, 80);

    if (opts.dryRun) {
        return { action: 'checkpoint-create', dryRun: true, id, label: cleanLabel, branch: repo.branch };
    }

    const tmpIdx = path.join(os.tmpdir(), `ctxpilot-idx-${process.pid}-${Date.now()}`);
    const realIdx = path.join(repo.gitDir, 'index');
    try {
        if (fs.existsSync(realIdx)) fs.copyFileSync(realIdx, tmpIdx);
        git(['add', '-A'], repo.root, { GIT_INDEX_FILE: tmpIdx });
        const treeSha = git(['write-tree'], repo.root, { GIT_INDEX_FILE: tmpIdx });
        const existing = readMeta(repo.gitDir);
        if (opts.dedupe && existing[0] && existing[0].treeSha === treeSha) {
            return { action: 'checkpoint-create', skipped: true, reason: 'unchanged', ...existing[0] };
        }
        const commitSha = git(['commit-tree', treeSha, '-p', repo.head, '-m', `ctxpilot checkpoint: ${cleanLabel}`], repo.root);
        git(['update-ref', `refs/ctxpilot/checkpoints/${id}`, commitSha], repo.root);

        const statusOut = git(['status', '--porcelain'], repo.root);
        const dirtyCount = statusOut ? statusOut.split(/\r?\n/).length : 0;
        const entry = {
            id,
            label: cleanLabel,
            auto: Boolean(opts.auto),
            turn: opts.turn || null,
            branch: repo.branch,
            head: repo.head,
            treeSha,
            commitSha,
            dirtyCount,
            createdAt: new Date().toISOString(),
        };
        writeMeta(repo.gitDir, [entry, ...existing]);
        return { action: 'checkpoint-create', ...entry };
    } finally {
        try { if (fs.existsSync(tmpIdx)) fs.unlinkSync(tmpIdx); } catch {}
    }
}

/**
 * Automatically snapshots working tree when a new conversation turn occurs and tree changed.
 */
function maybeAutoCheckpoint(turnNumber, convId, opts = {}) {
    try {
        if (!turnNumber || turnNumber < 1) return null;
        const list = listCheckpoints(opts);
        const tag = convId ? `${String(convId).slice(0, 6)}-t${turnNumber}` : `turn-${turnNumber}`;
        if (list.some(c => c.auto && c.label === tag)) return null;
        return createCheckpoint(tag, { ...opts, auto: true, turn: turnNumber, dedupe: true });
    } catch {
        return null;
    }
}

function listCheckpoints(opts = {}) {
    const paths = getPaths(opts);
    try {
        const repo = getRepoInfo(paths.workspaceDir);
        return readMeta(repo.gitDir);
    } catch {
        return [];
    }
}

/**
 * Rewinds the working tree back to the specified (or latest) checkpoint without moving HEAD.
 */
function rewindCheckpoint(id, opts = {}) {
    const paths = getPaths(opts);
    const repo = getRepoInfo(paths.workspaceDir);
    const list = readMeta(repo.gitDir);
    const target = id ? list.find(c => c.id === id) : list[0];
    if (!target) throw new Error(id ? `Checkpoint "${id}" not found.` : 'No checkpoints found.');

    if (opts.dryRun) {
        return { action: 'checkpoint-rewind', dryRun: true, id: target.id, label: target.label };
    }

    git(['read-tree', '--reset', '-u', target.commitSha], repo.root);
    const extraUntracked = git(['ls-files', '--others', '--exclude-standard'], repo.root);
    if (extraUntracked) {
        for (const rel of extraUntracked.split(/\r?\n/).filter(Boolean)) {
            const full = path.join(repo.root, rel);
            try { fs.rmSync(full, { recursive: true, force: true }); } catch {}
        }
    }
    git(['reset', '--mixed', repo.head], repo.root);
    return { action: 'checkpoint-rewind', rewound: true, id: target.id, label: target.label };
}

function dropCheckpoint(id, opts = {}) {
    const paths = getPaths(opts);
    const repo = getRepoInfo(paths.workspaceDir);
    const list = readMeta(repo.gitDir);
    const target = list.find(c => c.id === id);
    if (!target) return { action: 'checkpoint-rm', removed: 0 };
    if (!opts.dryRun) {
        try { git(['update-ref', '-d', `refs/ctxpilot/checkpoints/${target.id}`], repo.root); } catch {}
        writeMeta(repo.gitDir, list.filter(c => c.id !== id));
    }
    return { action: 'checkpoint-rm', dryRun: Boolean(opts.dryRun), removed: 1, id: target.id };
}

function slugify(text) {
    return String(text || 'side-task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || 'side-task';
}

/**
 * Creates a parallel git worktree and returns an isolated Sub-Chat prompt targeting that directory.
 */
function createWorktreeSubChat(topic, opts = {}) {
    const paths = getPaths(opts);
    const repo = getRepoInfo(paths.workspaceDir);
    const slug = `${slugify(topic)}-${Date.now().toString(36).slice(-4)}`;
    const branch = `ctxpilot/${slug}`;
    const wtDir = path.join(path.dirname(repo.root), `${path.basename(repo.root)}-wt-${slug}`);

    if (opts.dryRun) {
        const sub = buildSubChat({ ...opts, workspaceDir: wtDir, topic });
        return { action: 'worktree-subchat', dryRun: true, branch, worktreeDir: wtDir, ...sub };
    }

    git(['worktree', 'add', '-b', branch, wtDir], repo.root);
    const sub = buildSubChat({ ...opts, workspaceDir: wtDir, topic });
    return { action: 'worktree-subchat', branch, worktreeDir: wtDir, ...sub };
}

function listWorktrees(opts = {}) {
    const paths = getPaths(opts);
    try {
        const repo = getRepoInfo(paths.workspaceDir);
        const raw = git(['worktree', 'list', '--porcelain'], repo.root);
        const blocks = raw.split(/\r?\n\r?\n/).filter(Boolean);
        return blocks.map(b => {
            const wt = (b.match(/^worktree (.+)$/m) || [])[1] || '';
            const br = (b.match(/^branch (.+)$/m) || [])[1] || '';
            return { path: wt, branch: br.replace(/^refs\/heads\//, '') };
        }).filter(w => w.branch.startsWith('ctxpilot/'));
    } catch {
        return [];
    }
}

function removeWorktree(wtPath, opts = {}) {
    const paths = getPaths(opts);
    const repo = getRepoInfo(paths.workspaceDir);
    const normTarget = path.resolve(wtPath);
    const existing = listWorktrees(opts).find(w => path.resolve(w.path).toLowerCase() === normTarget.toLowerCase());
    if (!existing) throw new Error(`CtxPilot worktree not found: ${wtPath}`);
    if (opts.dryRun) return { action: 'worktree-rm', dryRun: true, ...existing };

    git(['worktree', 'remove', '--force', existing.path], repo.root);
    try { git(['branch', '-D', existing.branch], repo.root); } catch {}
    return { action: 'worktree-rm', removed: true, ...existing };
}

module.exports = {
    createCheckpoint,
    maybeAutoCheckpoint,
    listCheckpoints,
    rewindCheckpoint,
    dropCheckpoint,
    createWorktreeSubChat,
    listWorktrees,
    removeWorktree,
};
