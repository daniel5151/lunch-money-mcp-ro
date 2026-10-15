import { spawn } from 'node:child_process';
import pkceChallenge from 'pkce-challenge';
import assert from 'node:assert';

const PORT = 3456;
const BASE_URL = `http://localhost:${PORT}`;
const CLIENT_ID = 'gemini-test-client';
const CLIENT_SECRET = 'gemini-test-secret-xyz';
const JWT_SECRET = 'test-jwt-secret-key-at-least-32-chars-long!';
const REDIRECT_URI = 'https://oauth-redirect.googleusercontent.com/r/gemini-test';

console.log('--- Starting HTTP & OAuth Integration Test (Client-Secret-Only Flow) ---');

// Spawn server process
const serverProcess = spawn(process.execPath, ['lunch-money-mcp-ro.js', '--http'], {
    env: {
        ...process.env,
        MCP_PORT: String(PORT),
        MCP_HOST: '127.0.0.1',
        MCP_BASE_URL: BASE_URL,
        MCP_OAUTH_CLIENT_ID: CLIENT_ID,
        MCP_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
        MCP_JWT_SECRET: JWT_SECRET,
        // Mock token for testing if LUNCHMONEY_API_KEY is not set
        LUNCHMONEY_API_KEY: process.env.LUNCHMONEY_API_KEY || 'mock-api-key-for-test'
    },
    stdio: ['ignore', 'inherit', 'pipe']
});

let serverErrorOutput = '';
serverProcess.stderr.on('data', (chunk) => {
    const str = chunk.toString();
    serverErrorOutput += str;
    process.stderr.write(str);
});

