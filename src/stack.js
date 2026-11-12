'use strict';
const fs = require('fs');
const path = require('path');
const { getPaths, tryParseJson } = require('./discovery');

const STACK_TEMPLATES = {
    nextjs: {
        profile: 'code-docs',
        ruleTitle: 'Next.js & React Conventions',
        rules: [
            '- Prefer Server Components by default; add `"use client"` only for interactive state or browser APIs.',
            '- Validate API inputs at boundaries and keep secrets strictly in server-only environment variables.',
            '- Run typecheck/lint/build checks before declaring UI or route changes done.',
        ],
        prompts: [
            { label: 'Audit App Router', text: 'Inspect app/ routes, server/client boundaries, and data fetching patterns.' },
            { label: 'Check CWV & A11y', text: 'Audit rendered components for accessibility, hydration mismatches, and layout shifts.' },
        ],
    },
    dotnet: {
        profile: 'db-ro',
        ruleTitle: '.NET Clean Architecture Conventions',
        rules: [
            '- Keep domain entities free of infrastructure or EF Core dependencies.',
            '- Use parameterized queries/EF LINQ and respect READONLY database settings during inspection.',
            '- Run `dotnet build` and `dotnet test` after modifying services, endpoints, or migrations.',
        ],
        prompts: [
            { label: 'Trace Endpoint', text: 'Trace the endpoint from controller/Minimal API through handler, domain, and repository.' },
            { label: 'EF Migration Check', text: 'Review pending EF Core model changes and verify index/nullability safety.' },
        ],
    },
    node: {
        profile: 'code-docs',
        ruleTitle: 'Node.js Conventions',
        rules: [
            '- Keep modules single-purpose with explicit error handling and no swallowed exceptions.',
            '- Never hardcode tokens or credentials; reference `${ENV_VAR}` placeholders instead.',
            '- Run unit tests (`npm test`) after every behavioral change.',
        ],
        prompts: [
            { label: 'Check Error Paths', text: 'Audit async error handling, edge cases, and input validation in modified modules.' },
        ],
    },
    python: {
        profile: 'code-docs',
        ruleTitle: 'Python Conventions',
        rules: [
            '- Add type hints on public functions and keep I/O separated from pure business logic.',
            '- Never commit API keys or `.env` values; load configuration via environment variables.',
            '- Run `pytest` after modifying modules or schemas.',
        ],
        prompts: [
            { label: 'Type & Test Audit', text: 'Check type annotations, exception handling, and pytest coverage for recent changes.' },
        ],
    },
    generic: {
        profile: 'lean',
        ruleTitle: 'Workspace Conventions',
        rules: [
            '- Keep changes minimal, localized, and verified with tests or smoke checks.',
            '- Never store plaintext credentials in config or rule files.',
        ],
        prompts: [],
    },
};

function detectStack(workspaceDir) {
    const signals = [];
    let entries = [];
    try { entries = fs.readdirSync(workspaceDir); } catch { return { stack: 'generic', recommendedProfile: 'lean', signals }; }

    const pkg = tryParseJson(path.join(workspaceDir, 'package.json')).data;
    const deps = { ...(pkg && pkg.dependencies), ...(pkg && pkg.devDependencies) };

    if (entries.some(f => /^next\.config\./i.test(f)) || (deps && deps.next)) {
        signals.push('next.config / next dependency');
        return { stack: 'nextjs', recommendedProfile: 'code-docs', signals };
    }
    if (entries.some(f => /\.(sln|csproj)$/i.test(f) || f === 'Directory.Build.props' || f === 'global.json')) {
        signals.push('.sln/.csproj');
        return { stack: 'dotnet', recommendedProfile: 'db-ro', signals };
    }
    if (entries.includes('pyproject.toml') || entries.includes('requirements.txt') || entries.includes('pytest.ini')) {
        signals.push('pyproject/requirements');
        return { stack: 'python', recommendedProfile: 'code-docs', signals };
    }
    if (pkg) {
        signals.push('package.json');
        return { stack: 'node', recommendedProfile: 'code-docs', signals };
    }
    return { stack: 'generic', recommendedProfile: 'lean', signals };
}

