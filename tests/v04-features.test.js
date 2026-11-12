'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixSecrets } = require('../src/secret-fix');
const { runDoctor } = require('../src/doctor');
const { detectStack, recommendProfile, initWorkspace, initHubConfig } = require('../src/stack');
const { runBench } = require('../src/bench');
const { exportBundle, importBundle } = require('../src/bundle');
const { BUILTIN_PROFILES } = require('../src/mcp-control');

let tmp;
let home;
let ws;

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxpilot-v04-'));
    home = path.join(tmp, 'home');
    ws = path.join(tmp, 'workspace');
    fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.agents', 'rules'), { recursive: true });
});

afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('v0.4.0 Secret Auto-Fix', () => {
    it('moves plaintext secrets to .env + envWriter, backs up config, and never leaks secrets', async () => {
        const cfgPath = path.join(home, '.gemini', 'config', 'mcp_config.json');
        const secret = 'sk-proj-superSecretTokenValue99999';
        fs.writeFileSync(cfgPath, JSON.stringify({
            mcpServers: {
                context7: { url: 'https://mcp.context7.com/mcp', headers: { Authorization: `Bearer ${secret}` } },
            },
        }));

        const dry = fixSecrets({ homeDir: home, workspaceDir: ws, dryRun: true, skipOsEnv: true });
        assert.equal(dry.dryRun, true);
        assert.equal(dry.fixedCount, 1);
        assert.equal(JSON.stringify(dry).includes(secret), false);
        assert.equal(fs.readFileSync(cfgPath, 'utf8').includes(secret), true);

        const writtenEnv = [];
        const res = fixSecrets({
            homeDir: home,
            workspaceDir: ws,
            envWriter: (k, v) => writtenEnv.push([k, v]),
        });
        assert.equal(res.fixedCount, 1);
        assert.equal(fs.existsSync(`${cfgPath}.bak`), true);
        assert.equal(writtenEnv.length, 1);
        assert.equal(writtenEnv[0][0], 'CONTEXT7_API_KEY');
        assert.equal(writtenEnv[0][1], secret);

        const updated = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        assert.equal(updated.mcpServers.context7.headers.Authorization, 'Bearer ${CONTEXT7_API_KEY}');
        assert.equal(fs.readFileSync(res.dotEnvPath, 'utf8').includes(`CONTEXT7_API_KEY=${secret}`), true);

        const doc = await runDoctor({ homeDir: home, workspaceDir: ws });
        assert.equal(doc.summary.fail, 0);
    });
});

describe('v0.4.0 Stack Detection, Init & Auto-Profile', () => {
    it('detects Next.js, scaffolds rules + hub.json, and recommends profile', () => {
        fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({
            name: 'web-app',
            dependencies: { next: '15.0.0' },
            scripts: { dev: 'next dev', test: 'node --test' },
        }));

        const det = detectStack(ws);
        assert.equal(det.stack, 'nextjs');

        const dry = initWorkspace('auto', { homeDir: home, workspaceDir: ws, dryRun: true });
        assert.equal(dry.stack, 'nextjs');
        assert.equal(fs.existsSync(path.join(ws, '.agents', 'hub.json')), false);

        const created = initWorkspace('auto', { homeDir: home, workspaceDir: ws });
        assert.equal(created.recommendedProfile, 'code-docs');
        assert.equal(fs.existsSync(path.join(ws, '.agents', 'rules', '01-stack-conventions.md')), true);
        assert.equal(fs.existsSync(path.join(ws, '.agents', 'hub.json')), true);

        const hubRes = initHubConfig({ homeDir: home, workspaceDir: ws });
        assert.equal(hubRes.files[0].status, 'skipped');

        const rec = recommendProfile(ws, [
            { id: 'serena', parked: false, configurable: true, tokensEst: 1000, readonly: null },
            { id: 'mssql', parked: false, configurable: true, tokensEst: 4500, readonly: true },
        ], { profile: 'code-docs' }, BUILTIN_PROFILES);
        assert.equal(rec.profile, 'code-docs');
        assert.equal(rec.changesCount, 1);
        assert.equal(rec.savingsTok, 4500);
    });
});

describe('v0.4.0 Rules & Hooks Profiler (ctx bench)', () => {
    it('detects duplicate rule lines and benchmarks enabled hooks safely', () => {
        const dupLine = '- Always run unit tests and check lint output before committing changes.';
        fs.writeFileSync(path.join(ws, '.agents', 'rules', 'a.md'), `---\ntrigger: always_on\n---\n${dupLine}\n`);
        fs.writeFileSync(path.join(ws, '.agents', 'rules', 'b.md'), `---\ntrigger: always_on\n---\n${dupLine}\n`);
        fs.writeFileSync(path.join(ws, '.agents', 'hooks.json'), JSON.stringify({
            fastCheck: { PreToolUse: [{ hooks: [{ command: `"${process.execPath}" -e "process.exit(0)"` }] }] },
            failCheck: { PostToolUse: [{ hooks: [{ command: `"${process.execPath}" -e "process.exit(1)"` }] }] },
        }));

        const staticBench = runBench({ homeDir: home, workspaceDir: ws });
        assert.equal(staticBench.rules.duplicates.length, 1);
        assert.equal(staticBench.hooks.every(h => !h.executed && h.status === 'STATIC'), true);

        const liveBench = runBench({ homeDir: home, workspaceDir: ws, runHooks: true });
        assert.equal(liveBench.hooks.find(h => h.name === 'fastCheck').status, 'OK');
        assert.equal(liveBench.hooks.find(h => h.name === 'failCheck').status, 'FAIL');
    });
});

describe('v0.4.0 Sanitized Team Bundle', () => {
    it('sanitizes secrets on export, blocks strict export, and imports cleanly into another workspace', () => {
        const secret = 'ghp_1234567890abcdef1234567890abcdef1234';
        fs.writeFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({
            mcpServers: {
                github: { url: 'https://api.githubcopilot.com/mcp', headers: { Authorization: `Bearer ${secret}` } },
            },
        }));
        fs.writeFileSync(path.join(ws, '.agents', 'rules', '01-team.md'), '---\ntrigger: always_on\n---\nTeam rule.\n');
        fs.writeFileSync(path.join(ws, '.agents', 'hub.json'), JSON.stringify({ profile: 'code-docs' }));

        assert.throws(() => exportBundle({ homeDir: home, workspaceDir: ws, strict: true }), /Plaintext secret/);

        const bundlePath = path.join(tmp, 'team-bundle.json');
        const exp = exportBundle({ homeDir: home, workspaceDir: ws, out: bundlePath });
        assert.equal(exp.sanitizedSecrets, 1);
        assert.equal(exp.ruleCount, 1);
        assert.equal(fs.readFileSync(bundlePath, 'utf8').includes(secret), false);

        const targetHome = path.join(tmp, 'home2');
        const targetWs = path.join(tmp, 'ws2');
        fs.mkdirSync(targetHome, { recursive: true });
        fs.mkdirSync(targetWs, { recursive: true });

        const imp = importBundle(bundlePath, { homeDir: targetHome, workspaceDir: targetWs });
        assert.equal(imp.mcpResults[0].status, 'added');
        assert.equal(fs.existsSync(path.join(targetWs, '.agents', 'rules', '01-team.md')), true);
        assert.equal(fs.existsSync(path.join(targetWs, '.agents', 'rules', '00-active-mcps.md')), true);

        const impSkip = importBundle(bundlePath, { homeDir: targetHome, workspaceDir: targetWs });
        assert.equal(impSkip.mcpResults[0].status, 'skipped');
    });
});
