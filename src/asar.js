'use strict';
// Dependency-free ASAR reader/writer. Preserves unpacked entries and recomputes
// SHA-256 block integrity metadata for replaced files.
const fs = require('fs');
const crypto = require('crypto');

const BLOCK_SIZE = 4 * 1024 * 1024;

function readArchive(file) {
    const buf = fs.readFileSync(file);
    const headerPickleSize = buf.readUInt32LE(4);
    const jsonLen = buf.readUInt32LE(12);
    const header = JSON.parse(buf.slice(16, 16 + jsonLen).toString('utf8'));
    return { buf, header, base: 8 + headerPickleSize };
}

function getNode(header, filePath) {
    let cur = header;
    for (const part of filePath.split('/')) {
        if (!cur.files || !cur.files[part]) throw new Error(`Entry not found in archive: ${filePath}`);
        cur = cur.files[part];
    }
    return cur;
}

function readEntry(archive, filePath) {
    const node = getNode(archive.header, filePath);
    if (node.unpacked) throw new Error(`Entry is unpacked: ${filePath}`);
    const off = archive.base + Number(node.offset);
    return archive.buf.slice(off, off + node.size);
}

function integrity(data) {
    const blocks = [];
    for (let i = 0; i < data.length; i += BLOCK_SIZE) {
        blocks.push(crypto.createHash('sha256').update(data.slice(i, i + BLOCK_SIZE)).digest('hex'));
    }
    if (blocks.length === 0) blocks.push(crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
    return {
        algorithm: 'SHA256',
        hash: crypto.createHash('sha256').update(data).digest('hex'),
        blockSize: BLOCK_SIZE,
        blocks,
    };
}

function writeArchive(archive, replacements, outFile) {
    const header = JSON.parse(JSON.stringify(archive.header));
    const chunks = [];
    let offset = 0;

    (function walk(node, prefix) {
        for (const [name, child] of Object.entries(node.files)) {
            const p = prefix ? `${prefix}/${name}` : name;
            if (child.files) { walk(child, p); continue; }
            if (child.unpacked || child.link) continue;
            let data;
            if (Object.prototype.hasOwnProperty.call(replacements, p)) {
                data = replacements[p];
                child.size = data.length;
                child.integrity = integrity(data);
            } else {
                const src = archive.base + Number(child.offset);
                data = archive.buf.slice(src, src + child.size);
            }
            child.offset = String(offset);
            offset += data.length;
            chunks.push(data);
        }
    })(header, '');

    const json = Buffer.from(JSON.stringify(header), 'utf8');
    const padded = Math.ceil(json.length / 4) * 4;
    const headerPickle = Buffer.alloc(8 + padded);
    headerPickle.writeUInt32LE(4 + padded, 0);
    headerPickle.writeUInt32LE(json.length, 4);
    json.copy(headerPickle, 8);
    const sizePickle = Buffer.alloc(8);
    sizePickle.writeUInt32LE(4, 0);
    sizePickle.writeUInt32LE(headerPickle.length, 4);

    fs.writeFileSync(outFile, Buffer.concat([sizePickle, headerPickle, ...chunks]));
}

module.exports = { readArchive, readEntry, writeArchive };
