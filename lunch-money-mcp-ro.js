import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// ==========================================
// 1. INITIALIZATION & ENVIRONMENT LOADING
// ==========================================
if (typeof process.loadEnvFile === 'function') {
    try {
        process.loadEnvFile();
    } catch (e) {
        try {
            process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '.env'));
        } catch (e2) {}
    }
} else {
    console.error("[Warning] Node.js version is older than 20.6.0. process.loadEnvFile is not supported.");
}

const TARGET_HOST = 'api.lunchmoney.dev';
const TARGET_BASE_PATH = '/v2';
const LM_API_TOKEN = process.env.LUNCHMONEY_API_KEY;

if (!LM_API_TOKEN) {
    console.error("\x1b[31m[Critical Error] LUNCHMONEY_API_KEY environment variable is missing. Startup halted.\x1b[0m");
    process.exit(1);
}

// ==========================================
// 2. CACHE CONFIGURATION
// ==========================================
const accountsCache = {
    data: null,
    lastFetched: 0,
    promise: null,
    TTL: 60 * 1000 
};

// ==========================================
// 3. UTILITIES & SECURITY HYGIENE
// ==========================================
function sanitizeDeep(input) {
    if (!input) return input;
    try {
        let text = typeof input === 'string' ? input : (input.message || JSON.stringify(input));
        if (LM_API_TOKEN) {
            text = text.split(LM_API_TOKEN).join("[REDACTED_API_KEY]");
        }
        return text;
    } catch (e) {
        return "[Error sanitizing payload log context]";
    }
}

function extractError(body, defaultStatus) {
    if (body?.errors && Array.isArray(body.errors) && body.errors.length > 0) {
        return body.errors.map(e => e.errMsg).join('; ');
    }
    return body?.message || `HTTP ${defaultStatus}`;
}

function buildQueryString(args) {
    if (!args || Object.keys(args).length === 0) return "";
    const parts = [];
    for (const [key, value] of Object.entries(args)) {
        if (value === undefined || value === null) continue;
        if (typeof value === 'boolean') {
            parts.push(`${encodeURIComponent(key)}=${value}`);
        } else {
            parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
        }
    }
    return parts.length > 0 ? `?${parts.join('&')}` : "";
}

function cleanObject(obj) {
    if (Array.isArray(obj)) {
        return obj.map(cleanObject);
    } else if (obj !== null && typeof obj === 'object') {
        const cleaned = {};
        for (const [key, val] of Object.entries(obj)) {
            if (val !== undefined) {
                cleaned[key] = cleanObject(val);
            }
        }
        return cleaned;
    }
    return obj;
}

function formatDateUTC(date) {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function resolveTimeframe(timeframe) {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth(); 

    let startDate, endDate;
    switch (timeframe) {
        case "this_month":
            startDate = formatDateUTC(new Date(Date.UTC(y, m, 1)));
            endDate = formatDateUTC(new Date(Date.UTC(y, m + 1, 0)));
            break;
        case "last_month":
            startDate = formatDateUTC(new Date(Date.UTC(y, m - 1, 1)));
            endDate = formatDateUTC(new Date(Date.UTC(y, m, 0)));
            break;
        case "year_to_date":
            startDate = formatDateUTC(new Date(Date.UTC(y, 0, 1)));
            endDate = formatDateUTC(now);
            break;
        case "this_year":
            startDate = formatDateUTC(new Date(Date.UTC(y, 0, 1)));
            endDate = formatDateUTC(new Date(Date.UTC(y, 11, 31)));
            break;
        case "last_year":
            startDate = formatDateUTC(new Date(Date.UTC(y - 1, 0, 1)));
            endDate = formatDateUTC(new Date(Date.UTC(y - 1, 11, 31)));
            break;
    }
    return { startDate, endDate };
}

async function nativeFetch(endpointPath, method = "GET", token) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: TARGET_HOST,
            port: 443,
            path: `${TARGET_BASE_PATH}${endpointPath}`,
            method: method,
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            timeout: 15000
        };

        const req = https.request(options, (res) => {
            let data = "";
            res.on("data", (chunk) => data += chunk);
            res.on("end", () => {
                try {
                    resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} });
                } catch (err) {
                    resolve({ status: res.statusCode, body: { message: "Failed to parse JSON response payload" } });
                }
            });
        });

        req.on("timeout", () => {
            req.destroy(new Error("Network connection request window timed out after 15000ms"));
        });

        req.on("error", (err) => reject(new Error(sanitizeDeep(err))));
        req.end();
    });
}

