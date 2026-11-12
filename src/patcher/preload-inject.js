
// ---- CTXPILOT_OVERVIEW_HUB (renderer) ---------------------------------------
function installCtxPilotOverviewHub() {
    let state = null;
    let history = [];
    let skillFilter = '';
    let expandedSrv = null;
    let rendering = false;
    let open = { mcp: true, doctor: false, cli: true, prompts: false, rules: false, hooks: false, skills: false, tokens: false };
    try { Object.assign(open, JSON.parse(localStorage.getItem('ctxPilotOpen') || '{}')); } catch {}

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const invoke = (ch, ...a) => electron_1.ipcRenderer.invoke(ch, ...a);
    const k = (n) => n >= 1000 ? (n >= 10000 ? Math.round(n / 1000) + 'k' : (n / 1000).toFixed(1) + 'k') : String(n);

    function sendPrompt(text) {
        const input = document.querySelector('textarea, [contenteditable="true"]');
        if (!input) return;
        input.focus();
        if (input.tagName === 'TEXTAREA') {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            document.execCommand('selectAll', false);
            document.execCommand('insertText', false, text);
        }
        setTimeout(() => {
            const btn = document.querySelector('button[aria-label*="Send" i], button[title*="Send" i]');
            if (btn) btn.click();
            else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        }, 80);
    }

    function findOverviewMenu() {
        for (const c of document.querySelectorAll('div')) {
            if (c.id === 'ctxpilot-overview-hub') continue;
            const text = c.textContent || '';
            if (!text.includes('Extensions') || !(text.includes('Review') || text.includes('Terminal'))) continue;
            for (const child of c.children) {
                if (child.id !== 'ctxpilot-overview-hub' && (child.textContent || '').trim().startsWith('Extensions')) {
                    return { container: c, anchorRow: child };
                }
            }
        }
        return null;
    }

    const S = {
        label: 'font-size:10px;font-weight:700;color:#71717a;text-transform:uppercase;letter-spacing:.5px;',
        btn: 'background:rgba(59,130,246,.15);border:1px solid rgba(59,130,246,.4);color:#60a5fa;border-radius:4px;padding:3px 8px;font-size:11px;font-weight:600;cursor:pointer;',
        ghost: 'background:transparent;border:1px solid rgba(255,255,255,.1);color:#a1a1aa;border-radius:4px;padding:2px 6px;font-size:10px;cursor:pointer;',
        div: '<div style="height:1px;background:rgba(255,255,255,.06);"></div>',
        muted: 'font-size:10px;color:#71717a;',
    };

    const toggle = (cls, id, on) => `
        <div class="${cls}" data-id="${esc(id)}" style="flex:none;width:28px;height:16px;background:${on ? '#3b82f6' : '#27272a'};border-radius:9px;position:relative;cursor:pointer;">
            <div style="width:12px;height:12px;background:#fff;border-radius:50%;position:absolute;top:2px;left:${on ? '14px' : '2px'};transition:left .2s;"></div>
        </div>`;

    const section = (key, title, right, body) => `
        <div style="display:flex;flex-direction:column;gap:6px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <span class="cp-sec" data-sec="${key}" style="${S.label}cursor:pointer;user-select:none;">${open[key] ? 'v' : '>'} ${title}</span>
                <div style="display:flex;gap:6px;align-items:center;">${right}</div>
            </div>
            ${open[key] ? body : ''}
        </div>`;

    function renderKey() {
        if (!state) return '';
        return JSON.stringify([
            state.servers.map(s => [s.id, s.parked, s.readonly, s.tokensEst]),
            state.restartPending, state.doctor?.summary, state.context?.staticOverheadTokensEst,
            state.context?.transcript?.totalContextTokens, state.rules?.map(r => [r.name, r.enabled]),
            state.hooks?.map(h => [h.name, h.enabled]), state.skills?.length, state.actions,
            state.meta, state.profileHint, state.bloatAlert, expandedSrv, open, history.map(h => [h.id, h.peak]),
        ]);
    }

    function mcpBody() {
        const profiles = (state.profiles || []).map(p =>
            `<button class="cp-prof" data-prof="${esc(p.id)}" title="${esc(p.description)}" style="${S.ghost}">${esc(p.id)}</button>`
        ).join('');
        const rows = state.servers.map(s => {
            const on = !s.parked;
            const dot = !on ? '#52525b' : s.toolCount > 0 ? '#10b981' : '#f59e0b';
            const roBtn = s.readonly !== null
                ? `<button class="cp-ro" data-id="${esc(s.id)}" title="Toggle READONLY mode (requires restart)" style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;cursor:pointer;border:1px solid ${s.readonly ? 'rgba(16,185,129,.4)' : 'rgba(245,158,11,.4)'};background:${s.readonly ? 'rgba(16,185,129,.12)' : 'rgba(245,158,11,.15)'};color:${s.readonly ? '#34d399' : '#fbbf24'};">${s.readonly ? 'RO' : 'RW'}</button>`
                : '';
            const tgl = s.configurable ? toggle('cp-tgl', s.id, on) : `<span style="${S.muted}">plugin</span>`;
            const tokLabel = s.tokensEst ? ` · ~${k(s.tokensEst)} tok` : '';
            return `
            <div>
                <div style="display:flex;align-items:center;justify-content:space-between;padding:2px 0;gap:6px;">
                    <div class="cp-srv" data-id="${esc(s.id)}" style="display:flex;align-items:center;gap:6px;cursor:pointer;min-width:0;flex:1;" title="${esc(s.tools.join(', ') || s.transport)}">
                        <span style="width:6px;height:6px;border-radius:50%;flex:none;background:${dot};"></span>
                        <span style="font-weight:600;font-size:11px;color:${on ? '#f4f4f5' : '#a1a1aa'};">${esc(s.id)}</span>
                        <span style="font-size:9px;color:#71717a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${s.toolCount ? `${s.toolCount} tools` : esc(s.transport)}${tokLabel}</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:5px;flex:none;">${roBtn}${tgl}</div>
                </div>
                ${expandedSrv === s.id && s.tools.length ? `<div style="display:flex;flex-wrap:wrap;gap:3px;padding:2px 0 4px 12px;">${s.tools.map(t => `<span style="font-size:9px;font-family:monospace;color:#a1a1aa;background:rgba(255,255,255,.04);border-radius:3px;padding:1px 4px;">${esc(t)}</span>`).join('')}</div>` : ''}
            </div>`;
        }).join('');
        const banner = state.restartPending ? `<div style="font-size:10px;color:#f59e0b;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25);border-radius:4px;padding:4px 6px;">MCP config changed. Restart Antigravity to load/unload.</div>` : '';
        return `${banner}<div style="display:flex;flex-wrap:wrap;gap:4px;">${profiles}</div><div style="display:flex;flex-direction:column;gap:2px;max-height:180px;overflow-y:auto;">${rows}</div>`;
    }

    function doctorBody() {
        const d = state.doctor;
        if (!d) return '';
        const list = d.findings.filter(f => f.level !== 'OK').concat(d.findings.filter(f => f.level === 'OK').slice(0, 5));
        const rows = list.map(f => {
            const c = f.level === 'FAIL' ? '#ef4444' : f.level === 'WARN' ? '#f59e0b' : '#10b981';
            const tgt = String(f.target).split(/[\\/]/).pop();
            return `<div style="display:flex;gap:6px;align-items:center;font-size:10px;" title="${esc(f.message)}">
                <span style="color:${c};font-weight:700;font-family:monospace;flex:none;">${f.level}</span>
                <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#d4d4d8;">${esc(tgt)}: ${esc(f.message)}</span>
            </div>`;
        }).join('');
        const sug = (d.suggestions || []).map(s => `<div style="font-size:9px;font-family:monospace;color:#fbbf24;">${esc(s.serverId)}.${esc(s.location)}: ${esc(s.snippet)}</div>`).join('');
        return `<div style="display:flex;flex-direction:column;gap:3px;max-height:150px;overflow-y:auto;">${rows}${sug}</div>`;
    }

    function cliBody() {
        const actions = state.actions || [];
        if (!actions.length) return `<span style="${S.muted}">No scripts detected. Add package.json or .agents/hub.json.</span>`;
        return `<div style="display:flex;flex-wrap:wrap;gap:4px;">${actions.map(a =>
            `<button class="cp-cli" data-cmd="${esc(a.cmd)}" data-confirm="${a.confirm ? '1' : ''}" style="${a.primary ? S.btn : S.ghost}" title="${esc(a.cmd)}">${esc(a.label)}</button>`).join('')}</div>`;
    }

    function promptsBody() {
        const defaults = [
            ['Explain Codebase', 'Map out the architecture, entry points, and data flow of this repository.'],
            ['Review Diff', 'Review the current uncommitted git diff for bugs, edge cases, and security issues.'],
            ['Write Tests', 'Write unit/integration tests covering happy paths and edge cases for the recent changes.'],
            ['Refactor', 'Refactor the selected code for clarity and reduced duplication without changing behaviour.'],
            ['Fix Build / Lint', 'Run the build and linter, inspect any failures, and fix them cleanly.'],
            ['Commit Msg', 'Inspect git status and diff, then draft a concise Conventional Commit message.'],
        ];
        const list = [...(state.customPrompts || []).map(p => [p.label, p.text]), ...defaults];
        return `<div style="display:flex;flex-wrap:wrap;gap:4px;">${list.map(([label, text]) =>
            `<button class="cp-prompt" data-text="${esc(text)}" style="${S.ghost}" title="${esc(text)}">${esc(label)}</button>`).join('')}</div>`;
    }

    function rulesBody() {
        const color = (t) => t === 'always_on' ? '#10b981' : t === 'model_decision' ? '#60a5fa' : '#71717a';
        return `<div style="display:flex;flex-direction:column;gap:2px;max-height:140px;overflow-y:auto;">${(state.rules || []).map(r => `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:1px 0;">
                <div style="display:flex;align-items:center;gap:6px;min-width:0;">
                    <span style="font-size:9px;color:${color(r.trigger)};font-family:monospace;flex:none;">${r.trigger === 'always_on' ? 'ALWAYS' : r.trigger === 'model_decision' ? 'COND' : 'OFF'}</span>
                    <span style="font-size:11px;color:${r.enabled ? '#e4e4e7' : '#71717a'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${r.enabled ? '' : 'text-decoration:line-through;'}">${esc(r.name.replace(/\.md$/, ''))}</span>
                </div>
                ${toggle('cp-rule', r.name, r.enabled)}
            </div>`).join('') || `<span style="${S.muted}">No rules in .agents/rules</span>`}</div>`;
    }

    function hooksBody() {
        return `<div style="display:flex;flex-direction:column;gap:2px;">${(state.hooks || []).map(h => `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:1px 0;">
                <span style="font-size:11px;font-family:monospace;color:${h.enabled ? '#e4e4e7' : '#71717a'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(h.name)} <span style="${S.muted}">(${esc(h.events.join(','))})</span></span>
                ${toggle('cp-hook', h.name, h.enabled)}
            </div>`).join('') || `<span style="${S.muted}">No .agents/hooks.json</span>`}</div>`;
    }

    function skillsBody() {
        const sc = (s) => s === 'project' ? '#60a5fa' : s === 'global' ? '#a1a1aa' : '#c084fc';
        return `
            <input id="cp-skill-filter" placeholder="Filter skills" value="${esc(skillFilter)}" style="background:#0c0c0e;border:1px solid rgba(255,255,255,.08);border-radius:4px;color:#e4e4e7;font-size:11px;padding:3px 6px;outline:none;">
            <div style="display:flex;flex-wrap:wrap;gap:4px;max-height:96px;overflow-y:auto;">${(state.skills || []).map(s => `
                <span class="cp-skill" data-name="${esc(s.name.toLowerCase())}" title="${esc(s.scope)} - click to insert" style="cursor:pointer;padding:2px 6px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:4px;font-size:10px;color:${sc(s.scope)};font-family:monospace;white-space:nowrap;">${esc(s.name)}</span>`).join('')}</div>`;
    }

    function tokensBody() {
        if (!history.length) return `<span style="${S.muted}">No transcripts found.</span>`;
        const max = Math.max(200000, ...history.map(h => h.peak));
        const bars = history.slice().reverse().map(h => {
            const pct = Math.max(3, Math.round(h.peak / max * 100));
            const c = h.peak >= 160000 ? '#ef4444' : h.peak >= 120000 ? '#f59e0b' : '#10b981';
            return `<div title="${esc(h.title || h.id)}&#10;Peak: ${k(h.peak)} · Out: ${k(h.output)} · Steps: ${h.steps}" style="flex:1;height:${pct}%;background:${c};border-radius:2px 2px 0 0;min-width:4px;"></div>`;
        }).join('');
        return `<div style="display:flex;align-items:flex-end;gap:2px;height:44px;border-bottom:1px solid rgba(255,255,255,.08);">${bars}</div>
            <div style="display:flex;justify-content:space-between;${S.muted}"><span>Last ${history.length} chats</span><span>hover bar for details</span></div>`;
    }

    function render(force) {
        if (rendering || !document.body || !state) return;
        rendering = true;
        try {
            const target = findOverviewMenu();
            if (!target) return;
            const { container, anchorRow } = target;
            let hub = container.querySelector('#ctxpilot-overview-hub');
            const key = renderKey();
            if (hub && hub.dataset.key === key && !force) return;
            if (!hub) {
                hub = document.createElement('div');
                hub.id = 'ctxpilot-overview-hub';
                hub.style.cssText = 'margin:8px 6px 4px;background:#141416;border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px;font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:#e4e4e7;font-size:12px;display:flex;flex-direction:column;gap:9px;box-shadow:0 4px 12px rgba(0,0,0,.3);max-height:70vh;overflow-y:auto;';
                hub.addEventListener('click', e => e.stopPropagation());
                hub.addEventListener('mousedown', e => e.stopPropagation());
                container.insertBefore(hub, anchorRow.nextSibling);
            }
            hub.dataset.key = key;

            const c = state.context;
            const d = state.doctor;
            const t = c.transcript;
            const limit = t && t.available ? (t.totalContextTokens > 260000 ? 1000000 : 250000) : 250000;
            const pct = t && t.available ? Math.min(100, Math.round(t.totalContextTokens / limit * 100)) : 0;
            const uc = pct >= 80 ? '#ef4444' : pct >= 60 ? '#f59e0b' : '#10b981';
            const convTag = t && t.convId ? `chat ${t.convId.slice(0, 8)}` : 'transcript';

            const m = state.meta || {};
            const wsTitle = `${m.name || 'Workspace'}${m.branch ? ` @ ${m.branch}` : ''}${m.dirtyCount ? ` (${m.dirtyCount})` : ''}`;
            const graphChip = m.graphAgeHours != null ? `<span style="color:${m.graphAgeHours > 72 ? '#f59e0b' : '#71717a'};">${m.graphAgeHours >= 48 ? `graph ${Math.round(m.graphAgeHours / 24)}d` : `graph ${m.graphAgeHours}h`}</span>` : '';
            const activeMcps = state.servers.filter(s => !s.parked).length;
            const docBadgeColor = d.summary.fail ? '#ef4444' : d.summary.warn ? '#f59e0b' : '#10b981';
            const docBadge = `${d.summary.ok} ok` + (d.summary.warn ? ` · ${d.summary.warn} warn` : '') + (d.summary.fail ? ` · ${d.summary.fail} fail` : '');

            hub.innerHTML = `
                <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                    <span style="${S.label}">CTXPILOT</span>
                    <div style="display:flex;gap:4px;">
                        <button id="cp-compact" style="${S.btn}" title="Runs /compact summary (note: Antigravity only resets context on New Chat or auto-CHECKPOINT)">/compact</button>
                        <button id="cp-refresh" style="${S.ghost}">Refresh</button>
                    </div>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;gap:4px;font-size:10px;color:#a1a1aa;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:5px;padding:3px 6px;">
                    <span id="cp-pick-ws" title="${esc(state.workspace)} - click to switch" style="font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;">${esc(wsTitle)}</span>
                    <div style="display:flex;gap:4px;align-items:center;flex:none;">
                        ${graphChip}
                        ${m.mapFile ? `<button id="cp-open-map" style="${S.ghost}" title="Open ${esc(m.mapFile)}">Map</button>` : ''}
                    </div>
                </div>
                ${S.div}
                <div style="display:flex;flex-direction:column;gap:4px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <span style="${S.label}">CONTEXT</span>
                        <span style="font-size:10px;color:${uc};font-weight:600;" title="${esc(convTag)}">${t && t.available ? `${k(t.totalContextTokens)} / ${k(limit)} (${pct}% · ${t.cacheHitPct}% cache)` : 'no transcript'}</span>
                    </div>
                    ${t && t.available ? `<div style="height:4px;background:#27272a;border-radius:2px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:${uc};"></div></div>` : ''}
                    <div style="font-size:10px;color:#a1a1aa;">Static ~${k(c.staticOverheadTokensEst)} tok (Rules ~${k(c.rules.alwaysOnTokensEst)} · MCP ~${k(c.mcp.totalTokensEst)} · Skills ~${k(c.skills.tokensEst)})</div>
                    ${state.bloatAlert ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:5px;padding:4px 6px;">
                        <span style="font-size:10px;color:#fca5a5;">Bloat alert: park ${esc(state.bloatAlert.topServers.join(', '))} (~${k(state.bloatAlert.savingsTok)} tok)</span>
                        <button id="cp-park-heavy" style="background:rgba(239,68,68,.2);border:1px solid rgba(239,68,68,.45);color:#fca5a5;border-radius:4px;padding:2px 6px;font-size:10px;font-weight:600;cursor:pointer;flex:none;">Park</button>
                    </div>` : ''}
                    ${state.profileHint ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;background:rgba(59,130,246,.09);border:1px solid rgba(59,130,246,.28);border-radius:5px;padding:4px 6px;">
                        <span style="font-size:10px;color:#93c5fd;">${esc(state.profileHint.stack)} -> "${esc(state.profileHint.profile)}"${state.profileHint.savingsTok ? ` (-~${k(state.profileHint.savingsTok)} tok)` : ''}</span>
                        <button id="cp-apply-hint" style="${S.btn}padding:2px 6px;font-size:10px;flex:none;">Apply</button>
                    </div>` : ''}
                </div>
                ${S.div}
                ${section('mcp', 'MCP & PROFILES', `<span style="font-size:10px;color:${activeMcps ? '#10b981' : '#71717a'};font-weight:600;">${activeMcps}/${state.servers.length}</span><button id="cp-open-mcp" style="${S.ghost}">Config</button>`, mcpBody())}
                ${S.div}
                ${section('doctor', 'DOCTOR', `<span style="font-size:10px;color:${docBadgeColor};font-weight:600;">${docBadge}</span>`, doctorBody())}
                ${S.div}
                ${section('cli', 'PROJECT ACTIONS', '', cliBody())}
                ${S.div}
                ${section('prompts', 'QUICK PROMPTS', '', promptsBody())}
                ${S.div}
                ${section('rules', 'RULES', `<span style="${S.muted}">${state.rules.filter(r => r.enabled).length}/${state.rules.length}</span><button id="cp-open-rules" style="${S.ghost}">Open</button>`, rulesBody())}
                ${S.div}
                ${section('hooks', 'HOOKS', `<span style="${S.muted}">${state.hooks.filter(h => h.enabled).length}/${state.hooks.length}</span><button id="cp-open-hooks" style="${S.ghost}">Open</button>`, hooksBody())}
                ${S.div}
                ${section('skills', 'SKILLS', `<span style="${S.muted}">${state.skills.length}</span>`, skillsBody())}
                ${S.div}
                ${section('tokens', 'TOKEN HISTORY', '', tokensBody())}`;

            const applyFilter = () => {
                const q = skillFilter.trim().toLowerCase();
                hub.querySelectorAll('.cp-skill').forEach(el => { el.style.display = !q || el.dataset.name.includes(q) ? 'inline-block' : 'none'; });
            };
            applyFilter();

            const on = (sel, fn) => hub.querySelectorAll(sel).forEach(el => { el.onclick = (e) => fn(el, e); });
            on('#cp-compact', (b) => { b.textContent = 'Sent'; sendPrompt('/compact'); setTimeout(() => { b.textContent = '/compact'; }, 1200); });
            on('#cp-refresh', () => sync(true));
            on('#cp-park-heavy', async () => { if (state.bloatAlert) { state = await invoke('ctxpilot:park-heavy', state.bloatAlert.topServers) || state; render(true); } });
            on('#cp-apply-hint', async () => { if (state.profileHint) { state = await invoke('ctxpilot:apply-profile', state.profileHint.profile) || state; render(true); } });
            on('#cp-pick-ws', async () => { state = await invoke('ctxpilot:pick-workspace') || state; sync(true); });
            on('#cp-open-mcp', () => invoke('ctxpilot:open-path', 'mcpConfig'));
            on('#cp-open-rules', () => invoke('ctxpilot:open-path', 'rulesDir'));
            on('#cp-open-hooks', () => invoke('ctxpilot:open-path', 'hooksFile'));
            on('#cp-open-map', () => invoke('ctxpilot:open-path', 'agentsMd'));
            on('.cp-sec', (el) => { open[el.dataset.sec] = !open[el.dataset.sec]; try { localStorage.setItem('ctxPilotOpen', JSON.stringify(open)); } catch {} render(true); });
            on('.cp-srv', (el) => { expandedSrv = expandedSrv === el.dataset.id ? null : el.dataset.id; render(true); });
            on('.cp-prof', async (el) => { state = await invoke('ctxpilot:apply-profile', el.dataset.prof) || state; render(true); });
            on('.cp-ro', async (el) => {
                const srv = state.servers.find(s => s.id === el.dataset.id);
                if (!srv) return;
                state = await invoke('ctxpilot:toggle-ro', { id: srv.id, enabled: !srv.readonly }) || state;
                render(true);
            });
            on('.cp-tgl', async (el) => {
                const srv = state.servers.find(s => s.id === el.dataset.id);
                if (!srv) return;
                state = await invoke('ctxpilot:toggle-mcp', { id: srv.id, parked: srv.parked }) || state;
                render(true);
            });
            on('.cp-rule', async (el) => {
                const r = state.rules.find(x => x.name === el.dataset.id);
                if (!r) return;
                state = await invoke('ctxpilot:toggle-rule', { name: r.name, enabled: !r.enabled }) || state;
                render(true);
            });
            on('.cp-hook', async (el) => {
                const h = state.hooks.find(x => x.name === el.dataset.id);
                if (!h) return;
                state = await invoke('ctxpilot:toggle-hook', { name: h.name, enabled: !h.enabled }) || state;
                render(true);
            });
            on('.cp-cli', async (el) => {
                const cmd = el.dataset.cmd;
                if (el.dataset.confirm && !window.confirm(`Run "${cmd}" in ${state.workspace}?`)) return;
                const label = el.textContent;
                el.textContent = 'Opening';
                await invoke('ctxpilot:run-cli', cmd);
                setTimeout(() => { el.textContent = label; }, 1200);
            });
            on('.cp-prompt', (el) => {
                const input = document.querySelector('textarea, [contenteditable="true"]');
                if (!input) return;
                input.focus();
                document.execCommand('insertText', false, el.dataset.text || '');
            });
            on('.cp-skill', (el) => {
                const input = document.querySelector('textarea, [contenteditable="true"]');
                if (!input) return;
                input.focus();
                document.execCommand('insertText', false, `Use the ${el.textContent.trim()} skill. `);
            });
            const filter = hub.querySelector('#cp-skill-filter');
            if (filter) {
                filter.oninput = () => { skillFilter = filter.value; applyFilter(); };
                filter.onkeydown = (e) => e.stopPropagation();
            }
        } catch {} finally {
            rendering = false;
        }
    }

    let tick = 0;
    async function sync(force) {
        try {
            const heavy = force || tick % 6 === 0;
            const [s, h] = await Promise.all([
                invoke('ctxpilot:state'),
                heavy ? invoke('ctxpilot:token-history') : Promise.resolve(null),
            ]);
            if (s) state = s;
            if (h) history = h;
            tick++;
        } catch {}
        render(force);
    }

    const start = () => {
        if (!document.body) { setTimeout(start, 200); return; }
        document.addEventListener('click', () => setTimeout(render, 120), { passive: true });
        setInterval(sync, 5000);
        setInterval(render, 1000);
        sync(true);
    };
    start();
}
try { installCtxPilotOverviewHub(); } catch {}
// ---- /CTXPILOT_OVERVIEW_HUB --------------------------------------------------
