    // ---- CTXPILOT_OVERVIEW_HUB (main process) ---------------------------------
    const cpCoreDir = __CTXPILOT_ROOT__;
    const cpOs = require('os');
    const cpSpawn = require('child_process').spawn;
    const cpExecFileSync = require('child_process').execFileSync;
    const { analyzeContext: cpAnalyzeContext } = require(path.join(cpCoreDir, 'context.js'));
    const { runDoctor: cpRunDoctor } = require(path.join(cpCoreDir, 'doctor.js'));
    const { getPaths: cpGetPaths, discoverMcp: cpDiscoverMcp, discoverRules: cpDiscoverRules, discoverSkills: cpDiscoverSkills, tryParseJson: cpTryParseJson } = require(path.join(cpCoreDir, 'discovery.js'));
    const { parkServer: cpPark, unparkServer: cpUnpark, setReadonly: cpSetRo, applyProfile: cpApplyProfile, listProfiles: cpListProfiles } = require(path.join(cpCoreDir, 'mcp-control.js'));

    let cpRestartPending = false;
    let cpMetaCache = { ts: 0, root: '', val: null };
    const cpTokenCache = new Map();

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

    async function cpState() {
        const paths = cpGetPaths({});
        const mcp = cpDiscoverMcp(paths);
        const ctx = cpAnalyzeContext({});
        const doc = await cpRunDoctor({});
        const { actions, customPrompts } = cpDiscoverActions(paths.workspaceDir);
        const skills = cpDiscoverSkills(paths);
        return {
            workspace: paths.workspaceDir,
            configPath: mcp.configFiles[0]?.path || paths.mcpConfigs[0],
            restartPending: cpRestartPending,
            meta: cpMeta(paths.workspaceDir),
            context: ctx,
            doctor: doc,
            servers: mcp.servers.map(s => {
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
            }),
            profiles: Object.entries(cpListProfiles({})).map(([id, p]) => ({ id, description: p.description || '' })),
            rules: cpListRules(paths.workspaceDir),
            hooks: cpListHooks(paths.workspaceDir),
            skills,
            actions,
            customPrompts,
        };
    }

    electron_1.ipcMain.handle('ctxpilot:state', async () => cpState());
    electron_1.ipcMain.handle('ctxpilot:token-history', async () => cpTokenHistory(cpGetPaths({}).brainDir, 12));

    electron_1.ipcMain.handle('ctxpilot:toggle-mcp', async (_e, p) => {
        if (p && p.parked) cpUnpark(p.id);
        else if (p && p.id) cpPark(p.id);
        cpRestartPending = true;
        return cpState();
    });

    electron_1.ipcMain.handle('ctxpilot:toggle-ro', async (_e, p) => {
        if (p && p.id) { cpSetRo(p.id, Boolean(p.enabled)); cpRestartPending = true; }
        return cpState();
    });

    electron_1.ipcMain.handle('ctxpilot:apply-profile', async (_e, profile) => {
        const res = cpApplyProfile(profile);
        if (res.changes.length > 0) cpRestartPending = true;
        return cpState();
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
        const paths = cpGetPaths({});
        const res = await electron_1.dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Select Workspace for CtxPilot', defaultPath: paths.workspaceDir });
        if (!res.canceled && res.filePaths && res.filePaths[0]) {
            fsSync.mkdirSync(paths.cfgDir, { recursive: true });
            fsSync.writeFileSync(path.join(paths.cfgDir, 'hub_workspace.json'), JSON.stringify({ workspace: res.filePaths[0] }, null, 2), 'utf8');
            cpMetaCache.ts = 0;
        }
        return cpState();
    });

    electron_1.ipcMain.handle('ctxpilot:run-cli', async (_e, cmdStr) => {
        const root = cpGetPaths({}).workspaceDir;
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
    // ---- /CTXPILOT_OVERVIEW_HUB -----------------------------------------------