// Wait for server to be ready
async function waitForServer(retries = 20) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(`${BASE_URL}/health`);
            if (res.ok) return;
        } catch {}
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Server failed to start on port ${PORT}.\n${serverErrorOutput}`);
}

async function runTests() {
    try {
        await waitForServer();
        console.log('\n[PASS] Server is listening and healthy.\n');

        // Test 1: OAuth Protected Resource Metadata (RFC 9728)
        console.log('[Test 1] Checking RFC 9728 Protected Resource Metadata...');
        const prmRes = await fetch(`${BASE_URL}/.well-known/oauth-protected-resource`);
        assert.strictEqual(prmRes.status, 200, 'Protected resource metadata should return 200');
        const prm = await prmRes.json();
        assert.ok(prm.authorization_servers.some(s => s === BASE_URL || s === `${BASE_URL}/`), 'Should include authorization server');
        console.log('[PASS] Protected Resource Metadata verified.');

        // Test 2: OAuth Authorization Server Metadata (RFC 8414)
        console.log('[Test 2] Checking RFC 8414 Authorization Server Metadata...');
        const asRes = await fetch(`${BASE_URL}/.well-known/oauth-authorization-server`);
        assert.strictEqual(asRes.status, 200, 'Authorization server metadata should return 200');
        const asMeta = await asRes.json();
        assert.strictEqual(asMeta.issuer, `${BASE_URL}/`);
        assert.ok(asMeta.authorization_endpoint.includes('/authorize'), 'Should contain authorization_endpoint');
        assert.ok(asMeta.token_endpoint.includes('/token'), 'Should contain token_endpoint');
        assert.ok(asMeta.code_challenge_methods_supported.includes('S256'), 'Should support S256 PKCE');
        console.log('[PASS] Authorization Server Metadata verified.');

        // Test 3: Unauthenticated /mcp returns 401 with WWW-Authenticate
        console.log('[Test 3] Verifying 401 Unauthorized challenge on unauthenticated /mcp...');
        const unauthRes = await fetch(`${BASE_URL}/mcp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        assert.strictEqual(unauthRes.status, 401, 'Unauthenticated request should return 401');
        const wwwAuth = unauthRes.headers.get('www-authenticate');
        assert.ok(wwwAuth && wwwAuth.includes('resource_metadata='), 'Should have WWW-Authenticate header pointing to metadata');
        console.log('[PASS] 401 challenge verified with WWW-Authenticate header.');

        // Test 4: Automated zero-click authorization code issuance on /authorize
        console.log('[Test 4] Testing zero-click authorization code issuance on /authorize...');
        const { code_challenge, code_verifier } = await pkceChallenge();

        const authRes = await fetch(`${BASE_URL}/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${code_challenge}&code_challenge_method=S256&state=state-123`, {
            redirect: 'manual'
        });
        assert.strictEqual(authRes.status, 302, 'GET /authorize should immediately redirect 302 without requiring manual consent');
        const redirectUrl = new URL(authRes.headers.get('location'));
        assert.strictEqual(redirectUrl.searchParams.get('state'), 'state-123', 'State must be preserved in redirect');
        const code = redirectUrl.searchParams.get('code');
        assert.ok(code && code.length > 20, 'Authorization code should be returned in redirect location');
        console.log('[PASS] Zero-click authorization code returned via 302 redirect.');

        // Test 5: Client Secret authentication & PKCE code exchange at /token
        console.log('[Test 5] Testing Client Secret authentication and PKCE exchange at /token...');

        // 5a. Missing client_secret should be rejected
        const missingSecretRes = await fetch(`${BASE_URL}/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: CLIENT_ID,
                code,
                code_verifier,
                redirect_uri: REDIRECT_URI
            })
        });
        assert.strictEqual(missingSecretRes.status, 400, 'Missing client_secret should return 400');
        console.log('[PASS] Missing client_secret correctly rejected.');

        // 5b. Invalid client_secret should be rejected
        const wrongSecretRes = await fetch(`${BASE_URL}/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: CLIENT_ID,
                client_secret: 'incorrect-secret-value',
                code,
                code_verifier,
                redirect_uri: REDIRECT_URI
            })
        });
        assert.strictEqual(wrongSecretRes.status, 400, 'Incorrect client_secret should return 400');
        console.log('[PASS] Incorrect client_secret correctly rejected.');

        // 5c. Bad code_verifier should fail
        const badVerifierRes = await fetch(`${BASE_URL}/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                code,
                code_verifier: 'invalid-verifier-string-here',
                redirect_uri: REDIRECT_URI
            })
        });
        assert.strictEqual(badVerifierRes.status, 400, 'Invalid PKCE verifier should return 400');
        console.log('[PASS] Invalid PKCE verifier correctly rejected.');

        // 5d. Valid client_secret + valid code_verifier should succeed
        const tokenRes = await fetch(`${BASE_URL}/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                code,
                code_verifier,
                redirect_uri: REDIRECT_URI
            })
        });
        assert.strictEqual(tokenRes.status, 200, 'Valid code exchange should return 200');
        const tokens = await tokenRes.json();
        assert.ok(tokens.access_token, 'Should return access_token');
        assert.ok(tokens.refresh_token, 'Should return refresh_token for Gemini Web');
        assert.strictEqual(tokens.token_type, 'Bearer');
        assert.strictEqual(tokens.expires_in, 3600);
        console.log('[PASS] Valid client_secret + PKCE exchange issued access_token and refresh_token.');

        // Test 6: Refresh token exchange
        console.log('[Test 6] Testing refresh_token exchange at /token...');
        const refreshRes = await fetch(`${BASE_URL}/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                refresh_token: tokens.refresh_token
            })
        });
        assert.strictEqual(refreshRes.status, 200, 'Refresh token exchange should return 200');
        const refreshed = await refreshRes.json();
        assert.ok(refreshed.access_token, 'Should return new access_token');
        console.log('[PASS] Refresh token successfully exchanged for fresh access_token.');

        // Test 7: Authenticated MCP request via StreamableHTTP
        console.log('[Test 7] Testing authenticated tool calls on /mcp...');

        // 7a. Initialize session
        const initRes = await fetch(`${BASE_URL}/mcp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                'Authorization': `Bearer ${tokens.access_token}`
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: { name: 'integration-test', version: '1.0' }
                }
            })
        });
        assert.strictEqual(initRes.status, 200, 'Initialize should return 200');
        const sessionId = initRes.headers.get('mcp-session-id');
        assert.ok(sessionId, 'Server should assign mcp-session-id');

        // 7b. Send initialized notification
        await fetch(`${BASE_URL}/mcp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                'Authorization': `Bearer ${tokens.access_token}`,
                'mcp-session-id': sessionId
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'notifications/initialized'
            })
        });

        // 7c. List tools
        const toolsRes = await fetch(`${BASE_URL}/mcp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                'Authorization': `Bearer ${tokens.access_token}`,
                'mcp-session-id': sessionId
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/list',
                params: {}
            })
        });
        assert.strictEqual(toolsRes.status, 200, 'tools/list should return 200');
        const toolsText = await toolsRes.text();
        assert.ok(toolsText.includes('list_transactions') || toolsText.includes('get_current_user'), 'Should list Lunch Money tools');
        console.log('[PASS] Authenticated tools/list executed successfully over StreamableHTTP.');

        // Test 8: Multi-session re-initialization (ensuring second client session does not lock up)
        console.log('[Test 8] Testing multi-session re-initialization...');
        const init2Res = await fetch(`${BASE_URL}/mcp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                'Authorization': `Bearer ${tokens.access_token}`
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 10,
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: { name: 'second-client-session', version: '2.0' }
                }
            })
        });
        assert.strictEqual(init2Res.status, 200, 'Second initialize should return 200');
        const session2Id = init2Res.headers.get('mcp-session-id');
        assert.ok(session2Id, 'Second session should receive mcp-session-id');
        assert.notStrictEqual(session2Id, sessionId, 'Second session should have distinct session id');

        // Confirm second session can execute tool call
        const tools2Res = await fetch(`${BASE_URL}/mcp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                'Authorization': `Bearer ${tokens.access_token}`,
                'mcp-session-id': session2Id
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 11,
                method: 'tools/list',
                params: {}
            })
        });
        assert.strictEqual(tools2Res.status, 200, 'Second session tools/list should return 200');
        console.log('[PASS] Multi-session re-initialization verified successfully.');

        // Test 9: HTTP Basic Auth client authentication at /token
        console.log('[Test 9] Testing HTTP Basic Auth header support at /token...');
        const challenge2 = await pkceChallenge();
        const auth2Res = await fetch(`${BASE_URL}/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge2.code_challenge}&code_challenge_method=S256&state=state-456`, {
            redirect: 'manual'
        });
        const code2 = new URL(auth2Res.headers.get('location')).searchParams.get('code');
        const basicAuthCredentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        const basicTokenRes = await fetch(`${BASE_URL}/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${basicAuthCredentials}`
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code: code2,
                code_verifier: challenge2.code_verifier,
                redirect_uri: REDIRECT_URI
            })
        });
        assert.strictEqual(basicTokenRes.status, 200, 'Basic Auth token exchange should return 200');
        const basicTokens = await basicTokenRes.json();
        assert.ok(basicTokens.access_token, 'Basic Auth exchange should return access_token');
        console.log('[PASS] HTTP Basic Auth header support verified at /token.');

        console.log('\n===========================================');
        console.log('🎉 ALL INTEGRATION TESTS PASSED SUCCESSFULLY!');
        console.log('===========================================\n');
    } finally {
        serverProcess.kill('SIGTERM');
    }
}

runTests().catch((err) => {
    console.error('\n❌ TEST FAILED:', err);
    serverProcess.kill('SIGKILL');
    process.exit(1);
});
