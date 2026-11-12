'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function findResourcesDir(explicit) {
    if (explicit) {
        return fs.existsSync(path.join(explicit, 'app.asar')) ? explicit : null;
    }
    const home = os.homedir();
    const candidates = [
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'resources'),
        path.join(process.env.ProgramFiles || '', 'Antigravity', 'resources'),
        '/Applications/Antigravity.app/Contents/Resources',
        path.join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources'),
        '/opt/Antigravity/resources',
        '/usr/lib/antigravity/resources',
        '/usr/share/antigravity/resources',
        path.join(home, '.local', 'share', 'antigravity', 'resources'),
    ];
    return candidates.find(d => d && fs.existsSync(path.join(d, 'app.asar'))) || null;
}

module.exports = { findResourcesDir };
