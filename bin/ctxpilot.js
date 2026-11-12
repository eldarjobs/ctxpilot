#!/usr/bin/env node
'use strict';
const { runDoctor, formatDoctor } = require('../src/doctor');
const { analyzeContext, formatContext } = require('../src/context');
const pkg = require('../package.json');

function parseArgs(argv) {
    const flags = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') flags.json = true;
        else if (a === '--fix-suggest') flags.fixSuggest = true;
        else if (a === '--strict') flags.strict = true;
        else if (a === '--ping') flags.ping = true;
        else if (a === '--version' || a === '-v') flags.version = true;
        else if (a === '--help' || a === '-h') flags.help = true;
        else if ((a === '--workspace' || a === '-w') && argv[i + 1]) flags.workspaceDir = argv[++i];
        else if (a === '--conv' && argv[i + 1]) flags.conv = argv[++i];
        else flags._.push(a);
    }
    return flags;
}

function printHelp() {
    console.log(`ctxpilot v${pkg.version} - Unofficial Antigravity Context & MCP Toolkit (read-only)

Usage:
  ctxpilot doctor  [--json] [--fix-suggest] [--strict] [--ping] [--workspace <dir>]
  ctxpilot context [--json] [--conv <id>] [--workspace <dir>]

Options:
  --json           Machine-readable output (secrets remain redacted)
  --fix-suggest    Print \${ENV_VAR} replacement snippets for detected secrets (read-only)
  --strict         Exit 1 on warnings as well as failures (doctor)
  --ping           Probe HTTP MCP endpoints with a HEAD request (opt-in network call)
  --workspace <d>  Analyze a specific workspace directory
  --conv <id>      Read token usage from a specific conversation ID
  -v, --version    Show version
  -h, --help       Show help`);
}

async function main() {
    const flags = parseArgs(process.argv.slice(2));
    if (flags.version) {
        console.log(pkg.version);
        return;
    }
    const cmd = flags._[0];
    if (flags.help || !cmd || cmd === 'help') {
        printHelp();
        return;
    }

    if (cmd === 'doctor') {
        const report = await runDoctor(flags);
        if (flags.json) console.log(JSON.stringify(report, null, 2));
        else console.log(formatDoctor(report, flags));
        process.exitCode = report.exitCode;
        return;
    }

    if (cmd === 'context') {
        const report = analyzeContext(flags);
        if (flags.json) console.log(JSON.stringify(report, null, 2));
        else console.log(formatContext(report));
        return;
    }

    console.error(`Unknown command: ${cmd}\nRun "ctxpilot --help" for usage.`);
    process.exitCode = 1;
}

main().catch(err => {
    console.error(`[ERROR] ${err.message}`);
    process.exitCode = 1;
});
