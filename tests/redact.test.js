'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { classifySecret, scanServerSecrets, isEnvReference } = require('../src/redact');

describe('secret detection & prefix-free redaction', () => {
    it('accepts ${ENV_VAR} references cleanly', () => {
        assert.equal(isEnvReference('${MY_TOKEN}'), true);
        assert.equal(isEnvReference('Bearer ${CONTEXT7_API_KEY}'), true);
        assert.equal(classifySecret('Authorization', 'Bearer ${CONTEXT7_API_KEY}'), null);
        assert.equal(classifySecret('DB_PASSWORD', '${DB_PASS}'), null);
    });

    it('detects plaintext tokens and never leaks any prefix or suffix', () => {
        const fakeSecret = 'ctx7sk-demo998877665544332211';
        const findings = scanServerSecrets('docs-mcp', {
            headers: { Authorization: `Bearer ${fakeSecret}` },
            env: { DB_PASSWORD: 'super-secret-value' },
        });
        assert.equal(findings.length, 2);

        const serialized = JSON.stringify(findings);
        assert.equal(serialized.includes('ctx7sk'), false, 'must never leak token prefix');
        assert.equal(serialized.includes('demo9988'), false, 'must never leak token body');
        assert.equal(serialized.includes('super-secret'), false, 'must never leak password');
        assert.equal(findings[0].redacted, '[REDACTED: bearer-token]');
        assert.equal(findings[1].redacted, '[REDACTED: password]');
        assert.equal(findings[0].suggestion.snippet, '"Authorization": "Bearer ${DOCS_MCP_API_KEY}"');
        assert.equal(findings[1].suggestion.snippet, '"DB_PASSWORD": "${DOCS_MCP_DB_PASSWORD}"');
    });

    it('ignores safe non-secret flags on sensitive-looking keys', () => {
        assert.equal(classifySecret('AUTH_MODE', 'windows'), null);
        assert.equal(classifySecret('USE_TOKEN', 'false'), null);
    });
});
