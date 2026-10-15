import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import * as jose from 'jose';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';

const DEFAULT_ICON_URL = 'https://raw.githubusercontent.com/lunch-money/developers/master/source/images/android-chrome-512x512.png';

/**
 * Validates a candidate redirect URI against allowed patterns.
 */
function isAllowedRedirectUri(uri, additionalAllowedPatterns = []) {
    const defaultPatterns = [
        /^https:\/\/oauth-redirect\.googleusercontent\.com(\/.*)?$/,
        /^https:\/\/oauth-redirect-sandbox\.googleusercontent\.com(\/.*)?$/,
        /^https:\/\/vertexaisearch\.cloud\.google\.com(\/.*)?$/,
        /^https:\/\/gemini\.google\.com(\/.*)?$/,
        /^http:\/\/localhost(:\d+)?(\/.*)?$/,
        /^http:\/\/127\.0\.0\.1(:\d+)?(\/.*)?$/
    ];

    const allPatterns = [...defaultPatterns, ...additionalAllowedPatterns];
    try {
        new URL(uri);
        return allPatterns.some(pattern => pattern.test(uri));
    } catch {
        return false;
    }
}

/**
 * Creates the Express application configuring the MCP StreamableHTTP transport and OAuth endpoints.
 */
export async function createHttpApp(mcpServer, options = {}) {
    const app = express();
    app.set('trust proxy', 1);

    app.use(cors());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    const clientId = options.clientId || process.env.MCP_OAUTH_CLIENT_ID || 'gemini-client';
    const clientSecret = options.clientSecret || process.env.MCP_OAUTH_CLIENT_SECRET || crypto.randomBytes(32).toString('hex');
    const baseUrlString = options.baseUrl || process.env.MCP_BASE_URL || 'http://localhost:3000';
    const baseUrl = new URL(baseUrlString);

    if (mcpServer?._serverInfo) {
        mcpServer._serverInfo.name = 'Lunch Money MCP (read-only)';
        mcpServer._serverInfo.title = 'Lunch Money MCP (read-only)';
        mcpServer._serverInfo.websiteUrl = 'https://github.com/daniel5151/lunch-money-mcp-ro';
        mcpServer._serverInfo.icons = [
            {
                src: DEFAULT_ICON_URL,
                mimeType: 'image/png',
                sizes: ['512x512']
            }
        ];
    }

    const rawJwtSecret = options.jwtSecret || process.env.MCP_JWT_SECRET || crypto.randomBytes(32).toString('hex');
    const jwtKey = new TextEncoder().encode(rawJwtSecret.padEnd(32, '!'));

    // In-memory store for pending authorization codes (TTL 5 minutes)
    const authCodes = new Map();

    // Dynamically registered redirect URIs (populated when /authorize is accessed)
    const registeredRedirectUris = new Set(options.redirectUris || []);

    // Cleanup expired auth codes every 5 minutes
    const cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [code, entry] of authCodes.entries()) {
            if (entry.expiresAt < now) {
                authCodes.delete(code);
            }
        }
    }, 5 * 60 * 1000);
    cleanupInterval.unref?.();

    // Scope dynamic redirect_uri capture to /authorize and cap Set growth
    app.use('/authorize', (req, _res, next) => {
        const uri = req.query.redirect_uri || req.body?.redirect_uri;
        if (uri && isAllowedRedirectUri(uri) && registeredRedirectUris.size < 100) {
            registeredRedirectUris.add(uri);
        }
        next();
    });

    // Support HTTP Basic Auth for client authentication at /token (e.g. standard OAuth clients)
    app.use('/token', (req, _res, next) => {
        req.body = req.body || {};
        const auth = req.headers.authorization;
        if (auth && auth.startsWith('Basic ')) {
            const credentials = Buffer.from(auth.slice(6), 'base64').toString('utf8');
            const sepIdx = credentials.indexOf(':');
            if (sepIdx !== -1) {
                const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
                const basicId = safeDecode(credentials.slice(0, sepIdx));
                const basicSecret = safeDecode(credentials.slice(sepIdx + 1));
                if (basicId && !req.body.client_id) req.body.client_id = basicId;
                if (basicSecret && !req.body.client_secret) req.body.client_secret = basicSecret;
            }
        }
        next();
    });

    // OAuth Server Provider implementation
    const oauthProvider = {
        get clientsStore() {
            return {
                async getClient(reqClientId) {
                    if (reqClientId !== clientId) return undefined;
                    return {
                        client_id: clientId,
                        client_secret: clientSecret,
                        redirect_uris: Array.from(registeredRedirectUris)
                    };
                }
            };
        },

        // Auto-approve /authorize and redirect immediately back with authorization code
        async authorize(client, params, res) {
            if (authCodes.size >= 100) {
                authCodes.delete(authCodes.keys().next().value);
            }
            const code = crypto.randomBytes(32).toString('hex');
            authCodes.set(code, {
                clientId: client.client_id,
                redirectUri: params.redirectUri,
                codeChallenge: params.codeChallenge,
                scopes: params.scopes || ['lunchmoney:read'],
                expiresAt: Date.now() + 5 * 60 * 1000
            });

            const targetUrl = new URL(params.redirectUri);
            targetUrl.searchParams.set('code', code);
            if (params.state) {
                targetUrl.searchParams.set('state', params.state);
            }
            res.redirect(302, targetUrl.toString());
        },

        async challengeForAuthorizationCode(_client, authorizationCode) {
            const entry = authCodes.get(authorizationCode);
            if (!entry || entry.expiresAt < Date.now()) {
                throw new Error('Invalid or expired authorization code');
            }
            return entry.codeChallenge || '';
        },

        async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri) {
            const entry = authCodes.get(authorizationCode);
            authCodes.delete(authorizationCode);

            if (!entry || entry.expiresAt < Date.now()) {
                throw new Error('Invalid or expired authorization code');
            }

            if (entry.clientId !== client.client_id) {
                throw new Error('Authorization code was not issued to this client');
            }
            if (redirectUri && entry.redirectUri !== redirectUri) {
                throw new Error('redirect_uri mismatch');
            }

            const accessToken = await new jose.SignJWT({
                sub: client.client_id,
                type: 'access',
                scopes: entry.scopes || ['lunchmoney:read']
            })
                .setProtectedHeader({ alg: 'HS256' })
                .setIssuedAt()
                .setExpirationTime('1h')
                .sign(jwtKey);

            const refreshToken = await new jose.SignJWT({
                sub: client.client_id,
                type: 'refresh',
                scopes: entry.scopes || ['lunchmoney:read']
            })
                .setProtectedHeader({ alg: 'HS256' })
                .setIssuedAt()
                .setExpirationTime('90d')
                .sign(jwtKey);

            return {
                access_token: accessToken,
                token_type: 'Bearer',
                expires_in: 3600,
                refresh_token: refreshToken
            };
        },

        async exchangeRefreshToken(client, refreshToken, requestedScopes) {
            let payload;
            try {
                const verified = await jose.jwtVerify(refreshToken, jwtKey);
                payload = verified.payload;
            } catch {
                throw new Error('Invalid or expired refresh token');
            }

            if (payload.type !== 'refresh' || payload.sub !== client.client_id) {
                throw new Error('Invalid refresh token');
            }

            const scopes = requestedScopes || payload.scopes || ['lunchmoney:read'];

            const accessToken = await new jose.SignJWT({
                sub: client.client_id,
                type: 'access',
                scopes
            })
                .setProtectedHeader({ alg: 'HS256' })
                .setIssuedAt()
                .setExpirationTime('1h')
                .sign(jwtKey);

            return {
                access_token: accessToken,
                token_type: 'Bearer',
                expires_in: 3600,
                refresh_token: refreshToken
            };
        },

        async verifyAccessToken(token) {
            try {
                const { payload } = await jose.jwtVerify(token, jwtKey);
                if (payload.type !== 'access') {
                    throw new Error('Token is not an access token');
                }
                return {
                    token,
                    clientId: String(payload.sub),
                    scopes: payload.scopes || ['lunchmoney:read'],
                    expiresAt: payload.exp,
                    resource: baseUrl
                };
            } catch (err) {
                throw err;
            }
        }
    };

    const protectedResourceMetadata = {
        resource: baseUrl.href,
        authorization_servers: [baseUrl.href],
        scopes_supported: ['lunchmoney:read'],
        resource_name: 'Lunch Money MCP (read-only)',
        logo_uri: DEFAULT_ICON_URL
    };

    app.get(['/favicon.ico', '/icon.png'], (_req, res) => {
        res.redirect(DEFAULT_ICON_URL);
    });

    app.get('/.well-known/oauth-protected-resource', (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json(protectedResourceMetadata);
    });
    app.get('/.well-known/openid-configuration', (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json({
            issuer: baseUrl.href,
            authorization_endpoint: `${baseUrl.origin}/authorize`,
            token_endpoint: `${baseUrl.origin}/token`,
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            client_name: 'Lunch Money MCP (read-only)',
            logo_uri: DEFAULT_ICON_URL
        });
    });

    app.use(mcpAuthRouter({
        provider: oauthProvider,
        issuerUrl: baseUrl,
        resourceServerUrl: baseUrl,
        scopesSupported: ['lunchmoney:read'],
        resourceName: 'Lunch Money MCP (read-only)'
    }));

    let transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID()
    });
    await mcpServer.connect(transport);

    app.all(['/', '/mcp'],
        requireBearerAuth({
            verifier: oauthProvider,
            resourceMetadataUrl: `${baseUrl.origin}/.well-known/oauth-protected-resource`
        }),
        async (req, res) => {
            const isInit = req.method === 'POST' && (
                req.body?.method === 'initialize' ||
                (Array.isArray(req.body) && req.body.some(m => m?.method === 'initialize'))
            );
            if (isInit) {
                await mcpServer.close();
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => crypto.randomUUID()
                });
                await mcpServer.connect(transport);
            }
            await transport.handleRequest(req, res, req.body);
        }
    );

    app.get('/health', (_req, res) => {
        res.json({
            status: 'ok',
            server: 'Lunch Money MCP (read-only)',
            transport: 'streamable-http',
            timestamp: new Date().toISOString()
        });
    });

    return { app, oauthProvider, transport };
}