async function getAccountsData(token) {
    const now = Date.now();
    if (accountsCache.data && (now - accountsCache.lastFetched <= accountsCache.TTL)) return accountsCache.data;
    if (accountsCache.promise) return accountsCache.promise;
    
    accountsCache.promise = (async () => {
        let manual, plaid;
        try {
            [manual, plaid] = await Promise.all([
                nativeFetch("/manual_accounts", "GET", token),
                nativeFetch("/plaid_accounts", "GET", token)
            ]);
        } catch (e) {
            throw new Error(sanitizeDeep(e));
        }

        if (manual.status !== 200) throw new Error(`Manual accounts fetch failed: ${extractError(manual.body, manual.status)}`);
        if (plaid.status !== 200) throw new Error(`Plaid accounts fetch failed: ${extractError(plaid.body, plaid.status)}`);

        accountsCache.data = {
            manual: manual.body.manual_accounts || [],
            synced: plaid.body.plaid_accounts || []
        };
        accountsCache.lastFetched = Date.now();
        return accountsCache.data;
    })().finally(() => {
        accountsCache.promise = null;
    });
    return accountsCache.promise;
}

const mcpResponse = {
    success: (data) => ({ content: [{ type: "text", text: JSON.stringify(cleanObject(data) || {}) }] }),
    error: (msg) => ({ content: [{ type: "text", text: `Error processing operation: ${msg}` }], isError: true })
};

