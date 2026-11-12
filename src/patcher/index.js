'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { readArchive, readEntry, writeArchive } = require('../asar');
const { findResourcesDir } = require('../paths');

const MARKER = 'CTXPILOT_OVERVIEW_HUB';

function getHashes() {
    const mainInject = fs.readFileSync(path.join(__dirname, 'main-inject.js'), 'utf8');
    const preloadInject = fs.readFileSync(path.join(__dirname, 'preload-inject.js'), 'utf8');
    const buildHash = crypto.createHash('sha256').update(mainInject).update(preloadInject).digest('hex').slice(0, 12);
    return { mainInject, preloadInject, buildHash, buildTag: `// ${MARKER}_BUILD:${buildHash}` };
}

function isPatchedBuffer(preloadText) {
    return preloadText.includes(MARKER) || preloadText.includes('AG_EXTENSION_HUB') || preloadText.includes('installAntigravityExtensionHub');
}

function patchStatus(opts = {}) {
    const resDir = findResourcesDir(opts.resources);
    const { buildHash, buildTag } = getHashes();
    if (!resDir) return { found: false, sourceBuild: buildHash };
    const installed = path.join(resDir, 'app.asar');
    const backup = path.join(resDir, 'app.asar.bak');
    const archive = readArchive(installed);
    const pkg = JSON.parse(readEntry(archive, 'package.json').toString('utf8'));
    const preload = readEntry(archive, 'dist/preload.js').toString('utf8');
    const match = preload.match(/CTXPILOT_OVERVIEW_HUB_BUILD:([a-f0-9]+)/);
    return {
        found: true,
        resDir,
        version: pkg.version,
        patched: isPatchedBuffer(preload),
        installedBuild: match ? match[1] : null,
        sourceBuild: buildHash,
        upToDate: preload.includes(buildTag),
        hasBackup: fs.existsSync(backup),
    };
}

function verifyArchive(patchedFile, cleanBackupFile) {
    const a = readArchive(patchedFile);
    const o = readArchive(cleanBackupFile);
    new Function('require', 'exports', 'module', '__dirname', '__filename', readEntry(a, 'dist/ipcHandlers.js').toString('utf8'));
    new Function('require', 'exports', 'module', readEntry(a, 'dist/preload.js').toString('utf8'));
    let checked = 0, mismatched = 0;
    (function walk(n, p) {
        for (const [k, v] of Object.entries(n.files)) {
            const q = p ? `${p}/${k}` : k;
            if (v.files) { walk(v, q); continue; }
            if (v.unpacked || v.link || q === 'dist/ipcHandlers.js' || q === 'dist/preload.js') continue;
            checked++;
            if (!readEntry(a, q).equals(readEntry(o, q))) mismatched++;
        }
    })(o.header, '');
    if (mismatched > 0) throw new Error(`Integrity check failed: ${mismatched} untouched file(s) mismatched`);
    return { version: JSON.parse(readEntry(a, 'package.json').toString('utf8')).version, checked, mismatched };
}

