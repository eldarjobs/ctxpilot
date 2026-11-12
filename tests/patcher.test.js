'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readArchive, readEntry } = require('../src/asar');
const { patchInstall, patchEnsure, patchStatus, patchRestore } = require('../src/patcher');
const { runDoctor } = require('../src/doctor');

function makeSyntheticAsar(outFile) {
    const files = {
        'package.json': Buffer.from(JSON.stringify({ name: 'antigravity', version: '2.99.0' }), 'utf8'),
        'dist/ipcHandlers.js': Buffer.from(
            '"use strict";\nconst electron_1 = require("electron");\nconst fsSync = require("fs");\nconst path = require("path");\nfunction registerIpcHandlers(storageManager) {\n}\nexports.registerIpcHandlers = registerIpcHandlers;\n',
            'utf8',
        ),
        'dist/preload.js': Buffer.from('"use strict";\nconst electron_1 = require("electron");\n', 'utf8'),
        'assets/keep.txt': Buffer.from('unchanged-payload', 'utf8'),
    };
    const header = { files: {} };
    const chunks = [];
    let offset = 0;
    for (const [rel, buf] of Object.entries(files)) {
        const parts = rel.split('/');
        let cur = header;
        for (let i = 0; i < parts.length - 1; i++) {
            cur.files[parts[i]] = cur.files[parts[i]] || { files: {} };
            cur = cur.files[parts[i]];
        }
        cur.files[parts[parts.length - 1]] = { size: buf.length, offset: String(offset) };
        offset += buf.length;
        chunks.push(buf);
    }
    const json = Buffer.from(JSON.stringify(header), 'utf8');
    const padded = Math.ceil(json.length / 4) * 4;
    const hp = Buffer.alloc(8 + padded);
    hp.writeUInt32LE(4 + padded, 0);
    hp.writeUInt32LE(json.length, 4);
    json.copy(hp, 8);
    const sp = Buffer.alloc(8);
    sp.writeUInt32LE(4, 0);
    sp.writeUInt32LE(hp.length, 4);
    fs.writeFileSync(outFile, Buffer.concat([sp, hp, ...chunks]));
}

describe('Overview Hub ASAR patcher', () => {
    it('supports --dry-run, patches cleanly, preserves untouched files, and restores backup', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxpilot-asar-'));
        try {
            const asarPath = path.join(tmp, 'app.asar');
            makeSyntheticAsar(asarPath);

            const dry = patchInstall({ resources: tmp, dryRun: true });
            assert.equal(dry.dryRun, true);
            assert.equal(patchStatus({ resources: tmp }).patched, false);

            const coreCacheDir = path.join(tmp, 'ctxpilot_core');
            const res = patchInstall({ resources: tmp, coreCacheDir });
            assert.equal(res.installed, true);
            assert.equal(res.version, '2.99.0');
            assert.equal(res.checked, 2); // package.json + assets/keep.txt

            // Verify all modules required by main-inject.js resolve cleanly from isolated coreCacheDir
            for (const mod of ['context.js', 'doctor.js', 'discovery.js', 'mcp-control.js', 'stack.js', 'handoff.js']) {
                const loaded = require(path.join(coreCacheDir, mod));
                assert.ok(loaded, `${mod} should load from coreCacheDir`);
            }

            const st = patchStatus({ resources: tmp });
            assert.equal(st.patched, true);
            assert.equal(st.upToDate, true);
            assert.equal(st.hasBackup, true);

            const patchedArc = readArchive(asarPath);
            assert.equal(readEntry(patchedArc, 'assets/keep.txt').toString(), 'unchanged-payload');
            assert.match(readEntry(patchedArc, 'dist/preload.js').toString(), /installCtxPilotOverviewHub/);

            patchRestore({ resources: tmp });
            assert.equal(patchStatus({ resources: tmp }).patched, false);

            // Doctor detects wiped patch when app.asar.bak exists, and patchEnsure restores it
            const doc = await runDoctor({ homeDir: tmp, workspaceDir: tmp, resources: tmp });
            assert.equal(doc.findings.some(f => f.category === 'patch' && f.level === 'WARN'), true);

            const ens1 = patchEnsure({ resources: tmp, coreCacheDir });
            assert.equal(ens1.installed, true);
            const ens2 = patchEnsure({ resources: tmp, coreCacheDir });
            assert.equal(ens2.alreadyUpToDate, true);

            // Verify registerIpcHandlers does not throw even if coreCacheDir is removed
            fs.rmSync(coreCacheDir, { recursive: true, force: true });
            const brokenIpc = readEntry(readArchive(asarPath), 'dist/ipcHandlers.js').toString('utf8');
            const mod = { exports: {} };
            const fn = new Function('require', 'exports', 'module', '__dirname', '__filename', brokenIpc);
            const origErr = console.error;
            console.error = () => {};
            try {
                fn(() => ({}), mod.exports, mod, tmp, path.join(tmp, 'ipcHandlers.js'));
                assert.doesNotThrow(() => mod.exports.registerIpcHandlers({}));
            } finally {
                console.error = origErr;
            }
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