// ==========================================
// 4. DELEGATION HANDLERS
// ==========================================
const toolHandlers = {
    "clear_cache": async () => {
        accountsCache.data = null;
        accountsCache.lastFetched = 0;
        return mcpResponse.success({ message: "Internal memory cache cleared successfully." });
    },

    "get_current_user": async () => {
        const { status, body } = await nativeFetch("/me", "GET", LM_API_TOKEN);
        if (status !== 200) return mcpResponse.error(`Failed to load user: ${extractError(body, status)}`);
        return mcpResponse.success(body);
    },

    "get_transaction": async (args) => {
        const { id } = args || {};
        if (!id) return mcpResponse.error("Missing required argument 'id'");
        const safeId = encodeURIComponent(String(id));
        const { status, body } = await nativeFetch(`/transactions/${safeId}`, "GET", LM_API_TOKEN);
        if (status !== 200) return mcpResponse.error(`Failed lookup (Status ${status}): ${extractError(body, status)}`);
        return mcpResponse.success(body);
    },

    "get_category": async (args) => {
        const { id } = args || {};
        if (!id) return mcpResponse.error("Missing expected parameter: id");
        const safeId = encodeURIComponent(String(id));
        const { status, body } = await nativeFetch(`/categories/${safeId}`, "GET", LM_API_TOKEN);
        
        // Defensively handling standard 200 and spec-indicated 201 response statuses
        if (status !== 200 && status !== 201) {
            return mcpResponse.error(`Category load failure (Status ${status}): ${extractError(body, status)}`);
        }
        return mcpResponse.success(body);
    },

    "get_tag": async (args) => {
        const { id } = args || {};
        if (!id) return mcpResponse.error("Missing expected parameter: id");
        const safeId = encodeURIComponent(String(id));
        const { status, body } = await nativeFetch(`/tags/${safeId}`, "GET", LM_API_TOKEN);
        if (status !== 200 && status !== 201) return mcpResponse.error(`Tag lookup failure (Status ${status}): ${extractError(body, status)}`);
        return mcpResponse.success(body);
    },

    "get_account": async (args) => {
        const { id } = args || {};
        if (!id) return mcpResponse.error("Missing required argument 'id'");
        const safeId = encodeURIComponent(String(id));
        
        const mRes = await nativeFetch(`/manual_accounts/${safeId}`, "GET", LM_API_TOKEN);
        if (mRes.status === 200) return mcpResponse.success({ ...mRes.body, _mcp_context_type: "manual" });
        
        const pRes = await nativeFetch(`/plaid_accounts/${safeId}`, "GET", LM_API_TOKEN);
        if (pRes.status === 200) return mcpResponse.success({ ...pRes.body, _mcp_context_type: "plaid" });
        
        return mcpResponse.error(`Account not found matching identifier across endpoints: ${id}`);
    },

    "get_manual_account": async (args) => {
        const { id } = args || {};
        if (!id) return mcpResponse.error("Missing expected parameter 'id'");
        const safeId = encodeURIComponent(String(id));
        const { status, body } = await nativeFetch(`/manual_accounts/${safeId}`, "GET", LM_API_TOKEN);
        if (status !== 200) return mcpResponse.error(`Manual account fetch error: ${extractError(body, status)}`);
        return mcpResponse.success(body);
    },

    "get_plaid_account": async (args) => {
        const { id } = args || {};
        if (!id) return mcpResponse.error("Missing expected parameter 'id'");
        const safeId = encodeURIComponent(String(id));
        const { status, body } = await nativeFetch(`/plaid_accounts/${safeId}`, "GET", LM_API_TOKEN);
        if (status !== 200) return mcpResponse.error(`Plaid account fetch error: ${extractError(body, status)}`);
        return mcpResponse.success(body);
    },

    "list_accounts": async () => {
        const data = await getAccountsData(LM_API_TOKEN);
        return mcpResponse.success({ manual: data.manual, synced: data.synced });
    },

    "list_categories": async (args) => {
        const cleanArgs = {};
        if (args && args.format !== undefined) cleanArgs.format = args.format;
        if (args && args.is_group !== undefined) cleanArgs.is_group = args.is_group;
        const { status, body } = await nativeFetch(`/categories${buildQueryString(cleanArgs)}`, "GET", LM_API_TOKEN);
        if (status !== 200 && status !== 201) return mcpResponse.error(`Failed retrieving categories: ${extractError(body, status)}`);
        return mcpResponse.success(body);
    },

    "list_tags": async () => {
        const { status, body } = await nativeFetch("/tags", "GET", LM_API_TOKEN);
        if (status !== 200) return mcpResponse.error(`Error retrieving tags: ${extractError(body, status)}`);
        return mcpResponse.success(body);
    },

    "list_recurring_items": async (args) => {
        const cleanArgs = {};
        if (args && args.start_date !== undefined) cleanArgs.start_date = args.start_date;
        if (args && args.end_date !== undefined) cleanArgs.end_date = args.end_date;
        if (args && args.include_suggested !== undefined) cleanArgs.include_suggested = args.include_suggested;

        const { status, body } = await nativeFetch(`/recurring_items${buildQueryString(cleanArgs)}`, "GET", LM_API_TOKEN);
        if (status !== 200) return mcpResponse.error(`Failed retrieving recurring items: ${extractError(body, status)}`);
        return mcpResponse.success(body);
    },

    "get_recurring_item": async (args) => {
        const { id, start_date, end_date } = args || {};
        if (!id) return mcpResponse.error("Missing required argument 'id'");
        const safeId = encodeURIComponent(String(id));
        const cleanArgs = {};
        if (start_date) cleanArgs.start_date = start_date;
        if (end_date) cleanArgs.end_date = end_date;

        const { status, body } = await nativeFetch(`/recurring_items/${safeId}${buildQueryString(cleanArgs)}`, "GET", LM_API_TOKEN);
        if (status !== 200) return mcpResponse.error(`Failed retrieving recurring item with ID ${id}: ${extractError(body, status)}`);
        return mcpResponse.success(body);
    },

    "get_budget_settings": async () => {
        const { status, body } = await nativeFetch("/budgets/settings", "GET", LM_API_TOKEN);
        if (status !== 200) return mcpResponse.error(`Failed budget settings fetch: ${extractError(body, status)}`);
        return mcpResponse.success(body);
    },

    "get_budget_summary": async (args) => {
        const { timeframe } = args || {};
        const apiArgs = {};
        
        const allowed = ["start_date", "end_date", "include_exclude_from_budgets", "include_occurrences", "include_past_budget_dates", "include_totals", "include_rollover_pool"];
        if (args) {
            allowed.forEach(k => { if (args[k] !== undefined) apiArgs[k] = args[k]; });
        }

        if (timeframe && (apiArgs.start_date || apiArgs.end_date)) {
            return mcpResponse.error("Must provide either 'timeframe' or explicit 'start_date'/'end_date', not both.");
        }
        if (!timeframe && (!apiArgs.start_date || !apiArgs.end_date)) {
            return mcpResponse.error("Must provide either 'timeframe' or both 'start_date' and 'end_date'");
        }
        
        if (timeframe) {
            const { startDate, endDate } = resolveTimeframe(timeframe);
            apiArgs.start_date = startDate; 
            apiArgs.end_date = endDate;
        }

        const { status, body } = await nativeFetch(`/summary${buildQueryString(apiArgs)}`, "GET", LM_API_TOKEN);
        if (status !== 200) return mcpResponse.error(`Failed parsing budget summary: ${extractError(body, status)}`);
        return mcpResponse.success(body);
    },

    "list_transactions": async (args) => {
        const { timeframe, search } = args || {};
        const apiArgs = {};
        
        // Includes 'offset' to enable proper native loop pagination capabilities
        const allowed = ["start_date", "end_date", "created_since", "updated_since", "manual_account_id", "plaid_account_id", "recurring_id", "category_id", "tag_id", "is_group_parent", "status", "is_pending", "include_pending", "include_metadata", "include_split_parents", "include_group_children", "include_children", "include_files", "limit", "offset"];
        if (args) {
            allowed.forEach(k => { if (args[k] !== undefined) apiArgs[k] = args[k]; });
        }

        if (timeframe && (apiArgs.start_date || apiArgs.end_date)) {
            return mcpResponse.error("Must provide either 'timeframe' or explicit 'start_date'/'end_date', not both.");
        }

        if (timeframe) {
            const { startDate, endDate } = resolveTimeframe(timeframe);
            apiArgs.start_date = startDate; 
            apiArgs.end_date = endDate;
        }

        // Clamp values defensively to fit inside [1, 2000] constraints per OpenAPI boundaries
        const requestedLimit = apiArgs.limit !== undefined ? apiArgs.limit : 1000;
        apiArgs.limit = Math.max(1, Math.min(requestedLimit, 2000));

        const { status, body } = await nativeFetch(`/transactions${buildQueryString(apiArgs)}`, "GET", LM_API_TOKEN);
        if (status !== 200) return mcpResponse.error(`Transactions retrieval error: ${extractError(body, status)}`);

        let result = body.transactions || [];
        if (search) {
            const query = String(search).toLowerCase();
            result = result.filter(t => 
                (t.payee && t.payee.toLowerCase().includes(query)) || 
                (t.notes && t.notes.toLowerCase().includes(query)) || 
                (t.original_name && t.original_name.toLowerCase().includes(query))
            );
        }

        return mcpResponse.success({
            transactions: result,
            has_more: body.has_more || false
        });
    },

    "get_transaction_attachment_url": async (args) => {
        const { file_id } = args || {};
        if (!file_id) return mcpResponse.error("Missing required parameter 'file_id'");
        const safeFileId = encodeURIComponent(String(file_id));
        const { status, body } = await nativeFetch(`/transactions/attachments/${safeFileId}`, "GET", LM_API_TOKEN);
        if (status !== 200) return mcpResponse.error(`Failed to retrieve file attachment URL: ${extractError(body, status)}`);
        return mcpResponse.success(body);
    }
};

