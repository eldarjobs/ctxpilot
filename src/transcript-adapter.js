'use strict';
const fs = require('fs');
const path = require('path');

const TAIL_BYTES = 512 * 1024;

/**
 * Versioned adapter for Antigravity's undocumented transcript.jsonl format.
 * Never throws; returns { available: false, reason } when absent or unrecognized.
 */
function parseTranscriptV1(rawText, convId) {
    if (typeof rawText !== 'string' || !rawText.trim()) {
        return { adapterVersion: 'v1', available: false, reason: 'empty transcript' };
    }
    const lines = rawText.split(/\r?\n/).filter(Boolean);
    let lastPlanner = null;
    let steps = 0;

    for (const line of lines) {
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (!obj || typeof obj !== 'object') continue;
        if (obj.type === 'PLANNER_RESPONSE') {
            steps++;
            if (typeof obj.input_tokens === 'number' || typeof obj.cache_read_tokens === 'number') {
                lastPlanner = obj;
            }
        }
    }

    if (!lastPlanner) {
        return { adapterVersion: 'v1', available: false, reason: 'no PLANNER_RESPONSE token telemetry found' };
    }

    const inputTokens = Number(lastPlanner.input_tokens) || 0;
    const cacheReadTokens = Number(lastPlanner.cache_read_tokens) || 0;
    const outputTokens = Number(lastPlanner.output_tokens) || 0;
    const totalContextTokens = inputTokens + cacheReadTokens;
    const cacheHitPct = totalContextTokens > 0 ? Math.round((cacheReadTokens / totalContextTokens) * 1000) / 10 : 0;

    return {
        adapterVersion: 'v1',
        available: true,
        convId: convId || null,
        inputTokens,
        cacheReadTokens,
        outputTokens,
        totalContextTokens,
        cacheHitPct,
        stepsInTail: steps,
    };
}

function readLatestTranscript(brainDir, requestedConvId) {
    try {
        if (!brainDir || !fs.existsSync(brainDir)) {
            return { adapterVersion: 'v1', available: false, reason: 'brain directory not found' };
        }

        let targetId = null;
        let targetFile = null;

        if (requestedConvId) {
            const safeId = path.basename(String(requestedConvId));
            const candidate = path.join(brainDir, safeId, '.system_generated', 'logs', 'transcript.jsonl');
            if (fs.existsSync(candidate)) {
                targetId = safeId;
                targetFile = candidate;
            } else {
                return { adapterVersion: 'v1', available: false, reason: `conversation "${safeId}" transcript not found` };
            }
        } else {
            let latestMtime = 0;
            for (const ent of fs.readdirSync(brainDir, { withFileTypes: true })) {
                if (!ent.isDirectory()) continue;
                const candidate = path.join(brainDir, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
                try {
                    const st = fs.statSync(candidate);
                    if (st.mtimeMs > latestMtime && st.size > 0) {
                        latestMtime = st.mtimeMs;
                        targetId = ent.name;
                        targetFile = candidate;
                    }
                } catch {}
            }
        }

        if (!targetFile) {
            return { adapterVersion: 'v1', available: false, reason: 'no transcript files found' };
        }

        const st = fs.statSync(targetFile);
        const size = Math.min(st.size, TAIL_BYTES);
        const fd = fs.openSync(targetFile, 'r');
        const buf = Buffer.alloc(size);
        fs.readSync(fd, buf, 0, size, st.size - size);
        fs.closeSync(fd);

        return parseTranscriptV1(buf.toString('utf8'), targetId);
    } catch (e) {
        return { adapterVersion: 'v1', available: false, reason: `adapter error: ${e.message}` };
    }
}

module.exports = { parseTranscriptV1, readLatestTranscript };