/**
 * Starts the HTTP server on the configured port and host.
 */
export async function startHttpServer(mcpServer, options = {}) {
    const port = parseInt(options.port || process.env.PORT || process.env.MCP_PORT || '3000', 10);
    const host = options.host || process.env.HOST || process.env.MCP_HOST || '0.0.0.0';
    const baseUrl = options.baseUrl || process.env.MCP_BASE_URL || `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;

    if (!process.env.MCP_OAUTH_CLIENT_SECRET && !options.clientSecret) {
        console.warn('\x1b[33m[Warning] MCP_OAUTH_CLIENT_SECRET is not set. A random secret has been generated for this session:\x1b[0m');
        const tempSecret = crypto.randomBytes(24).toString('hex');
        process.env.MCP_OAUTH_CLIENT_SECRET = tempSecret;
        console.warn(`\x1b[32m>>> Temporary OAuth Client Secret: ${tempSecret} <<<\x1b[0m`);
    }

    if (!process.env.MCP_JWT_SECRET && !options.jwtSecret) {
        console.warn('\x1b[33m[Warning] MCP_JWT_SECRET is not set. An ephemeral random secret has been generated. Issued tokens will not survive server restarts.\x1b[0m');
    }

    const { app } = await createHttpApp(mcpServer, {
        port,
        host,
        baseUrl,
        ...options
    });

    return new Promise((resolve, reject) => {
        const server = app.listen(port, host, (err) => {
            if (err) return reject(err);
            console.error(`[MCP] HTTPS/OAuth Streamable HTTP Server listening on http://${host}:${port}`);
            console.error(`[MCP] Public Base URL: ${baseUrl}`);
            console.error(`[MCP] OAuth Protected Resource Metadata: ${baseUrl}/.well-known/oauth-protected-resource`);
            resolve(server);
        });
    });
}