// ==========================================
// 5. MCP SERVER INTERFACE BRIDGE
// ==========================================
const mcpServer = new Server(
    { name: "lunchmoney-exhaustive-readonly-mcp", version: "2.2.0" },
    { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            { 
                name: "clear_cache", 
                description: "Clears the internal server account definitions memory cache manually.", 
                inputSchema: { type: "object", properties: {} } 
            },
            { 
                name: "get_current_user", 
                description: "Get metadata profile definitions for the current user session context.", 
                inputSchema: { type: "object", properties: {} } 
            },
            { 
                name: "get_transaction", 
                description: "Get precise structural definition payload for a single transaction mapping row by record identifier key.", 
                inputSchema: { 
                    type: "object", 
                    properties: { id: { type: "integer", description: "Transaction identifier key mapping reference lookup." } }, 
                    required: ["id"] 
                } 
            },
            { 
                name: "get_category", 
                description: "Get category tracking bucket node definitions by resource identifier index.", 
                inputSchema: { 
                    type: "object", 
                    properties: { id: { type: "integer", description: "Category target node structural entity index mapping identifier." } }, 
                    required: ["id"] 
                } 
            },
            { 
                name: "get_tag", 
                description: "Get specific text tracking label array definition item profiles matching standard identifier key context.", 
                inputSchema: { 
                    type: "object", 
                    properties: { id: { type: "integer", description: "Tag database index profile mapper lookup constraint context." } }, 
                    required: ["id"] 
                } 
            },
            { 
                name: "get_recurring_item", 
                description: "Get automated upcoming programmatic prediction schedule tracking definitions with full structural match constraints criteria parameters.", 
                inputSchema: { 
                    type: "object", 
                    properties: { 
                        id: { type: "integer", description: "Programmatic billing timeline generation matrix map identifier record index." },
                        start_date: { type: "string", format: "date", description: "Optional dynamic calculation sequence windows lower index entry boundary (YYYY-MM-DD)." },
                        end_date: { type: "string", format: "date", description: "Optional dynamic evaluation iteration period upper capping parameter boundary limits (YYYY-MM-DD)." }
                    }, 
                    required: ["id"] 
                } 
            },
            { 
                name: "get_manual_account", 
                description: "Get manual physical financial context property asset balances summary ledger values profiles by structural reference id.", 
                inputSchema: { 
                    type: "object", 
                    properties: { id: { type: "integer", description: "Manual account target reference structural item definition code." } }, 
                    required: ["id"] 
                } 
            },
            { 
                name: "get_plaid_account", 
                description: "Get synced external institution credential link meta definitions configuration blocks by reference index key mapping.", 
                inputSchema: { 
                    type: "object", 
                    properties: { id: { type: "integer", description: "Plaid core operational ledger asset entity identity identifier map pointer string code." } }, 
                    required: ["id"] 
                } 
            },
            { 
                name: "get_account", 
                description: "Get structural financial account item mappings seamlessly falling back across active endpoints to cleanly surface specific context data blocks.", 
                inputSchema: { 
                    type: "object", 
                    properties: { id: { type: "integer", description: "Universal structural asset account mapper lookup identity verification string code." } }, 
                    required: ["id"] 
                } 
            },
            {
                name: "list_transactions",
                description: "List financial history database logs. Client matching fuzzy filters run locally across structural cache items returns.",
                inputSchema: {
                    type: "object",
                    properties: {
                        start_date: { type: "string", format: "date", description: "History collection window search start index parameter (YYYY-MM-DD)." }, 
                        end_date: { type: "string", format: "date", description: "History transaction window logging search upper index restriction reference parameter (YYYY-MM-DD)." },
                        timeframe: { type: "string", enum: ["this_month", "last_month", "year_to_date", "this_year", "last_year"], description: "Dynamic date window auto-evaluator string calculation query profiles shortcut." },
                        created_since: { type: "string", description: "Filter system logging entry profile creation time records (ISO 8601)." },
                        updated_since: { type: "string", description: "Filter system adjustment data structural update modification times (ISO 8601)." },
                        manual_account_id: { type: "integer", description: "Limit lookup records matching asset manual ledger constraints codes mapping references." }, 
                        plaid_account_id: { type: "integer", description: "Limit lookup data to synced banking institution tracking codes." }, 
                        recurring_id: { type: "integer", description: "Isolate search context strictly tracking timeline generation definitions mapping identities pointers." },
                        category_id: { type: "integer", description: "Filter matching item parameters tracking structural budget group paths mapping indices pointers." }, 
                        tag_id: { type: "integer", description: "Isolate items tracking special labeling criteria configuration codes." },
                        is_group_parent: { type: "boolean", description: "Filter for identifying root transaction structural containers." },
                        status: { type: "string", enum: ["reviewed", "unreviewed", "delete_pending"], description: "Filter rows matching review operational lifecycle contexts workflows." },
                        is_pending: { type: "boolean", description: "Isolate items blocking structural clearance verification sequences balances." }, 
                        include_pending: { type: "boolean", default: false, description: "Merge pending ledger elements into structural payload return frames arrays." },
                        include_metadata: { type: "boolean", default: false, description: "Extract integrated platform technical telemetries elements labels payloads arrays mapping structures." },
                        include_split_parents: { type: "boolean", default: false, description: "Preserve original unmodified parent group allocation structures references arrays items rows." }, 
                        include_group_children: { type: "boolean", default: false, description: "Pull sub-records child structural logs attached directly within structural master items references grids entries." }, 
                        include_children: { type: "boolean", default: false, description: "Extract split fractional item rows children sub-records details entries blocks mapping components arrays." },
                        include_files: { type: "boolean", default: false, description: "Extract transaction validation imaging attachment document reference maps keys." },
                        limit: { type: "integer", minimum: 1, maximum: 2000, default: 1000, description: "Dataset maximum query buffer window length constraints sizing elements pagination." }, 
                        offset: { type: "integer", description: "Pagination entry collection indexing displacement offsets parameters indicators pointer loops." },
                        search: { type: "string", maxLength: 100, description: "In-memory query text constraint tested case-insensitive across payee names, user string notes, and original row texts." }
                    }
                }
            },
            { 
                name: "list_tags", 
                description: "List configuration data details for all custom labeling keys defined on platform profiles.", 
                inputSchema: { type: "object", properties: {} } 
            },
            { 
                name: "list_recurring_items", 
                description: "List predictive baseline tracking items schedules maps definitions fields configurations structures.", 
                inputSchema: { 
                    type: "object", 
                    properties: { 
                        start_date: { type: "string", format: "date", description: "Baseline historical scanning evaluation starting tracking criteria lower entry (YYYY-MM-DD)." }, 
                        end_date: { type: "string", format: "date", description: "Baseline dynamic tracking window evaluation timeline cutoff capping index point (YYYY-MM-DD)." }, 
                        include_suggested: { type: "boolean", description: "Merge systemic intelligence anomaly modeling pattern tracking observations arrays items records representations." } 
                    } 
                } 
            },
            { 
                name: "get_budget_settings", 
                description: "Get general baseline scheduling profiles anchors and currency structural definitions context constraints records properties.", 
                inputSchema: { type: "object", properties: {} } 
            },
            {
                name: "get_budget_summary",
                description: "Get high-level structural category aggregation totals and budget timeline usage data. Requires timeframe or split dates bounds blocks parameters parsing constraints.",
                inputSchema: {
                    type: "object",
                    properties: {
                        start_date: { type: "string", format: "date", description: "Timeline monitoring tracking period analytical data calculation framework initial date parameter (YYYY-MM-DD)." }, 
                        end_date: { type: "string", format: "date", description: "Timeline monitoring query system accounting aggregation window upper ceiling reference boundary (YYYY-MM-DD)." },
                        timeframe: { type: "string", enum: ["this_month", "last_month", "year_to_date", "this_year", "last_year"], description: "Query quick window calculation configuration macro parser values sets labels mappings shortcuts." },
                        include_exclude_from_budgets: { type: "boolean", default: false, description: "Inject context entries explicitly bypassed by frontend visualization dashboards layers blocks definitions paths." },
                        include_occurrences: { type: "boolean", default: false, description: "Unpack matching structural transaction timeline occurrences blocks inside target categories components entries elements." },
                        include_past_budget_dates: { type: "boolean", default: false, description: "Pull peripheral historical timeline calculation metadata reference blocks logs metrics fields." },
                        include_totals: { type: "boolean", default: false, description: "Inject global summing matrix summaries vectors components fields into the structural data stream parameters arrays data elements calculations blocks." },
                        include_rollover_pool: { type: "boolean", default: false, description: "Calculate rolling multi-period surplus residual credit allocations streams values components blocks fields models numbers." }
                    }
                }
            },
            { 
                name: "list_categories", 
                description: "List all active operational budget mapping tree target groupings nodes profiles variables details elements blocks configurations structural layouts.", 
                inputSchema: { 
                    type: "object", 
                    properties: { 
                        format: { type: "string", enum: ["nested", "flattened"], default: "nested", description: "Data presentation organizational layout matrix geometry selector." }, 
                        is_group: { type: "boolean", description: "Isolate entries explicitly defining structural master parent classification categories groups models paths headers." } 
                    } 
                } 
            },
            { 
                name: "list_accounts", 
                description: "List comprehensive manual and active Plaid syncing accounts profile definition mappings metrics contexts balances components variables layouts ledger snapshots summaries tracking variables elements structures.", 
                inputSchema: { type: "object", properties: {} } 
            },
            {
                name: "get_transaction_attachment_url",
                description: "Generate a cryptographically secured brief transient cloud downloading link for validation receipt assets tokens references fields.",
                inputSchema: {
                    type: "object",
                    properties: { file_id: { type: "integer", description: "Structural attachment tracking file code lookup key reference parameter mapped indicator indexing pointer element entry row." } },
                    required: ["file_id"]
                }
            }
        ]
    };
});

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = toolHandlers[name];
    if (!handler) return mcpResponse.error(`Unknown requested capability execution trace: ${name}`);
    
    try {
        return await handler(args);
    } catch (err) {
        return mcpResponse.error(sanitizeDeep(err));
    }
});

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
console.error("[MCP] Fully Exhaustive Read-Only Server connected via Stdio channels.");
