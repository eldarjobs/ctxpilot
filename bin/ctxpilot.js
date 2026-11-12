#!/usr/bin/env node
'use strict';
const { runDoctor, formatDoctor } = require('../src/doctor');
const { analyzeContext, formatContext } = require('../src/context');
const { parkServer, unparkServer, setReadonly, listProfiles, applyProfile } = require('../src/mcp-control');
const { installSidecarPlugin, uninstallSidecarPlugin, statusSidecarPlugin } = require('../src/plugin-installer');
const { patchStatus, patchInstall, patchRestore } = require('../src/patcher');
const pkg = require('../package.json');

function parseArgs(argv) {
    const flags = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') flags.json = true;
        else if (a === '--fix-suggest') flags.fixSuggest = true;
        else if (a === '--strict') flags.strict = true;
        else if (a === '--ping') flags.ping = true;
        else if (a === '--dry-run') flags.dryRun = true;
        else if (a === '--restart') flags.restart = true;
        else if (a === '--version' || a === '-v') flags.version = true;
        else if (a === '--help' || a === '-h') flags.help = true;
        else if ((a === '--workspace' || a === '-w') && argv[i + 1]) flags.workspaceDir = argv[++i];
        else if (a === '--resources' && argv[i + 1]) flags.resources = argv[++i];
        else if (a === '--conv' && argv[i + 1]) flags.conv = argv[++i];
        else flags._.push(a);
    }
    return flags;
}

function printHelp() {
    console.log(`ctxpilot (ctx) v${pkg.version} - Unofficial Antigravity Context, MCP & Overview Hub

Usage:
  ctx doctor   [--json] [--fix-suggest] [--strict] [--ping] [--workspace <dir>]
  ctx context  [--json] [--conv <id>] [--workspace <dir>]
  ctx park     <server> [--dry-run] [--workspace <dir>]
  ctx unpark   <server> [--dry-run] [--workspace <dir>]
  ctx ro       <server> [--dry-run] [--workspace <dir>]
  ctx rw       <server> [--dry-run] [--workspace <dir>]
  ctx profile  list | <name> [--dry-run] [--workspace <dir>]
  ctx patch    install | restore | status [--restart] [--dry-run] [--resources <dir>]
  ctx ui       install | uninstall | status | serve [--dry-run]

Flags:
  --dry-run        Preview config/file changes without writing
  --restart        Close and relaunch Antigravity automatically when patching (Windows)
  --json           Machine-readable JSON output
  --fix-suggest    Print \${ENV_VAR} replacement snippets (read-only)
  --strict         Exit 1 on warnings as well as failures (doctor)
  --ping           Opt-in HTTP HEAD check on remote MCPs (doctor)`);
}

async function main() {
    const flags = parseArgs(process.argv.slice(2));
    if (flags.version) { console.log(pkg.version); return; }
    const cmd = flags._[0];
    const arg = flags._[1];
    if (flags.help || !cmd || cmd === 'help') { printHelp(); return; }

    if (cmd === 'doctor') {
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

    if (cmd === 'ui') {
        const sub = arg || 'status';
        if (sub === 'install') {
            const res = installSidecarPlugin(flags);
            console.log(flags.json ? JSON.stringify(res, null, 2) : `${res.dryRun ? '[DRY-RUN] ' : ''}Installed CtxPilot sidecar plugin at ${res.pluginDir}\nOpen inside Antigravity via sidecar URI: ${res.sidecarUri}`);
            return;
        }
        if (sub === 'uninstall') {
            const res = uninstallSidecarPlugin(flags);
            console.log(flags.json ? JSON.stringify(res, null, 2) : `${res.dryRun ? '[DRY-RUN] ' : ''}${res.existed ? 'Removed' : 'Not installed'}: ${res.pluginDir}`);
            return;
        }
        if (sub === 'status') {
            const res = statusSidecarPlugin(flags);
            console.log(flags.json ? JSON.stringify(res, null, 2) : `Sidecar UI plugin: ${res.installed ? 'installed' : 'not installed'} (${res.pluginDir})`);
            return;
        }
        if (sub === 'serve') {
            await import('../plugin/sidecars/ctxpilot_panel/server.mjs');
            return;
        }
        throw new Error(`Unknown ui subcommand: ${sub}`);
    }

    console.error(`Unknown command: ${cmd}\nRun "ctx --help" for usage.`);
    process.exitCode = 1;
}

main().catch(err => {
    console.error(`[ERROR] ${err.message}`);
    process.exitCode = 1;
});
