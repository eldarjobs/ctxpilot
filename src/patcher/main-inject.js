    // ---- CTXPILOT_OVERVIEW_HUB (main process) ---------------------------------
    try {
    const cpCoreDir = __CTXPILOT_ROOT__;
    const cpOs = require('os');
    const cpSpawn = require('child_process').spawn;
    const cpExecFileSync = require('child_process').execFileSync;
    const { analyzeContext: cpAnalyzeContext } = require(path.join(cpCoreDir, 'context.js'));
    const { runDoctor: cpRunDoctor } = require(path.join(cpCoreDir, 'doctor.js'));
    const { getPaths: cpGetPaths, discoverMcp: cpDiscoverMcp, discoverRules: cpDiscoverRules, discoverSkills: cpDiscoverSkills, tryParseJson: cpTryParseJson } = require(path.join(cpCoreDir, 'discovery.js'));
    const { parkServer: cpPark, unparkServer: cpUnpark, setReadonly: cpSetRo, applyProfile: cpApplyProfile, listProfiles: cpListProfiles } = require(path.join(cpCoreDir, 'mcp-control.js'));
    const { recommendProfile: cpRecommendProfile } = require(path.join(cpCoreDir, 'stack.js'));
    const { buildHandoff: cpBuildHandoff, buildSubChat: cpBuildSubChat, buildTurnTimeline: cpBuildTurnTimeline, buildSubChatFromTurn: cpBuildSubChatFromTurn, listFixes: cpListFixes, addFix: cpAddFix, removeFix: cpRemoveFix, getChatSignals: cpGetChatSignals, buildSubChatResult: cpBuildSubChatResult, getQuickDiffContext: cpGetQuickDiff } = require(path.join(cpCoreDir, 'handoff.js'));
    const { createCheckpoint: cpCreateCheckpoint, maybeAutoCheckpoint: cpMaybeAutoCheckpoint, listCheckpoints: cpListCheckpoints, rewindCheckpoint: cpRewindCheckpoint, dropCheckpoint: cpDropCheckpoint, createWorktreeSubChat: cpCreateWorktreeSubChat, listWorktrees: cpListWorktrees, removeWorktree: cpRemoveWorktree } = require(path.join(cpCoreDir, 'checkpoint.js'));
    const { detectVerifyCommand: cpDetectVerify, runVerify: cpRunVerify } = require(path.join(cpCoreDir, 'verify.js'));
    const { syncAgents: cpSyncAgents } = require(path.join(cpCoreDir, 'sync.js'));
    const { runPrePushGate: cpRunGate } = require(path.join(cpCoreDir, 'gate.js'));

    let cpRestartPending = false;
    let cpMetaCache = { ts: 0, root: '', val: null };
    let cpSlowCache = { ts: 0, root: '', doc: null, skills: null, checkpoints: null, worktrees: null, verifyCmd: null };
    let cpTxCache = { key: '', ws: '', ctx: null, sig: null, tl: null };
    const cpTokenCache = new Map();
    const cpAutoAppliedWorkspaces = new Set();
    const cpLastTurnAuto = new Map();

    function cpLatestTxSig(brainDir) {
        try {
            let best = '';
            let bestM = 0;
            for (const ent of fsSync.readdirSync(brainDir, { withFileTypes: true })) {
                if (!ent.isDirectory()) continue;
                const p = path.join(brainDir, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
                try {
                    const st = fsSync.statSync(p);
                    if (st.size > 0 && st.mtimeMs > bestM) { bestM = st.mtimeMs; best = `${ent.name}:${st.size}:${st.mtimeMs}`; }
                } catch {}
            }
            return best;
        } catch { return ''; }
    }

    function cpReadJson(p) { try { return JSON.parse(fsSync.readFileSync(p, 'utf8')); } catch { return null; } }

    function cpDiscoverActions(root) {
        const actions = [];
        const customPrompts = [];
        const add = (id, label, cmd, primary, confirm) => actions.push({ id, label, cmd, primary: Boolean(primary), confirm: Boolean(confirm) });

        const hubCfg = cpReadJson(path.join(root, '.agents', 'hub.json'));
        if (hubCfg) {
            if (Array.isArray(hubCfg.actions)) {
                for (const a of hubCfg.actions) {
                    if (a && a.label && a.command) add(`custom:${a.label}`, String(a.label), String(a.command), a.primary, a.confirm);
                }
            }
            if (Array.isArray(hubCfg.prompts)) {
                for (const p of hubCfg.prompts) {
                    if (p && p.label && p.text) customPrompts.push({ label: String(p.label), text: String(p.text) });
                }
            }
        }

        const pkg = cpReadJson(path.join(root, 'package.json'));
        if (pkg && pkg.scripts) {
            const preferred = ['dev', 'start', 'build', 'test', 'lint', 'typecheck'];
            const keys = Object.keys(pkg.scripts);
            const picked = [...preferred.filter(k => keys.includes(k)), ...keys.filter(k => !preferred.includes(k))].slice(0, 6);
            for (const k of picked) add(`npm:${k}`, `npm ${k}`, `npm run ${k}`, k === 'dev' || k === 'test', /deploy|release|prod/i.test(k));
        }

        try {
            const entries = fsSync.readdirSync(root);
            if (entries.some(f => f.endsWith('.sln') || f.endsWith('.csproj') || f === 'Directory.Build.props' || f === 'global.json')) {
                add('dotnet:build', 'dotnet build', 'dotnet build', false, false);
                add('dotnet:test', 'dotnet test', 'dotnet test', false, false);
            }
            if (entries.includes('pyproject.toml') || entries.includes('pytest.ini')) add('py:test', 'pytest', 'pytest', false, false);
            if (entries.includes('Cargo.toml')) add('cargo:test', 'cargo test', 'cargo test', false, false);
            if (entries.includes('go.mod')) add('go:test', 'go test', 'go test ./...', false, false);
        } catch {}

        if (fsSync.existsSync(path.join(root, 'graphify-out', 'graph.json'))) {
            add('tool:graphify', 'Update Graph', 'graphify update .', false, false);
        }
        return { actions: actions.slice(0, 10), customPrompts };
    }

    function cpMeta(root) {
        if (cpMetaCache.root === root && cpMetaCache.val && Date.now() - cpMetaCache.ts < 8000) return cpMetaCache.val;
        let branch = '', dirtyCount = 0, graphAgeHours = null;
        const hooksActive = fsSync.existsSync(path.join(root, '.agents', 'hooks.json'));
        const mapFile = ['AGENTS.md', 'GEMINI.md', 'CLAUDE.md'].find(f => fsSync.existsSync(path.join(root, f))) || null;
        try {
            branch = cpExecFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
            const st = cpExecFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
            dirtyCount = st ? st.split(/\r?\n/).length : 0;
        } catch {}
        try {
            const gf = path.join(root, 'graphify-out', 'graph.json');
            if (fsSync.existsSync(gf)) graphAgeHours = Math.round((Date.now() - fsSync.statSync(gf).mtimeMs) / 36e5);
        } catch {}
        const val = { name: path.basename(root), branch, dirtyCount, graphAgeHours, hooksActive, mapFile };
        cpMetaCache = { ts: Date.now(), root, val };
        return val;
    }

    function cpListRules(workspaceDir) {
        const rulesDir = path.join(workspaceDir, '.agents', 'rules');
        const active = cpDiscoverRules(workspaceDir).items
            .filter(r => r.source === '.agents/rules' && r.name !== '00-active-mcps.md')
            .map(r => ({ name: r.name, enabled: true, trigger: r.trigger, bytes: r.bytes }));
        const disabled = [];
        if (fsSync.existsSync(rulesDir)) {
            for (const f of fsSync.readdirSync(rulesDir)) {
                if (!f.endsWith('.md.disabled')) continue;
                disabled.push({ name: f.slice(0, -'.disabled'.length), enabled: false, trigger: 'disabled', bytes: fsSync.statSync(path.join(rulesDir, f)).size });
            }
        }
        return [...active, ...disabled].sort((a, b) => a.name.localeCompare(b.name));
    }

    function cpListHooks(workspaceDir) {
        const hp = path.join(workspaceDir, '.agents', 'hooks.json');
        const parsed = cpTryParseJson(hp);
        if (!parsed.data || typeof parsed.data !== 'object') return [];
        return Object.entries(parsed.data).map(([name, cfg]) => ({
            name,
            enabled: cfg.enabled !== false,
            events: ['SessionStart', 'PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop'].filter(e => Boolean(cfg[e])),
        }));
    }

    function cpTokenHistory(brainDir, limit) {
        const items = [];
        try {
            for (const ent of fsSync.readdirSync(brainDir, { withFileTypes: true })) {
                if (!ent.isDirectory()) continue;
                const t = path.join(brainDir, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
                try { const st = fsSync.statSync(t); items.push({ id: ent.name, file: t, st }); } catch {}
            }
        } catch { return []; }
        items.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
        return items.slice(0, limit).map(({ id, file, st }) => {
            const key = `${id}:${st.size}:${st.mtimeMs}`;
            if (cpTokenCache.has(key)) return cpTokenCache.get(key);
            let peak = 0, output = 0, steps = 0, title = '';
            try {
                const size = Math.min(st.size, 512 * 1024);
                const fd = fsSync.openSync(file, 'r');
                const buf = Buffer.alloc(size);
                fsSync.readSync(fd, buf, 0, size, st.size - size);
                fsSync.closeSync(fd);
                for (const line of buf.toString('utf8').split('\n')) {
                    if (!line.includes('PLANNER_RESPONSE') && !line.includes('USER_INPUT')) continue;
                    try {
                        const o = JSON.parse(line);
                        if (o.type === 'PLANNER_RESPONSE') {
                            steps++;
                            peak = Math.max(peak, (o.input_tokens || 0) + (o.cache_read_tokens || 0));
                            output += o.output_tokens || 0;
                        } else if (!title && o.type === 'USER_INPUT' && typeof o.content === 'string') {
                            title = o.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
                        }
                    } catch {}
                }
            } catch {}
            const r = { id: id.slice(0, 8), title, peak, output, steps, updated: st.mtime.toISOString() };
            cpTokenCache.set(key, r);
            return r;
        });
    }

    function cpActiveOpts(extra = {}) {
        let titleHint = '';
        try {
            const win = (typeof utils_1 !== 'undefined' && (utils_1.getFocusedHubWindow?.() || utils_1.getHubWindows?.()?.[0])) || electron_1.BrowserWindow.getFocusedWindow();
            if (win && !win.isDestroyed()) titleHint = win.getTitle() || '';
        } catch {}
        return { titleHint, ...extra };
    }

    async function cpState(force) {
        const opts = cpActiveOpts();
        const paths = cpGetPaths(opts);
        const now = Date.now();
        const freshSlow = force || cpSlowCache.root !== paths.workspaceDir || (now - cpSlowCache.ts > 30000);
        const mcp = cpDiscoverMcp(paths);
        const txSig = cpLatestTxSig(paths.brainDir);
        const freshTx = force || !txSig || cpTxCache.key !== txSig || cpTxCache.ws !== paths.workspaceDir;

        const ctx = freshTx ? cpAnalyzeContext(opts) : cpTxCache.ctx;
        const sig = freshTx ? cpGetChatSignals(opts) : cpTxCache.sig;
        const tl = freshTx ? cpBuildTurnTimeline(opts) : cpTxCache.tl;
        if (freshTx && txSig) cpTxCache = { key: txSig, ws: paths.workspaceDir, ctx, sig, tl };

        const doc = freshSlow ? await cpRunDoctor({ ...opts, skipPatchCheck: true }) : cpSlowCache.doc;
        const skills = freshSlow ? cpDiscoverSkills(paths) : cpSlowCache.skills;
        const checkpoints = freshSlow ? cpListCheckpoints(opts).slice(0, 12) : cpSlowCache.checkpoints;
        const worktrees = freshSlow ? cpListWorktrees(opts) : cpSlowCache.worktrees;
        const verifyCmd = freshSlow ? cpDetectVerify(paths.workspaceDir) : cpSlowCache.verifyCmd;
        if (freshSlow) cpSlowCache = { ts: now, root: paths.workspaceDir, doc, skills, checkpoints, worktrees, verifyCmd };

        const { actions, customPrompts } = cpDiscoverActions(paths.workspaceDir);
        const profiles = cpListProfiles(opts);
        const hubCfg = cpReadJson(path.join(paths.workspaceDir, '.agents', 'hub.json'));
        const servers = mcp.servers
            .filter(s => !s.client || s.client === 'antigravity')
            .map(s => {
                const env = (s.def && s.def.env) || {};
                const roKey = ['READONLY', 'DB_READONLY'].find(k => Object.prototype.hasOwnProperty.call(env, k));
                const schemaInfo = ctx.mcp.servers.find(m => m.id === s.id);
                return {
                    id: s.id,
                    transport: s.transport,
                    parked: s.parked,
                    configurable: paths.mcpConfigs.includes(s.source) || s.parked,
                    toolCount: s.tools.length,
                    tools: s.tools,
                    tokensEst: schemaInfo ? schemaInfo.tokensEst : 0,
                    readonly: roKey ? String(env[roKey]).toLowerCase() === 'true' : null,
                };
            });
        let profileHint = cpRecommendProfile(paths.workspaceDir, servers, hubCfg, profiles);
        if (profileHint.autoApply && profileHint.changesCount > 0 && !cpAutoAppliedWorkspaces.has(paths.workspaceDir)) {
            cpAutoAppliedWorkspaces.add(paths.workspaceDir);
            try {
                const applied = cpApplyProfile(profileHint.profile, opts);
                if (applied.changes.length > 0) cpRestartPending = true;
                profileHint = { ...profileHint, changesCount: 0, autoApplied: true };
            } catch {}
        }
        const t = ctx.transcript;
        const limit = t && t.available ? (t.totalContextTokens > 200000 ? 1000000 : 200000) : 200000;
        const ctxPct = t && t.available ? Math.round(t.totalContextTokens / limit * 100) : 0;
        const heavyActive = servers.filter(s => !s.parked && s.configurable && s.tokensEst >= 1200).sort((a, b) => b.tokensEst - a.tokensEst);
        const bloatAlert = (ctxPct >= 75 || ctx.staticOverheadTokensEst >= 15000) && heavyActive.length > 0
            ? { ctxPct, staticTok: ctx.staticOverheadTokensEst, topServers: heavyActive.slice(0, 2).map(s => s.id), savingsTok: heavyActive.slice(0, 2).reduce((n, s) => n + s.tokensEst, 0) }
            : null;
        const latestTurn = tl.turns.length ? tl.turns[tl.turns.length - 1] : null;
        if (latestTurn && tl.convId && cpLastTurnAuto.get(tl.convId) !== latestTurn.turn) {
            cpLastTurnAuto.set(tl.convId, latestTurn.turn);
            setTimeout(() => {
                try { cpMaybeAutoCheckpoint(latestTurn.turn, tl.convId, opts); cpSlowCache.ts = 0; } catch {}
            }, 250);
        }
        return {
            workspace: paths.workspaceDir,
            workspacePinned: fsSync.existsSync(path.join(paths.cfgDir, 'hub_workspace.json')),
            configPath: mcp.configFiles[0]?.path || paths.mcpConfigs[0],
            restartPending: cpRestartPending,
            meta: cpMeta(paths.workspaceDir),
            context: ctx,
            doctor: doc,
            servers,
            profiles: Object.entries(profiles).map(([id, p]) => ({ id, description: p.description || '' })),
            profileHint: profileHint.changesCount > 0 ? profileHint : null,
            bloatAlert,
            rules: cpListRules(paths.workspaceDir),
            hooks: cpListHooks(paths.workspaceDir),
            skills,
            actions,
            customPrompts,
            fixes: cpListFixes(opts).slice(0, 15),
            chatSignals: sig,
            timeline: tl.turns,
            checkpoints,
            worktrees,
            verifyCmd,
        };
    }

    electron_1.ipcMain.handle('ctxpilot:state', async (_e, force) => cpState(Boolean(force)));
    electron_1.ipcMain.handle('ctxpilot:token-history', async () => cpTokenHistory(cpGetPaths(cpActiveOpts()).brainDir, 12));

    electron_1.ipcMain.handle('ctxpilot:toggle-mcp', async (_e, p) => {
        const opts = cpActiveOpts();
        if (p && p.parked) cpUnpark(p.id, opts);
        else if (p && p.id) cpPark(p.id, opts);
        cpRestartPending = true;
        return cpState(true);
    });

    electron_1.ipcMain.handle('ctxpilot:toggle-ro', async (_e, p) => {
        if (p && p.id) { cpSetRo(p.id, Boolean(p.enabled), cpActiveOpts()); cpRestartPending = true; }
        return cpState(true);
    });

    electron_1.ipcMain.handle('ctxpilot:apply-profile', async (_e, profile) => {
        const res = cpApplyProfile(profile, cpActiveOpts());
        if (res.changes.length > 0) cpRestartPending = true;
        return cpState(true);
    });

    electron_1.ipcMain.handle('ctxpilot:park-heavy', async (_e, ids) => {
        const opts = cpActiveOpts();
        if (Array.isArray(ids)) {
            for (const id of ids) { try { cpPark(id, opts); cpRestartPending = true; } catch {} }
        }
        return cpState(true);
    });

    electron_1.ipcMain.handle('ctxpilot:toggle-rule', async (_e, p) => {
        const name = p && p.name;
        if (typeof name === 'string' && /^[\w.-]+\.md$/.test(name) && name !== '00-active-mcps.md') {
            const rulesDir = path.join(cpGetPaths({}).workspaceDir, '.agents', 'rules');
            const on = path.join(rulesDir, name), off = on + '.disabled';
            if (p.enabled && fsSync.existsSync(off)) fsSync.renameSync(off, on);
            if (!p.enabled && fsSync.existsSync(on)) fsSync.renameSync(on, off);
        }
        return cpState();
    });

    electron_1.ipcMain.handle('ctxpilot:toggle-hook', async (_e, p) => {
        const hp = path.join(cpGetPaths({}).workspaceDir, '.agents', 'hooks.json');
        const parsed = cpTryParseJson(hp);
        if (parsed.data && p && parsed.data[p.name]) {
            parsed.data[p.name].enabled = Boolean(p.enabled);
            fsSync.writeFileSync(hp, JSON.stringify(parsed.data, null, 2) + '\n', 'utf8');
        }
        return cpState();
    });

    electron_1.ipcMain.handle('ctxpilot:pick-workspace', async () => {
        const paths = cpGetPaths(cpActiveOpts());
        const res = await electron_1.dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Select Workspace for CtxPilot', defaultPath: paths.workspaceDir });
        if (!res.canceled && res.filePaths && res.filePaths[0]) {
            fsSync.mkdirSync(paths.cfgDir, { recursive: true });
            fsSync.writeFileSync(path.join(paths.cfgDir, 'hub_workspace.json'), JSON.stringify({ workspace: res.filePaths[0] }, null, 2), 'utf8');
            cpMetaCache.ts = 0;
        }
        return cpState();
    });

    electron_1.ipcMain.handle('ctxpilot:unpin-workspace', async () => {
        const paths = cpGetPaths({});
        try { fsSync.unlinkSync(path.join(paths.cfgDir, 'hub_workspace.json')); } catch {}
        cpMetaCache.ts = 0;
        return cpState();
    });

    electron_1.ipcMain.handle('ctxpilot:run-cli', async (_e, cmdStr) => {
        const root = cpGetPaths(cpActiveOpts()).workspaceDir;
        const { actions } = cpDiscoverActions(root);
        const allowed = actions.find(a => a.cmd === cmdStr);
        if (!allowed || !fsSync.existsSync(root)) return false;
        if (process.platform === 'win32') {
            cpSpawn('cmd.exe', ['/c', 'start', `"${allowed.label}"`, 'powershell.exe', '-NoExit', '-Command', allowed.cmd], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true }).unref();
        } else if (process.platform === 'darwin') {
            const escCmd = `cd '${root.replace(/'/g, "'\\''")}' && ${allowed.cmd}`;
            cpSpawn('osascript', ['-e', `tell application "Terminal" to do script "${escCmd.replace(/"/g, '\\"')}"`], { detached: true, stdio: 'ignore' }).unref();
        } else {
            cpSpawn('x-terminal-emulator', ['-e', 'bash', '-lc', `${allowed.cmd}; exec bash`], { cwd: root, detached: true, stdio: 'ignore' }).unref();
        }
        cpMetaCache.ts = 0;
        return true;
    });

    electron_1.ipcMain.handle('ctxpilot:open-path', async (_e, target) => {
        const paths = cpGetPaths({});
        const mapFile = ['AGENTS.md', 'GEMINI.md', 'CLAUDE.md'].find(f => fsSync.existsSync(path.join(paths.workspaceDir, f))) || 'AGENTS.md';
        const allowed = {
            mcpConfig: paths.mcpConfigs.find(p => fsSync.existsSync(p)),
            rulesDir: path.join(paths.workspaceDir, '.agents', 'rules'),
            hooksFile: path.join(paths.workspaceDir, '.agents', 'hooks.json'),
            agentsMd: path.join(paths.workspaceDir, mapFile),
        };
        const p = allowed[target];
        if (p) await electron_1.shell.openPath(p);
        return Boolean(p);
    });

    electron_1.ipcMain.handle('ctxpilot:handoff', async (_e, p) => {
        const res = cpBuildHandoff(cpActiveOpts({ conv: p && p.conv }));
        try { if (electron_1.clipboard && res.markdown) electron_1.clipboard.writeText(res.markdown); } catch {}
        return res;
    });

    electron_1.ipcMain.handle('ctxpilot:subchat', async (_e, p) => {
        const res = cpBuildSubChat(cpActiveOpts({ topic: p && p.topic, conv: p && p.conv }));
        try { if (electron_1.clipboard && res.markdown) electron_1.clipboard.writeText(res.markdown); } catch {}
        return res;
    });

    electron_1.ipcMain.handle('ctxpilot:subchat-result', async (_e, p) => {
        const res = cpBuildSubChatResult(cpActiveOpts({ conv: p && p.conv }));
        try { if (electron_1.clipboard && res.summary) electron_1.clipboard.writeText(res.summary); } catch {}
        return res;
    });

    electron_1.ipcMain.handle('ctxpilot:add-fix', async (_e, p) => {
        if (p && p.title) cpAddFix(p.title, p.detail || '', cpActiveOpts({ convId: p.convId }));
        return cpState();
    });

    electron_1.ipcMain.handle('ctxpilot:rm-fix', async (_e, id) => {
        if (id) cpRemoveFix(id, cpActiveOpts());
        return cpState();
    });

    electron_1.ipcMain.handle('ctxpilot:restart-app', async () => {
        try { if (typeof utils_1 !== 'undefined' && utils_1.setShowQuitConfirmation) utils_1.setShowQuitConfirmation(false); } catch {}
        electron_1.app.relaunch();
        setTimeout(() => electron_1.app.quit(), 80);
        return true;
    });

    electron_1.ipcMain.handle('ctxpilot:inject-snippet', async (_e, kind) => {
        const opts = cpActiveOpts();
        const paths = cpGetPaths(opts);
        if (kind === 'diff') return cpGetQuickDiff(paths.workspaceDir);
        if (kind === 'map') {
            const mapFile = ['AGENTS.md', 'GEMINI.md', 'CLAUDE.md'].find(f => fsSync.existsSync(path.join(paths.workspaceDir, f)));
            if (!mapFile) return '';
            try { return `# ${mapFile}\n` + fsSync.readFileSync(path.join(paths.workspaceDir, mapFile), 'utf8').slice(0, 2200); } catch { return ''; }
        }
        if (kind === 'fixes') {
            const fixes = cpListFixes(opts).slice(0, 8);
            return fixes.length ? 'Saved workspace fixes:\n' + fixes.map(f => `- ${f.title}${f.detail ? `: ${f.detail}` : ''}`).join('\n') : '';
        }
        return '';
    });

    electron_1.ipcMain.handle('ctxpilot:checkpoint-create', async (_e, label) => {
        cpCreateCheckpoint(label || 'manual', cpActiveOpts());
        return cpState(true);
    });

    electron_1.ipcMain.handle('ctxpilot:checkpoint-rewind', async (_e, id) => {
        cpRewindCheckpoint(id || null, cpActiveOpts());
        cpMetaCache.ts = 0;
        return cpState(true);
    });

    electron_1.ipcMain.handle('ctxpilot:checkpoint-rm', async (_e, id) => {
        if (id) cpDropCheckpoint(id, cpActiveOpts());
        return cpState(true);
    });

    electron_1.ipcMain.handle('ctxpilot:worktree-subchat', async (_e, p) => {
        const res = cpCreateWorktreeSubChat(p && p.topic, cpActiveOpts({ conv: p && p.conv }));
        try { if (electron_1.clipboard && res.markdown) electron_1.clipboard.writeText(res.markdown); } catch {}
        cpSlowCache.ts = 0;
        return res;
    });

    electron_1.ipcMain.handle('ctxpilot:worktree-rm', async (_e, wtPath) => {
        if (wtPath) cpRemoveWorktree(wtPath, cpActiveOpts());
        return cpState(true);
    });

    electron_1.ipcMain.handle('ctxpilot:verify', async () => cpRunVerify(cpActiveOpts()));
    electron_1.ipcMain.handle('ctxpilot:gate', async (_e, p) => cpRunGate(cpActiveOpts({ strict: Boolean(p && p.strict) })));
    electron_1.ipcMain.handle('ctxpilot:sync-agents', async (_e, p) => cpSyncAgents(cpActiveOpts({ mcp: Boolean(p && p.mcp) })));
    electron_1.ipcMain.handle('ctxpilot:fork-turn', async (_e, turn) => {
        const res = cpBuildSubChatFromTurn(turn, cpActiveOpts());
        try { if (electron_1.clipboard && res.markdown) electron_1.clipboard.writeText(res.markdown); } catch {}
        return res;
    });
    } catch (cpErr) {
        try { console.error('[ctxpilot] Overview Hub init failed:', cpErr); } catch {}
    }
    // ---- /CTXPILOT_OVERVIEW_HUB -----------------------------------------------