function scheduleWindowsSwapAndRelaunch(srcFile, dstFile, resDir) {
    const exe = path.resolve(resDir, '..', 'Antigravity.exe');
    const bat = path.join(os.tmpdir(), `ctxpilot-swap-${process.pid}.bat`);
    const script = [
        '@echo off',
        'timeout /t 2 /nobreak >nul',
        'taskkill /F /IM Antigravity.exe >nul 2>&1',
        'timeout /t 2 /nobreak >nul',
        `copy /y "${srcFile}" "${dstFile}" >nul`,
        fs.existsSync(exe) ? `start "" "${exe}"` : '',
        `del "%~f0" >nul 2>&1`,
    ].filter(Boolean).join('\r\n');
    fs.writeFileSync(bat, script, 'utf8');
    spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function syncCoreCache(coreCacheDir) {
    const srcRoot = path.join(__dirname, '..');
    fs.mkdirSync(coreCacheDir, { recursive: true });
    for (const ent of fs.readdirSync(srcRoot, { withFileTypes: true })) {
        if (ent.isFile() && ent.name.endsWith('.js')) {
            fs.copyFileSync(path.join(srcRoot, ent.name), path.join(coreCacheDir, ent.name));
        }
    }
    const patcherDst = path.join(coreCacheDir, 'patcher');
    fs.mkdirSync(patcherDst, { recursive: true });
    for (const ent of fs.readdirSync(__dirname, { withFileTypes: true })) {
        if (ent.isFile() && ent.name.endsWith('.js')) {
            fs.copyFileSync(path.join(__dirname, ent.name), path.join(patcherDst, ent.name));
        }
    }
}

function patchInstall(opts = {}) {
    const resDir = findResourcesDir(opts.resources);
    if (!resDir) throw new Error('Antigravity resources directory not found. Pass --resources <dir>.');
    const installed = path.join(resDir, 'app.asar');
    const backup = path.join(resDir, 'app.asar.bak');
    const { mainInject, preloadInject, buildHash, buildTag } = getHashes();

    const preloadOf = (f) => readEntry(readArchive(f), 'dist/preload.js').toString('utf8');
    let source;
    if (!isPatchedBuffer(preloadOf(installed))) {
        if (!opts.dryRun) fs.copyFileSync(installed, backup);
        source = installed;
    } else if (fs.existsSync(backup) && !isPatchedBuffer(preloadOf(backup))) {
        source = backup;
    } else {
        throw new Error('No clean original app.asar.bak available. Reinstall Antigravity first.');
    }

    const archive = readArchive(source);
    const pkg = JSON.parse(readEntry(archive, 'package.json').toString('utf8'));
    let ipc = readEntry(archive, 'dist/ipcHandlers.js').toString('utf8');
    let preload = readEntry(archive, 'dist/preload.js').toString('utf8');

    const anchor = /function registerIpcHandlers\(storageManager\) \{\r?\n/;
    if (!anchor.test(ipc)) throw new Error(`Injection anchor not found in dist/ipcHandlers.js (${pkg.version}).`);
    for (const sym of ['electron_1', 'fsSync', 'path']) {
        if (!new RegExp(`const ${sym} = `).test(ipc)) throw new Error(`Expected symbol "${sym}" missing in ipcHandlers.js.`);
    }
    if (!preload.includes('electron_1')) throw new Error('electron_1 missing in preload.js.');

    if (opts.dryRun) {
        return { action: 'patch-install', dryRun: true, version: pkg.version, buildHash, resDir };
    }

    const coreCacheDir = opts.coreCacheDir || path.join(os.homedir(), '.gemini', 'config', 'ctxpilot_core');
    syncCoreCache(coreCacheDir);
    const corePathJson = JSON.stringify(coreCacheDir);
    const injectedMain = mainInject.replace('__CTXPILOT_ROOT__', corePathJson);
    ipc = ipc.replace(anchor, (m) => m + injectedMain + '\n');
    preload = preload + '\n' + buildTag + '\n' + preloadInject;

    const staged = path.join(os.tmpdir(), `ctxpilot-app-${buildHash}.asar`);
    writeArchive(archive, {
        'dist/ipcHandlers.js': Buffer.from(ipc, 'utf8'),
        'dist/preload.js': Buffer.from(preload, 'utf8'),
    }, staged);

    const verified = verifyArchive(staged, fs.existsSync(backup) ? backup : installed);

    try {
        if (opts.restart && process.platform === 'win32') {
            scheduleWindowsSwapAndRelaunch(staged, installed, resDir);
            return { action: 'patch-install', scheduledRestart: true, version: verified.version, buildHash, checked: verified.checked };
        }
        fs.copyFileSync(staged, installed);
        return { action: 'patch-install', installed: true, version: verified.version, buildHash, checked: verified.checked };
    } catch (e) {
        if ((e.code === 'EBUSY' || e.code === 'EPERM') && process.platform === 'win32') {
            throw new Error(`app.asar is locked by running Antigravity. Re-run with --restart to apply and relaunch.`);
        }
        throw e;
    }
}

function patchRestore(opts = {}) {
    const resDir = findResourcesDir(opts.resources);
    if (!resDir) throw new Error('Antigravity resources directory not found.');
    const installed = path.join(resDir, 'app.asar');
    const backup = path.join(resDir, 'app.asar.bak');
    if (!fs.existsSync(backup)) throw new Error(`Backup not found at ${backup}`);
    if (opts.dryRun) return { action: 'patch-restore', dryRun: true, installed, backup };

    try {
        if (opts.restart && process.platform === 'win32') {
            scheduleWindowsSwapAndRelaunch(backup, installed, resDir);
            return { action: 'patch-restore', scheduledRestart: true, installed };
        }
        fs.copyFileSync(backup, installed);
        return { action: 'patch-restore', restored: true, installed };
    } catch (e) {
        if ((e.code === 'EBUSY' || e.code === 'EPERM') && process.platform === 'win32') {
            throw new Error(`app.asar is locked by running Antigravity. Re-run with --restart to restore and relaunch.`);
        }
        throw e;
    }
}

function patchEnsure(opts = {}) {
    const st = patchStatus(opts);
    if (!st.found) throw new Error('Antigravity resources directory not found. Pass --resources <dir>.');
    if (st.patched && st.upToDate) {
        return { action: 'patch-ensure', alreadyUpToDate: true, version: st.version, buildHash: st.sourceBuild };
    }
    return { ...patchInstall(opts), action: 'patch-ensure', previouslyPatched: st.patched };
}

module.exports = { patchStatus, patchInstall, patchEnsure, patchRestore, verifyArchive, syncCoreCache };
