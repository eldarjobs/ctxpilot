'use strict';
const { getPaths, discoverMcp, discoverRules, discoverSkills, RULES_AGGREGATE_TOKEN_BUDGET } = require('./discovery');
const { readLatestTranscript } = require('./transcript-adapter');

// Approximate char-to-token ratios (explicitly labeled ±20% since exact model tokenizers vary)
const CHARS_PER_TOKEN_PROSE = 4.0;
const CHARS_PER_TOKEN_JSON = 3.5;

function estTokensFromBytes(bytes, charsPerTok) {
    return Math.round((Number(bytes) || 0) / charsPerTok);
}

function analyzeContext(opts = {}) {
    const paths = getPaths(opts);
    const mcp = discoverMcp(paths);
    const rules = discoverRules(paths.workspaceDir);
    const skills = discoverSkills(paths);
    const transcript = readLatestTranscript(paths.brainDir, opts.conv);

    // 1. Rules breakdown
    const alwaysOnRules = rules.items.filter(r => r.trigger === 'always_on');
    const conditionalRules = rules.items.filter(r => r.trigger !== 'always_on');
    const alwaysOnBytes = alwaysOnRules.reduce((s, r) => s + r.bytes, 0);
    const conditionalBytes = conditionalRules.reduce((s, r) => s + r.bytes, 0);
    const alwaysOnTokensEst = estTokensFromBytes(alwaysOnBytes, CHARS_PER_TOKEN_PROSE);

    // 2. Active MCP tool schema breakdown (exclude parked/disabled servers)
    const activeServers = mcp.servers.filter(s => !s.parked && !s.disabledInConfig && mcp.toggles[s.id] !== false);
    const mcpBreakdown = activeServers.map(s => ({
        id: s.id,
        toolCount: s.tools.length,
        schemaBytes: s.schemaBytes,
        tokensEst: estTokensFromBytes(s.schemaBytes, CHARS_PER_TOKEN_JSON),
    })).sort((a, b) => b.tokensEst - a.tokensEst);

    const mcpTotalBytes = mcpBreakdown.reduce((s, m) => s + m.schemaBytes, 0);
    const mcpTotalTokensEst = mcpBreakdown.reduce((s, m) => s + m.tokensEst, 0);

    // 3. Skills progressive-disclosure metadata
    const skillsBytes = skills.reduce((s, sk) => s + sk.headerBytes, 0);
    const skillsTokensEst = estTokensFromBytes(skillsBytes, CHARS_PER_TOKEN_PROSE);

    // Total static prompt overhead (rules + MCP schemas + skills metadata)
    const staticOverheadTokensEst = alwaysOnTokensEst + mcpTotalTokensEst + skillsTokensEst;
    const mcpSharePct = staticOverheadTokensEst > 0 ? Math.round((mcpTotalTokensEst / staticOverheadTokensEst) * 100) : 0;

    // Recommendation: largest parkable MCP server with measurable schema size
    const largestMcp = mcpBreakdown.find(m => m.tokensEst > 0) || null;
    const recommendation = largestMcp
        ? `Parking "${largestMcp.id}" (${largestMcp.toolCount} tools) when unused saves ~${largestMcp.tokensEst.toLocaleString()} tok/turn (approx +/-20%).`
        : null;

    return {
        workspace: paths.workspaceDir,
        estimateNote: 'Byte-derived token counts are estimates (~4.0 chars/tok prose, ~3.5 chars/tok JSON, +/-20%).',
        rulesBudgetLimitTokens: RULES_AGGREGATE_TOKEN_BUDGET,
        rules: {
            alwaysOnCount: alwaysOnRules.length,
            conditionalCount: conditionalRules.length,
            alwaysOnBytes,
            conditionalBytes,
            alwaysOnTokensEst,
        },
        mcp: {
            activeServerCount: activeServers.length,
            totalBytes: mcpTotalBytes,
            totalTokensEst: mcpTotalTokensEst,
            shareOfStaticOverheadPct: mcpSharePct,
            servers: mcpBreakdown,
        },
        skills: {
            count: skills.length,
            metadataBytes: skillsBytes,
            tokensEst: skillsTokensEst,
        },
        staticOverheadTokensEst,
        transcript,
        recommendation,
    };
}

function formatContext(report) {
    const out = [];
    const tok = (n) => `~${n.toLocaleString()} tok`;
    out.push(`ctxpilot context (workspace: ${report.workspace})`);
    out.push('─'.repeat(66));
    out.push(`1. Always-On Rules (Antigravity defaultRulesBudget: ${report.rulesBudgetLimitTokens.toLocaleString()} tok)`);
    out.push(`   ${report.rules.alwaysOnCount} always-on file(s) (${(report.rules.alwaysOnBytes / 1024).toFixed(1)} KB)   ${tok(report.rules.alwaysOnTokensEst).padStart(12)}  (est +/-20%)`);
    if (report.rules.conditionalCount > 0) {
        out.push(`   ${report.rules.conditionalCount} conditional rule(s) (loaded on demand: ${(report.rules.conditionalBytes / 1024).toFixed(1)} KB)`);
    }

    out.push('');
    out.push('2. Active MCP Tool Schemas');
    if (report.mcp.servers.length === 0) {
        out.push('   No active MCP servers found.');
    } else {
        for (const s of report.mcp.servers) {
            const name = s.id.padEnd(22);
            const tools = `(${String(s.toolCount).padStart(2)} ${s.toolCount === 1 ? 'tool ' : 'tools'})`.padEnd(11);
            const kb = `${(s.schemaBytes / 1024).toFixed(1)} KB`.padStart(8);
            const est = s.schemaBytes > 0 ? `${tok(s.tokensEst).padStart(11)}  (est +/-20%)` : '   schemas not cached locally';
            out.push(`   ${name} ${tools} ${kb}  ${est}`);
        }
        out.push(`   MCP Subtotal: ${tok(report.mcp.totalTokensEst)} (${report.mcp.shareOfStaticOverheadPct}% of ${tok(report.staticOverheadTokensEst)} static overhead)`);
    }

    out.push('');
    out.push('3. Skills Metadata (progressive disclosure)');
    out.push(`   ${report.skills.count} skill(s) (${(report.skills.metadataBytes / 1024).toFixed(1)} KB)          ${tok(report.skills.tokensEst).padStart(12)}  (est +/-20%)`);

    out.push('');
    out.push('4. Latest Conversation (transcript adapter v1)');
    if (report.transcript.available) {
        out.push(`   Conversation: ${report.transcript.convId}`);
        out.push(`   Context used: ${report.transcript.totalContextTokens.toLocaleString()} tok (Cache hit: ${report.transcript.cacheHitPct}%)`);
        out.push(`   Last output:  ${report.transcript.outputTokens.toLocaleString()} tok`);
    } else {
        out.push(`   Unavailable (${report.transcript.reason})`);
    }

    out.push('─'.repeat(66));
    out.push('Note: Rules have a separate defaultRulesBudget (20k tok); Static Overhead sums Rules + MCP Schemas + Skills.');
    if (report.recommendation) {
        out.push(`Tip: ${report.recommendation}`);
    }
    return out.join('\n');
}

module.exports = { analyzeContext, formatContext, estTokensFromBytes };
