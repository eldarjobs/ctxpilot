'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateSidecarManifest, installSidecarPlugin, uninstallSidecarPlugin, statusSidecarPlugin } = require('../src/plugin-installer');

describe('Official Sidecar UI Plugin installer & schema validation', () => {
    it('validates sidecar.json manifest schema cleanly', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin', 'sidecars', 'ctxpilot_panel', 'sidecar.json'), 'utf8'));
        assert.deepEqual(validateSidecarManifest(manifest), []);
        assert.equal(validateSidecarManifest({}).length > 0, true);
    });

    it('installs self-contained plugin and uninstalls cleanly', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxpilot-plg-'));
        try {
            assert.equal(statusSidecarPlugin({ homeDir: tmp }).installed, false);
            const res = installSidecarPlugin({ homeDir: tmp });
            assert.equal(res.sidecarUri, 'sidecar://ctxpilot/ctxpilot_panel');
            assert.equal(statusSidecarPlugin({ homeDir: tmp }).installed, true);
            assert.equal(fs.existsSync(path.join(res.sidecarDir, 'core', 'doctor.js')), true);

            const rm = uninstallSidecarPlugin({ homeDir: tmp });
            assert.equal(rm.existed, true);
            assert.equal(statusSidecarPlugin({ homeDir: tmp }).installed, false);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
