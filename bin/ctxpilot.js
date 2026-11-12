#!/usr/bin/env node
'use strict';
const { runDoctor, formatDoctor } = require('../src/doctor');
const { fixSecrets } = require('../src/secret-fix');
const { analyzeContext, formatContext } = require('../src/context');
const { parkServer, unparkServer, setReadonly, listProfiles, applyProfile } = require('../src/mcp-control');
const { patchStatus, patchInstall, patchEnsure, patchRestore } = require('../src/patcher');
const { initWorkspace, initHubConfig } = require('../src/stack');
const { runBench, formatBench } = require('../src/bench');
const { exportBundle, importBundle } = require('../src/bundle');
const { buildHandoff, buildSubChat, buildTurnTimeline, buildSubChatFromTurn, listFixes, addFix, removeFix } = require('../src/handoff');
const { createCheckpoint, listCheckpoints, rewindCheckpoint, dropCheckpoint, createWorktreeSubChat, listWorktrees, removeWorktree } = require('../src/checkpoint');
const { runVerify } = require('../src/verify');
const { syncAgents } = require('../src/sync');
const { runPrePushGate } = require('../src/gate');
const pkg = require('../package.json');

function parseArgs(argv) {
    const flags = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') flags.json = true;
        else if (a === '--fix-suggest') flags.fixSuggest = true;
        else if (a === '--fix') flags.fix = true;
        else if (a === '--strict') flags.strict = true;
        else if (a === '--ping') flags.ping = true;
        else if (a === '--dry-run') flags.dryRun = true;
        else if (a === '--restart') flags.restart = true;
        else if (a === '--run-hooks') flags.runHooks = true;
        else if (a === '--force') flags.force = true;
        else if (a === '--overwrite') flags.overwrite = true;
        else if (a === '--all') flags.all = true;
        else if (a === '--worktree') flags.worktree = true;
        else if (a === '--mcp') flags.mcp = true;
        else if (a === '--skip-verify') flags.skipVerify = true;
        else if (a === '--targets' && argv[i + 1]) flags.targets = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
        else if (a === '--version' || a === '-v') flags.version = true;
        else if (a === '--help' || a === '-h') flags.help = true;
        else if ((a === '--workspace' || a === '-w') && argv[i + 1]) flags.workspaceDir = argv[++i];
        else if (a === '--resources' && argv[i + 1]) flags.resources = argv[++i];
        else if (a === '--conv' && argv[i + 1]) flags.conv = argv[++i];
        else if (a === '--out' && argv[i + 1]) flags.out = argv[++i];
        else flags._.push(a);
    }
    return flags;
}

function printHelp() {
    console.log(`ctxpilot (ctx) v${pkg.version} - Unofficial Antigravity Context, MCP & Overview Hub

Usage:
  ctx doctor   [--fix] [--fix-suggest] [--strict] [--ping] [--dry-run] [--json]
  ctx context  [--json] [--conv <id>] [--workspace <dir>]
  ctx park     <server> [--dry-run] [--workspace <dir>]
  ctx unpark   <server> [--dry-run] [--workspace <dir>]
  ctx ro       <server> [--dry-run] [--workspace <dir>]
  ctx rw       <server> [--dry-run] [--workspace <dir>]
  ctx profile  list | <name> [--dry-run] [--workspace <dir>]
  ctx patch    install | ensure | restore | status [--restart] [--dry-run] [--resources <dir>]
  ctx hub      init [--dry-run] [--force] [--workspace <dir>]
  ctx init     [nextjs|dotnet|node|python|auto] [--dry-run] [--force] [--workspace <dir>]
  ctx bench    [--run-hooks] [--json] [--workspace <dir>]
  ctx handoff  [--conv <id>] [--workspace <dir>] [--json]
  ctx subchat  [topic...] [--worktree] [--conv <id>] [--workspace <dir>] [--json]
  ctx checkpoint create [label] | list | rm <id> [--dry-run] [--json]
  ctx rewind   [<id>] [--dry-run] [--json]
  ctx verify   [--workspace <dir>] [--json]
  ctx gate     [--strict] [--skip-verify] [--workspace <dir>] [--json]
  ctx sync     [--targets claude,codex,cursor,windsurf] [--mcp] [--dry-run] [--json]
  ctx timeline [--conv <id>] [--json]
  ctx fork     <turn> [--conv <id>] [--json]
  ctx worktree list | rm <path> [--dry-run] [--json]
  ctx fix      add "<note>" | list [--all] | rm <id> [--dry-run] [--json]
  ctx bundle   export [--out <file>] [--strict] [--dry-run] | import <file> [--overwrite] [--dry-run]

Flags:
  --dry-run        Preview config/file changes without writing
  --restart        Close and relaunch Antigravity automatically when patching (Windows)
  --fix            Move plaintext MCP secrets to OS env + ~/.gemini/.env and rewrite to \${ENV_VAR}
  --fix-suggest    Print \${ENV_VAR} replacement snippets (read-only)
  --run-hooks      Execute enabled hooks with "{}" stdin (2s timeout) during bench
  --strict         Exit 1 on warnings (doctor) or fail export on plaintext secrets (bundle)
  --json           Machine-readable JSON output`);
}

