'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runDoctor } = require('../src/doctor');
const { analyzeContext } = require('../src/context');

describe('zero-telemetry & read-only guarantees', () => {
    it('performs zero network requests during doctor (without --ping) and context', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxpilot-net-'));
        const origFetch = global.fetch;
        let fetchCalls = 0;
        global.fetch = async () => { fetchCalls++; throw new Error('Network call forbidden'); };

        try {
            fs.mkdirSync(path.join(tmp, '.gemini', 'config'), { recursive: true });
            fs.writeFileSync(path.join(tmp, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({
                mcpServers: { remote: { url: 'https://mcp.example.com/mcp' } },
            }));
            await runDoctor({ homeDir: tmp, workspaceDir: tmp });
            analyzeContext({ homeDir: tmp, workspaceDir: tmp });
            assert.equal(fetchCalls, 0);
        } finally {
            global.fetch = origFetch;
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('source modules do not import telemetry or external HTTP clients', () => {
        for (const f of ['redact.js', 'discovery.js', 'transcript-adapter.js', 'doctor.js', 'context.js']) {
            const src = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
            assert.equal(/require\(['"](https?|axios|node-fetch|undici)['"]\)/.test(src), false, `unexpected HTTP dependency in ${f}`);
        }
    });
});
