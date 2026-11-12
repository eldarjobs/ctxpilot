'use strict';
const fs = require('fs');
const path = require('path');
const { getPaths, tryParseJson } = require('./discovery');

const PLUGIN_ID = 'ctxpilot';
const SIDECAR_ID = 'ctxpilot_panel';

function validateSidecarManifest(manifest) {
    const errors = [];
    if (!manifest || typeof manifest !== 'object') errors.push('manifest must be an object');
    if (typeof manifest.command !== 'string' || !manifest.command) errors.push('missing command');
    if (!Array.isArray(manifest.args) || manifest.args.length === 0) errors.push('missing args');
    if (manifest.has_web_ui !== true) errors.push('has_web_ui must be true');
    const views = manifest.ui_config && manifest.ui_config.views;
    if (!Array.isArray(views) || !views.some(v => v && v.entrypoint === 'SIDECAR_UI_ENTRYPOINT_AUX_PANE' && typeof v.path === 'string')) {
        errors.push('ui_config.views must declare SIDECAR_UI_ENTRYPOINT_AUX_PANE');
    }
    return errors;
}

function getPluginPaths(opts = {}) {
    const { cfgDir } = getPaths(opts);
    const pluginDir = path.join(cfgDir, 'plugins', PLUGIN_ID);
    const sidecarDir = path.join(pluginDir, 'sidecars', SIDECAR_ID);
    return { pluginDir, sidecarDir };
}

function installSidecarPlugin(opts = {}) {
    const srcRoot = path.resolve(__dirname, '..');
    const srcPlugin = path.join(srcRoot, 'plugin');
    const srcCore = path.join(srcRoot, 'src');
    const manifest = tryParseJson(path.join(srcPlugin, 'sidecars', SIDECAR_ID, 'sidecar.json')).data;
    const errors = validateSidecarManifest(manifest);
    if (errors.length) throw new Error(`Invalid sidecar.json: ${errors.join('; ')}`);

    const { pluginDir, sidecarDir } = getPluginPaths(opts);
    const coreDir = path.join(sidecarDir, 'core');

    if (opts.dryRun) {
        return { action: 'install-plugin', dryRun: true, pluginDir, sidecarDir, sidecarUri: `sidecar://${PLUGIN_ID}/${SIDECAR_ID}` };
    }

    fs.mkdirSync(coreDir, { recursive: true });
    fs.copyFileSync(path.join(srcPlugin, 'plugin.json'), path.join(pluginDir, 'plugin.json'));
    for (const f of ['sidecar.json', 'server.mjs', 'index.html']) {
        fs.copyFileSync(path.join(srcPlugin, 'sidecars', SIDECAR_ID, f), path.join(sidecarDir, f));
    }
    for (const f of fs.readdirSync(srcCore)) {
        if (f.endsWith('.js')) fs.copyFileSync(path.join(srcCore, f), path.join(coreDir, f));
    }

    return {
        action: 'install-plugin',
        dryRun: false,
        pluginDir,
        sidecarDir,
        sidecarUri: `sidecar://${PLUGIN_ID}/${SIDECAR_ID}`,
        customizationUri: `customization://${PLUGIN_ID}`,
    };
}

function uninstallSidecarPlugin(opts = {}) {
    const { pluginDir } = getPluginPaths(opts);
    if (!fs.existsSync(pluginDir)) return { action: 'uninstall-plugin', existed: false, pluginDir };
    if (!opts.dryRun) fs.rmSync(pluginDir, { recursive: true, force: true });
    return { action: 'uninstall-plugin', existed: true, dryRun: Boolean(opts.dryRun), pluginDir };
}

function statusSidecarPlugin(opts = {}) {
    const { pluginDir, sidecarDir } = getPluginPaths(opts);
    const installed = fs.existsSync(path.join(pluginDir, 'plugin.json')) && fs.existsSync(path.join(sidecarDir, 'sidecar.json'));
    return {
        installed,
        pluginDir,
        sidecarDir,
        sidecarUri: `sidecar://${PLUGIN_ID}/${SIDECAR_ID}`,
    };
}

module.exports = {
    PLUGIN_ID,
    SIDECAR_ID,
    validateSidecarManifest,
    installSidecarPlugin,
    uninstallSidecarPlugin,
    statusSidecarPlugin,
};