function recommendProfile(workspaceDir, servers, hubCfg, profiles) {
    const detected = detectStack(workspaceDir);
    const hasDb = servers.some(s => /(mssql|postgres|postgresql|mysql|sqlite)/i.test(s.id));
    let targetProfile = (hubCfg && typeof hubCfg.profile === 'string' && profiles[hubCfg.profile])
        ? hubCfg.profile
        : (detected.stack === 'dotnet' && !hasDb ? 'code-docs' : detected.recommendedProfile);
    if (!profiles[targetProfile]) targetProfile = 'lean';

    const prof = profiles[targetProfile];
    let changesCount = 0;
    let savingsTok = 0;
    for (const s of servers) {
        if (!s.configurable) continue;
        const shouldKeep = prof.keep === '*' || (Array.isArray(prof.keep) && prof.keep.includes(s.id));
        if (shouldKeep && s.parked) changesCount++;
        else if (!shouldKeep && !s.parked) {
            changesCount++;
            savingsTok += s.tokensEst || 0;
        }
        if (shouldKeep && prof.forceReadonly && s.readonly === false) changesCount++;
    }

    return {
        stack: detected.stack,
        profile: targetProfile,
        source: hubCfg && hubCfg.profile ? 'hub.json' : 'auto-detect',
        autoApply: Boolean(hubCfg && hubCfg.autoProfile),
        changesCount,
        savingsTok,
    };
}

function buildHubConfig(workspaceDir) {
    const detected = detectStack(workspaceDir);
    const tpl = STACK_TEMPLATES[detected.stack] || STACK_TEMPLATES.generic;
    const pkg = tryParseJson(path.join(workspaceDir, 'package.json')).data;
    const actions = [];
    if (pkg && pkg.scripts) {
        for (const k of ['dev', 'build', 'test', 'lint', 'typecheck']) {
            if (pkg.scripts[k]) actions.push({ label: `npm ${k}`, command: `npm run ${k}`, primary: k === 'dev' || k === 'test' });
        }
    } else if (detected.stack === 'dotnet') {
        actions.push({ label: 'dotnet build', command: 'dotnet build', primary: false });
        actions.push({ label: 'dotnet test', command: 'dotnet test', primary: true });
    } else if (detected.stack === 'python') {
        actions.push({ label: 'pytest', command: 'pytest', primary: true });
    }
    return {
        profile: tpl.profile,
        autoProfile: false,
        actions,
        prompts: tpl.prompts,
    };
}

function writeScaffoldFile(filePath, content, opts) {
    const existed = fs.existsSync(filePath);
    if (existed && !opts.force) return { path: filePath, status: 'skipped', reason: 'already exists (use --force to overwrite)' };
    if (!opts.dryRun) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf8');
    }
    return { path: filePath, status: opts.dryRun ? 'would-write' : (existed ? 'overwritten' : 'created') };
}

function initHubConfig(opts = {}) {
    const paths = getPaths(opts);
    const hubPath = path.join(paths.workspaceDir, '.agents', 'hub.json');
    const cfg = buildHubConfig(paths.workspaceDir);
    const res = writeScaffoldFile(hubPath, JSON.stringify(cfg, null, 2) + '\n', opts);
    return { action: 'hub-init', workspace: paths.workspaceDir, dryRun: Boolean(opts.dryRun), files: [res], config: cfg };
}

function initWorkspace(stackArg, opts = {}) {
    const paths = getPaths(opts);
    const detected = detectStack(paths.workspaceDir);
    const stack = (!stackArg || stackArg === 'auto') ? detected.stack : stackArg;
    if (!STACK_TEMPLATES[stack]) {
        throw new Error(`Unknown stack "${stack}". Available: auto, ${Object.keys(STACK_TEMPLATES).join(', ')}`);
    }
    const tpl = STACK_TEMPLATES[stack];
    const rulePath = path.join(paths.workspaceDir, '.agents', 'rules', '01-stack-conventions.md');
    const ruleBody = [
        '---',
        `name: ${stack}-conventions`,
        `description: Lean ${stack} workspace conventions generated by ctxpilot.`,
        'trigger: always_on',
        '---',
        '',
        `# ${tpl.ruleTitle}`,
        '',
        ...tpl.rules,
        '',
    ].join('\n');

    const hubPath = path.join(paths.workspaceDir, '.agents', 'hub.json');
    const hubCfg = buildHubConfig(paths.workspaceDir);
    hubCfg.profile = tpl.profile;

    const files = [
        writeScaffoldFile(rulePath, ruleBody, opts),
        writeScaffoldFile(hubPath, JSON.stringify(hubCfg, null, 2) + '\n', opts),
    ];

    return {
        action: 'init',
        workspace: paths.workspaceDir,
        stack,
        detectedStack: detected.stack,
        recommendedProfile: tpl.profile,
        dryRun: Boolean(opts.dryRun),
        files,
    };
}

module.exports = {
    STACK_TEMPLATES,
    detectStack,
    recommendProfile,
    buildHubConfig,
    initHubConfig,
    initWorkspace,
};