async function main() {
    const flags = parseArgs(process.argv.slice(2));
    if (flags.version) { console.log(pkg.version); return; }
    const cmd = flags._[0];
    const arg = flags._[1];
    if (flags.help || !cmd || cmd === 'help') { printHelp(); return; }

    if (cmd === 'doctor') {
        if (flags.fix) {
            const res = fixSecrets(flags);
            if (flags.json) console.log(JSON.stringify(res, null, 2));
            else if (res.fixedCount === 0) console.log('No plaintext MCP secrets found.');
            else {
                console.log(`${res.dryRun ? '[DRY-RUN] ' : ''}Fixed ${res.fixedCount} secret(s) without printing raw values:`);
                for (const c of res.changes) console.log(`  - ${c.serverId}.${c.location}.${c.key} -> \${${c.envVar}}`);
                if (!res.dryRun) console.log(`Saved env backup: ${res.dotEnvPath} | OS env: ${res.osEnv.method}`);
            }
            return;
        }
        const report = await runDoctor(flags);
        console.log(flags.json ? JSON.stringify(report, null, 2) : formatDoctor(report, flags));
        process.exitCode = report.exitCode;
        return;
    }

    if (cmd === 'context') {
        const report = analyzeContext(flags);
        console.log(flags.json ? JSON.stringify(report, null, 2) : formatContext(report));
        return;
    }

    if (cmd === 'park' || cmd === 'unpark') {
        if (!arg) throw new Error(`Usage: ctx ${cmd} <server-id>`);
        const res = cmd === 'park' ? parkServer(arg, flags) : unparkServer(arg, flags);
        console.log(flags.json ? JSON.stringify(res, null, 2) : `${res.dryRun ? '[DRY-RUN] ' : ''}${res.action}: ${res.id}${res.restartRequired ? ' (restart Antigravity to apply)' : ''}`);
        return;
    }

    if (cmd === 'ro' || cmd === 'rw') {
        if (!arg) throw new Error(`Usage: ctx ${cmd} <server-id>`);
        const res = setReadonly(arg, cmd === 'ro', flags);
        console.log(flags.json ? JSON.stringify(res, null, 2) : `${res.dryRun ? '[DRY-RUN] ' : ''}${res.id}: ${res.key}=${res.value}${res.restartRequired ? ' (restart Antigravity to apply)' : ''}`);
        return;
    }

    if (cmd === 'profile') {
        if (!arg || arg === 'list') {
            const profiles = listProfiles(flags);
            if (flags.json) console.log(JSON.stringify(profiles, null, 2));
            else for (const [k, v] of Object.entries(profiles)) console.log(`  ${k.padEnd(12)} ${v.description || ''}`);
            return;
        }
        const res = applyProfile(arg, flags);
        if (flags.json) console.log(JSON.stringify(res, null, 2));
        else {
            console.log(`${res.dryRun ? '[DRY-RUN] ' : ''}Profile "${res.profile}": ${res.changes.length} change(s).`);
            for (const c of res.changes) console.log(`  - ${c.action} ${c.id}${c.value ? ` (${c.key}=${c.value})` : ''}`);
        }
        return;
    }

    if (cmd === 'patch') {
        const sub = arg || 'status';
        if (sub === 'status') {
            const res = patchStatus(flags);
            console.log(flags.json ? JSON.stringify(res, null, 2) : `Antigravity ${res.version || '?'} | patched: ${res.patched} | upToDate: ${res.upToDate} | backup: ${res.hasBackup}`);
            return;
        }
        if (sub === 'install') {
            const res = patchInstall(flags);
            console.log(flags.json ? JSON.stringify(res, null, 2) : res.dryRun
                ? `[DRY-RUN] Would patch Antigravity ${res.version} (build ${res.buildHash}) in ${res.resDir}`
                : res.scheduledRestart
                    ? `Verified build ${res.buildHash} for Antigravity ${res.version} (${res.checked} untouched files OK). Restarting Antigravity to apply into Overview...`
                    : `Patched Antigravity ${res.version} (build ${res.buildHash}, ${res.checked} untouched files OK).`);
            return;
        }
        if (sub === 'ensure') {
            const res = patchEnsure(flags);
            console.log(flags.json ? JSON.stringify(res, null, 2) : res.alreadyUpToDate
                ? `Antigravity ${res.version} already patched and up to date (build ${res.buildHash}).`
                : res.dryRun
                    ? `[DRY-RUN] Would re-patch Antigravity ${res.version} (build ${res.buildHash})`
                    : res.scheduledRestart
                        ? `Re-patched Antigravity ${res.version} (build ${res.buildHash}). Restarting...`
                        : `Re-patched Antigravity ${res.version} (build ${res.buildHash}).`);
            return;
        }
        if (sub === 'restore') {
            const res = patchRestore(flags);
            console.log(flags.json ? JSON.stringify(res, null, 2) : res.dryRun
                ? `[DRY-RUN] Would restore ${res.installed} from ${res.backup}`
                : res.scheduledRestart
                    ? 'Closing Antigravity, restoring original app.asar, and relaunching...'
                    : `Restored ${res.installed}`);
            return;
        }
        throw new Error(`Unknown patch subcommand: ${sub}`);
    }

    if (cmd === 'hub') {
        if (arg !== 'init') throw new Error('Usage: ctx hub init [--dry-run] [--force] [--workspace <dir>]');
        const res = initHubConfig(flags);
        console.log(flags.json ? JSON.stringify(res, null, 2) : `${res.dryRun ? '[DRY-RUN] ' : ''}hub.json (${res.files[0].status}): ${res.files[0].path}`);
        return;
    }

    if (cmd === 'init') {
        const res = initWorkspace(arg, flags);
        if (flags.json) console.log(JSON.stringify(res, null, 2));
        else {
            console.log(`${res.dryRun ? '[DRY-RUN] ' : ''}Initialized stack "${res.stack}" (recommended profile: ${res.recommendedProfile}):`);
            for (const f of res.files) console.log(`  - ${f.status}: ${f.path}`);
        }
        return;
    }

    if (cmd === 'bench') {
        const res = runBench(flags);
        console.log(flags.json ? JSON.stringify(res, null, 2) : formatBench(res));
        return;
    }

    if (cmd === 'bundle') {
        if (arg === 'export') {
            const res = exportBundle(flags);
            console.log(flags.json ? JSON.stringify(res, null, 2) : `${res.dryRun ? '[DRY-RUN] ' : ''}Exported bundle: ${res.outFile} (${res.ruleCount} rules, ${res.mcpCount} MCPs, ${res.sanitizedSecrets} secret(s) sanitized)`);
            return;
        }
        if (arg === 'import') {
            const res = importBundle(flags._[2], flags);
            if (flags.json) console.log(JSON.stringify(res, null, 2));
            else {
                console.log(`${res.dryRun ? '[DRY-RUN] ' : ''}Imported bundle from ${res.bundleFile}:`);
                for (const f of res.files) console.log(`  - file ${f.status}: ${f.path}`);
                for (const m of res.mcpResults) console.log(`  - mcp ${m.status}: ${m.id}`);
            }
            return;
        }
        throw new Error('Usage: ctx bundle export [--out <file>] | import <file>');
    }

    if (cmd === 'handoff' || cmd === 'compact') {
        const res = buildHandoff(flags);
        console.log(flags.json ? JSON.stringify(res, null, 2) : res.markdown);
        return;
    }

    if (cmd === 'subchat') {
        const topic = flags._.slice(1).join(' ');
        const res = flags.worktree ? createWorktreeSubChat(topic, flags) : buildSubChat({ ...flags, topic });
        console.log(flags.json ? JSON.stringify(res, null, 2) : res.markdown);
        return;
    }

    if (cmd === 'checkpoint') {
        const sub = arg || 'list';
        if (sub === 'list') {
            const items = listCheckpoints(flags);
            if (flags.json) console.log(JSON.stringify(items, null, 2));
            else if (!items.length) console.log('No checkpoints found.');
            else for (const c of items) console.log(`  [${c.id}] ${c.label} (${c.branch}, ${c.dirtyCount} dirty) — ${c.createdAt}`);
            return;
        }
        if (sub === 'create') {
            const label = flags._.slice(2).join(' ') || 'manual';
            const res = createCheckpoint(label, flags);
            console.log(flags.json ? JSON.stringify(res, null, 2) : `${res.dryRun ? '[DRY-RUN] ' : ''}Checkpoint [${res.id}]: ${res.label}`);
            return;
        }
        if (sub === 'rm') {
            if (!flags._[2]) throw new Error('Usage: ctx checkpoint rm <id>');
            const res = dropCheckpoint(flags._[2], flags);
            console.log(flags.json ? JSON.stringify(res, null, 2) : `${res.dryRun ? '[DRY-RUN] ' : ''}Removed ${res.removed} checkpoint(s).`);
            return;
        }
        throw new Error('Usage: ctx checkpoint create [label] | list | rm <id>');
    }

    if (cmd === 'rewind') {
        const res = rewindCheckpoint(arg, flags);
        console.log(flags.json ? JSON.stringify(res, null, 2) : `${res.dryRun ? '[DRY-RUN] ' : ''}Rewound working tree to [${res.id}] ${res.label}`);
        return;
    }

    if (cmd === 'verify') {
        const res = await runVerify(flags);
        if (flags.json) console.log(JSON.stringify(res, null, 2));
        else if (res.skipped) console.log(res.reason);
        else console.log(`[${res.ok ? 'OK' : 'FAIL'}] ${res.command} (${res.durationMs} ms): ${res.summaryLine}`);
        if (!res.ok && !res.skipped) process.exitCode = 1;
        return;
    }

    if (cmd === 'worktree') {
        const sub = arg || 'list';
        if (sub === 'list') {
            const items = listWorktrees(flags);
            if (flags.json) console.log(JSON.stringify(items, null, 2));
            else if (!items.length) console.log('No ctxpilot worktrees found.');
            else for (const w of items) console.log(`  ${w.branch} -> ${w.path}`);
            return;
        }
        if (sub === 'rm') {
            if (!flags._[2]) throw new Error('Usage: ctx worktree rm <path>');
            const res = removeWorktree(flags._[2], flags);
            console.log(flags.json ? JSON.stringify(res, null, 2) : `${res.dryRun ? '[DRY-RUN] ' : ''}Removed worktree ${res.branch}`);
            return;
        }
        throw new Error('Usage: ctx worktree list | rm <path>');
    }

    if (cmd === 'fix') {
        const sub = arg || 'list';
        if (sub === 'list') {
            const items = listFixes(flags);
            if (flags.json) console.log(JSON.stringify(items, null, 2));
            else if (!items.length) console.log('No saved fixes.');
            else for (const f of items) console.log(`  [${f.id}] ${f.title}${f.detail ? ` — ${f.detail}` : ''}`);
            return;
        }
        if (sub === 'add') {
            const note = flags._.slice(2).join(' ');
            const res = addFix(note, '', flags);
            console.log(flags.json ? JSON.stringify(res, null, 2) : `${res.dryRun ? '[DRY-RUN] ' : ''}Saved fix [${res.entry.id}]: ${res.entry.title}`);
            return;
        }
        if (sub === 'rm') {
            if (!flags._[2]) throw new Error('Usage: ctx fix rm <id>');
            const res = removeFix(flags._[2], flags);
            console.log(flags.json ? JSON.stringify(res, null, 2) : `${res.dryRun ? '[DRY-RUN] ' : ''}Removed ${res.removed} fix(es).`);
            return;
        }
        throw new Error('Usage: ctx fix add "<note>" | list [--all] | rm <id>');
    }

    if (cmd === 'sync') {
        const res = syncAgents(flags);
        if (flags.json) console.log(JSON.stringify(res, null, 2));
        else if (!res.written.length) console.log(res.reason || 'Nothing to sync.');
        else {
            console.log(`${res.dryRun ? '[DRY-RUN] ' : ''}Synced from ${res.source}:`);
            for (const f of res.written) console.log(`  - ${f.target} (${f.status}): ${f.path}`);
        }
        return;
    }

    if (cmd === 'gate') {
        const res = await runPrePushGate(flags);
        if (flags.json) console.log(JSON.stringify(res, null, 2));
        else {
            console.log(`Pre-Push Gate: ${res.ok ? 'PASS' : 'BLOCKED'} (${res.dirtyCount} dirty: ${res.chatFiles.length} chat, ${res.otherFiles.length} local)`);
            for (const b of res.blockers) console.log(`  [FAIL] ${b.file}: ${b.message}`);
            for (const w of res.warnings) console.log(`  [WARN] ${w.file}: ${w.message}`);
            if (!res.verify.skipped) console.log(`  [VERIFY] ${res.verify.ok ? 'OK' : 'FAIL'} (${res.verify.command}): ${res.verify.summaryLine}`);
        }
        if (!res.ok) process.exitCode = 1;
        return;
    }

    if (cmd === 'timeline') {
        const res = buildTurnTimeline(flags);
        if (flags.json) console.log(JSON.stringify(res, null, 2));
        else if (!res.turns.length) console.log('No turns found.');
        else for (const t of res.turns) console.log(`  T${t.turn} | ${t.tokens} tok | ${t.filesEdited.length} file(s) | ${t.prompt}`);
        return;
    }

    if (cmd === 'fork') {
        const res = buildSubChatFromTurn(arg, flags);
        console.log(flags.json ? JSON.stringify(res, null, 2) : res.markdown);
        return;
    }

    console.error(`Unknown command: ${cmd}\nRun "ctx --help" for usage.`);
    process.exitCode = 1;
}

main().catch(err => {
    console.error(`[ERROR] ${err.message}`);
    process.exitCode = 1;
});
