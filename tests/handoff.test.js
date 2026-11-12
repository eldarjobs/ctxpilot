'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('os');
const path = require('path');
const { buildHandoff, buildSubChat, listFixes, addFix, removeFix, getChatSignals, buildSubChatResult } = require('../src/handoff');

describe('Handoff, Sub-Chat & Saved Fixes', () => {
    let tmp, home, ws, convDir;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxpilot-handoff-'));
        home = path.join(tmp, 'home');
        ws = path.join(tmp, 'repo');
        convDir = path.join(home, '.gemini', 'antigravity', 'brain', 'abc12345-conv', '.system_generated', 'logs');
        fs.mkdirSync(convDir, { recursive: true });
        fs.mkdirSync(ws, { recursive: true });

        const lines = [
            JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>\nFix ctxpilot startup crash\n</USER_REQUEST>' }),
            JSON.stringify({ type: 'USER_INPUT', content: '/compact' }),
            JSON.stringify({
                type: 'PLANNER_RESPONSE',
                input_tokens: 12000,
                cache_read_tokens: 82000,
                output_tokens: 450,
                content: 'Root cause was missing ./patcher in ctxpilot_core.',
                tool_calls: [
                    { name: 'edit_file', args: { Path: JSON.stringify(path.join(ws, 'src', 'patcher', 'index.js')) } },
                    { name: 'run_command', args: { toolSummary: 'Run test suite' } },
                ],
            }),
        ];
        fs.writeFileSync(path.join(convDir, 'transcript.jsonl'), lines.join('\n') + '\n', 'utf8');
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('builds a lean handoff excluding /compact noise and including saved fixes', () => {
        const dry = addFix('syncCoreCache copies patcher/', 'Prevents MODULE_NOT_FOUND', { homeDir: home, workspaceDir: ws, dryRun: true });
        assert.equal(dry.dryRun, true);
        assert.equal(listFixes({ homeDir: home, workspaceDir: ws }).length, 0);

        const saved = addFix('syncCoreCache copies patcher/', 'Prevents MODULE_NOT_FOUND', { homeDir: home, workspaceDir: ws, convId: 'abc12345' });
        assert.equal(listFixes({ homeDir: home, workspaceDir: ws }).length, 1);

        const handoff = buildHandoff({ homeDir: home, workspaceDir: ws });
        assert.equal(handoff.convId, 'abc12345-conv');
        assert.equal(handoff.sourceTokens, 94000);
        assert.equal(handoff.handoffTokensEst < 500, true);
        assert.match(handoff.markdown, /Fix ctxpilot startup crash/);
        assert.doesNotMatch(handoff.markdown, /\n- \/compact\n/);
        assert.match(handoff.markdown, /src\/patcher\/index\.js/);
        assert.match(handoff.markdown, /Run test suite/);
        assert.match(handoff.markdown, /syncCoreCache copies patcher\//);

        const rm = removeFix(saved.entry.id, { homeDir: home, workspaceDir: ws });
        assert.equal(rm.removed, 1);
        assert.equal(listFixes({ homeDir: home, workspaceDir: ws }).length, 0);
    });

    it('builds an isolated sub-chat prompt scoped to topic and touched files', () => {
        const sub = buildSubChat({ homeDir: home, workspaceDir: ws, topic: 'Investigate ASAR lock on Windows' });
        assert.equal(sub.convId, 'abc12345-conv');
        assert.match(sub.markdown, /Isolated Sub-Chat \(branched from abc12345\)/);
        assert.match(sub.markdown, /Investigate ASAR lock on Windows/);
        assert.match(sub.markdown, /src\/patcher\/index\.js/);
        assert.match(sub.markdown, /3-bullet summary/);

        const sig = getChatSignals({ homeDir: home, workspaceDir: ws });
        assert.match(sig.fixHint, /missing \.\/patcher/);

        // Simulate being inside an active Sub-Chat branched from abc12345
        const subConv = path.join(home, '.gemini', 'antigravity', 'brain', 'sub99999-conv', '.system_generated', 'logs');
        fs.mkdirSync(subConv, { recursive: true });
        fs.writeFileSync(path.join(subConv, 'transcript.jsonl'), [
            JSON.stringify({ type: 'USER_INPUT', content: sub.markdown }),
            JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Found an unrelated lint warning; want me to fix it in a sub-session? Fixed lock handling cleanly.' }),
        ].join('\n') + '\n');

        const subSig = getChatSignals({ homeDir: home, workspaceDir: ws, conv: 'sub99999-conv' });
        assert.equal(subSig.isSubChat, true);
        assert.equal(subSig.parentConvId, 'abc12345');
        assert.match(subSig.subChatOffer, /unrelated/i);

        const res = buildSubChatResult({ homeDir: home, workspaceDir: ws, conv: 'sub99999-conv' });
        assert.equal(res.parentConvId, 'abc12345');
        assert.match(res.summary, /\[Sub-Chat sub99999 result\]/);
    });
});
