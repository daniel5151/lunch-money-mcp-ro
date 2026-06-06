import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Load environment variables from .env if present
if (typeof process.loadEnvFile === 'function') {
    try {
        process.loadEnvFile();
    } catch (e) {
        try {
            process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '.env'));
        } catch (e2) {
            // Ignored if no .env file is found
        }
    }
} else {
    console.error("[Warning] Node.js version is older than 20.6.0. process.loadEnvFile is not supported. Please set LUNCHMONEY_API_KEY manually.");
}

// ==========================================
// 1. CONFIGURATION & CACHE TUNING
// ==========================================
const TARGET_HOST = 'api.lunchmoney.dev';
const TARGET_BASE_PATH = '/v2';
const LM_API_TOKEN = process.env.LUNCHMONEY_API_KEY;

// Decoupled Metadata, Tags, and Account Caching
const metadataCache = {
    categories: { data: null, lastFetched: 0, lastError: null, promise: null },
    tags: { data: null, lastFetched: 0, lastError: null, promise: null },
    TTL: 5 * 60 * 1000 // 5 minutes TTL
};

const accountsCache = {
    data: null,
    lastFetched: 0,
    lastError: null,
    promise: null,
    TTL: 60 * 1000 // 1 minute TTL
};

// Helper function for direct backing REST calls
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
            }
        };

        const req = https.request(options, (res) => {
            let data = "";
            res.on("data", (chunk) => data += chunk);
            res.on("end", () => {
                try {
                    resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} });
                } catch (err) {
                    resolve({ status: res.statusCode, body: { error: "Failed to parse JSON tracking chunk" } });
                }
            });
        });
        req.on("error", (err) => reject(err));
        req.end();
    });
}

async function getCategoriesMap(token) {
    const now = Date.now();
    if (metadataCache.categories.data && (now - metadataCache.categories.lastFetched <= metadataCache.TTL)) {
        return metadataCache.categories.data;
    }
    if (metadataCache.categories.promise) {
        return metadataCache.categories.promise;
    }
    metadataCache.categories.promise = (async () => {
        try {
            const res = await nativeFetch("/categories", "GET", token);
            if (res.status !== 200 && res.status !== 201) {
                throw new Error(`Failed to fetch categories (status ${res.status}): ${res.body.message || res.body.error || 'Unknown error'}`);
            }
            const rawCats = res.body.categories || res.body || [];
            if (!Array.isArray(rawCats)) {
                throw new Error(`Unexpected categories response format: ${JSON.stringify(rawCats)}`);
            }
            const map = {};
            for (const cat of rawCats) {
                map[cat.id] = cat.name;
            }
            metadataCache.categories.data = map;
            metadataCache.categories.lastFetched = Date.now();
            metadataCache.categories.lastError = null;
            return map;
        } catch (e) {
            console.error("Failed to populate categories cache:", e);
            metadataCache.categories.lastError = e.message;
            return metadataCache.categories.data || {};
        } finally {
            metadataCache.categories.promise = null;
        }
    })();
    return metadataCache.categories.promise;
}

async function getTagsMap(token) {
    const now = Date.now();
    if (metadataCache.tags.data && (now - metadataCache.tags.lastFetched <= metadataCache.TTL)) {
        return metadataCache.tags.data;
    }
    if (metadataCache.tags.promise) {
        return metadataCache.tags.promise;
    }
    metadataCache.tags.promise = (async () => {
        try {
            const res = await nativeFetch("/tags", "GET", token);
            if (res.status !== 200 && res.status !== 201) {
                throw new Error(`Failed to fetch tags (status ${res.status}): ${res.body.message || res.body.error || 'Unknown error'}`);
            }
            const rawTags = res.body.tags || res.body || [];
            if (!Array.isArray(rawTags)) {
                throw new Error(`Unexpected tags response format: ${JSON.stringify(rawTags)}`);
            }
            const map = {};
            for (const tag of rawTags) {
                map[tag.id] = tag.name;
            }
            metadataCache.tags.data = map;
            metadataCache.tags.lastFetched = Date.now();
            metadataCache.tags.lastError = null;
            return map;
        } catch (e) {
            console.error("Failed to populate tags cache:", e);
            metadataCache.tags.lastError = e.message;
            return metadataCache.tags.data || {};
        } finally {
            metadataCache.tags.promise = null;
        }
    })();
    return metadataCache.tags.promise;
}

async function getAccountsData(token) {
    const now = Date.now();
    if (accountsCache.data && (now - accountsCache.lastFetched <= accountsCache.TTL)) {
        return accountsCache.data;
    }
    if (accountsCache.promise) {
        return accountsCache.promise;
    }
    accountsCache.promise = (async () => {
        let manual, plaid;
        try {
            [manual, plaid] = await Promise.all([
                nativeFetch("/manual_accounts", "GET", token).catch(err => ({ status: 500, body: { message: err.message } })),
                nativeFetch("/plaid_accounts", "GET", token).catch(err => ({ status: 500, body: { message: err.message } }))
            ]);
        } catch (e) {
            accountsCache.lastError = e.message;
            throw e;
        }

        if (manual.status !== 200 && plaid.status !== 200) {
            const errMsg = `Failed to fetch accounts. Manual: ${manual.body.message || manual.status}, Plaid: ${plaid.body.message || plaid.status}`;
            accountsCache.lastError = errMsg;
            throw new Error(errMsg);
        }

        const manualAccounts = manual.status === 200
            ? (manual.body.manual_accounts || [])
            : [];
        const syncedAccounts = plaid.status === 200
            ? (plaid.body.plaid_accounts || [])
            : [];

        if (manual.status !== 200) {
            console.error(`Failed to fetch manual accounts: ${manual.body.message || manual.status}`);
        }
        if (plaid.status !== 200) {
            console.error(`Failed to fetch Plaid accounts: ${plaid.body.message || plaid.status}`);
        }

        accountsCache.data = {
            manual: manualAccounts.map(a => ({ id: a.id, name: a.name, institution: a.institution_name, balance: a.balance, type: a.type })),
            synced: syncedAccounts.map(p => ({ id: p.id, name: p.display_name || p.name, institution: p.institution_name, balance: p.balance, status: p.status }))
        };
        accountsCache.lastFetched = Date.now();
        accountsCache.lastError = null;
        return accountsCache.data;
    })().finally(() => {
        accountsCache.promise = null;
    });
    return accountsCache.promise;
}

async function getAccountsMaps(token) {
    const data = await getAccountsData(token);
    const manualMap = {};
    const syncedMap = {};
    for (const a of data.manual) {
        manualMap[a.id] = a.name;
    }
    for (const p of data.synced) {
        syncedMap[p.id] = p.name;
    }
    return { manualMap, syncedMap };
}

// Token Saver: Remove null, undefined, empty string, empty arrays, and empty objects recursively (retains boolean false)
function cleanObject(obj) {
    if (Array.isArray(obj)) {
        const arr = obj.map(cleanObject).filter(item => item !== null && item !== undefined && item !== '' && !(Array.isArray(item) && item.length === 0) && !(typeof item === 'object' && item !== null && Object.keys(item).length === 0));
        return arr.length > 0 ? arr : undefined;
    } else if (obj !== null && typeof obj === 'object') {
        const cleaned = {};
        for (const [key, val] of Object.entries(obj)) {
            const cleanedVal = cleanObject(val);
            if (cleanedVal !== null && cleanedVal !== undefined && cleanedVal !== '' && !(Array.isArray(cleanedVal) && cleanedVal.length === 0)) {
                cleaned[key] = cleanedVal;
            }
        }
        return Object.keys(cleaned).length > 0 ? cleaned : undefined;
    }
    return obj;
}

// Safe float parser to prevent NaN values from propagating
function safeParseFloat(val) {
    if (val === null || val === undefined || val === '') return undefined;
    const parsed = parseFloat(val);
    return isNaN(parsed) ? undefined : parsed;
}

// Helpers for date logic based on timeframes (UTC timezone based)
function formatDateUTC(date) {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function resolveTimeframe(timeframe) {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth(); // 0-indexed

    let startDate, endDate;

    switch (timeframe) {
        case "this_month": {
            const start = new Date(Date.UTC(y, m, 1));
            const end = new Date(Date.UTC(y, m + 1, 0));
            startDate = formatDateUTC(start);
            endDate = formatDateUTC(end);
            break;
        }
        case "last_month": {
            const start = new Date(Date.UTC(y, m - 1, 1));
            const end = new Date(Date.UTC(y, m, 0));
            startDate = formatDateUTC(start);
            endDate = formatDateUTC(end);
            break;
        }
        case "year_to_date": {
            const start = new Date(Date.UTC(y, 0, 1));
            startDate = formatDateUTC(start);
            endDate = formatDateUTC(now);
            break;
        }
        case "this_year": {
            const start = new Date(Date.UTC(y, 0, 1));
            const end = new Date(Date.UTC(y, 11, 31));
            startDate = formatDateUTC(start);
            endDate = formatDateUTC(end);
            break;
        }
        case "last_year": {
            const start = new Date(Date.UTC(y - 1, 0, 1));
            const end = new Date(Date.UTC(y - 1, 11, 31));
            startDate = formatDateUTC(start);
            endDate = formatDateUTC(end);
            break;
        }
    }
    return { startDate, endDate };
}

// ==========================================
// 2. MODEL CONTEXT PROTOCOL (MCP) INTERFACE
// ==========================================
const mcpServer = new Server(
    { name: "lunchmoney-readonly-mcp", version: "1.2.1" },
    { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "get_current_user",
                description: "Get profile details for the currently logged-in user, including their name, email, user ID, and primary currency.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "get_transaction",
                description: "Get full details of a single transaction by its ID, including date, payee, amount, category, tags, notes, and split/group details.",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "integer", description: "The unique identifier of the transaction" }
                    },
                    required: ["id"]
                }
            },
            {
                name: "get_category",
                description: "Get details of a single budgeting category by its ID, such as its name, group status, and sub-categories.",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "integer", description: "The unique identifier of the category" }
                    },
                    required: ["id"]
                }
            },
            {
                name: "get_tag",
                description: "Get details of a single tag by its ID, such as its name, description, colors, and archived status.",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "integer", description: "The unique identifier of the tag" }
                    },
                    required: ["id"]
                }
            },
            {
                name: "get_recurring_item",
                description: "Get details of a single recurring expense or income item by its ID, including cadence, amount, and overrides.",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "integer", description: "Unique recurring item identifier" },
                        start_date: { type: "string", format: "date", description: "Optional lower boundary for matching dates (YYYY-MM-DD)" },
                        end_date: { type: "string", format: "date", description: "Optional upper boundary for matching dates (YYYY-MM-DD)" }
                    },
                    required: ["id"]
                }
            },
            {
                name: "get_manual_account",
                description: "Get details of a manual account by its ID, including its current balance, currency, type, and status.",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "integer", description: "The unique identifier of the manual account" }
                    },
                    required: ["id"]
                }
            },
            {
                name: "get_plaid_account",
                description: "Get details of a Plaid-synced bank or credit card account by its ID, including its name, institution, balance, and status.",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "integer", description: "The unique identifier of the Plaid account" }
                    },
                    required: ["id"]
                }
            },
            {
                name: "get_account",
                description: "Get details of a single account by its ID. Automatically detects and handles both manual and Plaid-synced accounts.",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "integer", description: "The unique identifier of the account" }
                    },
                    required: ["id"]
                }
            },
            {
                name: "list_transactions",
                description: "Search, filter, and list historical transactions. Use this to find specific purchases, filter by date ranges, or view recent spending. If 'timeframe' is omitted, provide exact start and end dates.",
                inputSchema: {
                    type: "object",
                    properties: {
                        start_date: { type: "string", format: "date", description: "Start date of range constraint (YYYY-MM-DD)" },
                        end_date: { type: "string", format: "date", description: "End date of range constraint (YYYY-MM-DD)" },
                        timeframe: { type: "string", enum: ["this_month", "last_month", "year_to_date", "this_year", "last_year"], description: "Optional timeframe abstraction. If provided, start_date and end_date will be automatically calculated." },
                        created_since: { type: "string", description: "Filter items created after this ISO timestamp or date string" },
                        updated_since: { type: "string", description: "Filter items updated after this ISO timestamp or date string" },
                        category_id: { type: "integer", description: "Filter tracking entries by explicit category identification key" },
                        tag_id: { type: "integer", description: "Filter transactions by mapped tracking tag ID" },
                        status: { type: "string", enum: ["reviewed", "unreviewed", "delete_pending"], description: "Filter transactions by status" },
                        is_pending: { type: "boolean", description: "Filter transactions by pending status" },
                        include_pending: { type: "boolean", default: false, description: "Include pending transactions in the results" },
                        is_group_parent: { type: "boolean", description: "If true, only returns parent transactions (excludes child transactions under a split group)." },
                        include_split_parents: { type: "boolean", default: false, description: "If true, includes split parent transactions in the results." },
                        include_group_children: { type: "boolean", default: false, description: "If true, includes group child transactions in the results." },
                        include_children: { type: "boolean", default: false, description: "If true, includes child transactions in the results." },
                        include_metadata: { type: "boolean", default: false, description: "If true, includes transaction metadata in the results." },
                        include_files: { type: "boolean", default: false, description: "If true, includes file attachments information in the results." },
                        limit: { type: "integer", minimum: 1, maximum: 100, default: 50, description: "Maximum number of transactions to return (hard capped at 100). For pagination, look for 'has_more' and the suggested offset in the metadata." },
                        offset: { type: "integer", description: "Use this for pagination. If a previous request returned 'has_more: true', pass the suggested offset here." },
                        manual_account_id: { type: "integer", description: "Filter by asset identifier source" },
                        plaid_account_id: { type: "integer", description: "Filter by institution tracking key" },
                        recurring_id: { type: "integer", description: "Filter by recurring item ID" },
                        resolve_names: { type: "boolean", default: true, description: "Hydrates names into 'category_name', 'tag_names', and 'account_name' profiles locally via cached definitions." },
                        search: { type: "string", description: "Search query to match against payee, original payee name, and notes. Note: Search evaluates a maximum of 2000 transactions. To search older records, you MUST specify a narrow start_date and end_date. Search is an expensive client-side operation; to avoid timeouts, always pair it with a narrow 'timeframe' (e.g. 'this_month') or narrow date boundaries." },
                        fields: { type: "array", items: { type: "string" }, description: "Sparse array filtering. Defaults to ['id', 'date', 'payee', 'amount', 'currency', 'category_name', 'tag_names', 'account_name', 'is_split_parent', 'split_parent_id', 'is_group_parent', 'group_parent_id']. Pass ['all'] or specific tracking keys to change target shape." }
                    }
                }
            },
            {
                name: "list_tags",
                description: "List all tags used to organize and label transactions in the user's account.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "list_recurring_items",
                description: "List all recurring expenses or income items, along with their schedule parameters and suggested recurring items.",
                inputSchema: {
                    type: "object",
                    properties: {
                        start_date: { type: "string", format: "date", description: "Optional start date of the range to get matches (YYYY-MM-DD)" },
                        end_date: { type: "string", format: "date", description: "Optional end date of the range to get matches (YYYY-MM-DD)" },
                        include_suggested: { type: "boolean", description: "If true, suggested recurring items will also be returned" }
                    }
                }
            },
            {
                name: "get_budget_settings",
                description: "Get budget settings, including granularity (e.g. monthly), anchor date, rollover behavior, and income options.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "get_budget_summary",
                description: "Get a summary of the budget for a specific timeframe or date range, showing budgeted and available amounts by category, category totals, and rollover details.",
                inputSchema: {
                    type: "object",
                    properties: {
                        start_date: { type: "string", format: "date", description: "Evaluation start (YYYY-MM-DD)" },
                        end_date: { type: "string", format: "date", description: "Evaluation end (YYYY-MM-DD)" },
                        timeframe: { type: "string", enum: ["this_month", "last_month", "year_to_date", "this_year", "last_year"], description: "Optional timeframe abstraction. If provided, start_date and end_date will be automatically calculated." },
                        format: { type: "string", enum: ["nested", "flattened"], default: "flattened", description: "Format of the category budget summary structure. Defaults to 'flattened' for token efficiency." },
                        include_totals: { type: "boolean", default: false, description: "Include overall totals in response" },
                        include_rollover_pool: { type: "boolean", default: false, description: "Include rollover pool details" },
                        include_exclude_from_budgets: { type: "boolean", default: false, description: "Include categories excluded from budget" },
                        include_occurrences: { type: "boolean", default: false, description: "Include budget occurrences details" },
                        include_past_budget_dates: { type: "boolean", default: false, description: "Include past budget dates" },
                        fields: { type: "array", items: { type: "string" }, description: "Sparse array filtering for categories. Defaults to ['category_id', 'budgeted', 'available']. Pass ['all'] or specific keys to change target shape." }
                    }
                }
            },
            {
                name: "list_categories",
                description: "List all budgeting categories. Can be returned as a nested tree or a flat list, and can be filtered by whether they are category groups.",
                inputSchema: {
                    type: "object",
                    properties: {
                        format: { type: "string", enum: ["nested", "flattened"], default: "nested", description: "Format of the category list structure" },
                        is_group: { type: "boolean", description: "Filter by whether the category is a group" }
                    }
                }
            },
            {
                name: "list_accounts",
                description: "List all financial accounts (both manual and Plaid-synced) with their current balances, status, and metadata.",
                inputSchema: { type: "object", properties: {} }
            }
        ]
    };
});

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (!LM_API_TOKEN) {
        return { content: [{ type: "text", text: "Error: LUNCHMONEY_API_KEY environment variable is missing on the host server." }], isError: true };
    }

    try {
        switch (name) {
            case "get_current_user": {
                const { status, body } = await nativeFetch("/me", "GET", LM_API_TOKEN);
                if (status !== 200) {
                    return { content: [{ type: "text", text: `Error retrieving user details: ${body.message || body.error || status}` }], isError: true };
                }
                const minimalUser = {
                    id: body.id,
                    account_id: body.account_id,
                    name: body.name,
                    email: body.email,
                    currency: body.primary_currency,
                    budget_name: body.budget_name
                };
                return { content: [{ type: "text", text: JSON.stringify(cleanObject(minimalUser) || {}) }] };
            }

            case "get_transaction": {
                const { id } = args;
                if (!id) {
                    return { content: [{ type: "text", text: "Error: Missing required argument 'id'" }], isError: true };
                }
                const { status, body } = await nativeFetch(`/transactions/${id}`, "GET", LM_API_TOKEN);
                if (status !== 200) {
                    return { content: [{ type: "text", text: `Error retrieving transaction: ${body.message || body.error || status}` }], isError: true };
                }
                const tx = body;

                let categoryMap = {};
                try {
                    categoryMap = await getCategoriesMap(LM_API_TOKEN);
                } catch (e) {
                    console.error("Failed to populate categories cache for get_transaction:", e);
                }

                const categoryName = tx.category_id ? categoryMap[tx.category_id] : undefined;
                const isTransfer = categoryName ? (categoryName.toLowerCase().includes('transfer') || categoryName.toLowerCase().trim() === 'credit card payment') : false;
                const isUncategorized = !tx.category_id;

                const massagedTransaction = {
                    id: tx.id,
                    date: tx.date ? tx.date.split('T')[0] : undefined,
                    payee: tx.payee,
                    amount: tx.amount,
                    currency: tx.currency,
                    category_id: tx.category_id || undefined,
                    category_name: categoryName,
                    is_transfer: isTransfer ? true : undefined,
                    is_uncategorized: isUncategorized ? true : undefined,
                    notes: tx.notes || undefined,
                    needs_review: tx.status === 'unreviewed' ? true : undefined,
                    pending: tx.is_pending ? true : undefined,
                    tags: tx.tags ? tx.tags.map(t => ({ id: t.id, name: t.name })) : undefined,
                    tag_ids: tx.tag_ids || undefined,
                    manual_account_id: tx.manual_account_id || undefined,
                    plaid_account_id: tx.plaid_account_id || undefined,
                    is_split_parent: tx.is_split_parent || undefined,
                    split_parent_id: tx.split_parent_id || undefined,
                    is_group_parent: tx.is_group_parent || undefined,
                    group_parent_id: tx.group_parent_id || undefined,
                    created_at: tx.created_at ? tx.created_at.split('T')[0] : undefined,
                    updated_at: tx.updated_at ? tx.updated_at.split('T')[0] : undefined,
                    children: tx.children ? tx.children.map(c => {
                        const childCatName = c.category_id ? categoryMap[c.category_id] : undefined;
                        const childIsTransfer = childCatName ? (childCatName.toLowerCase().includes('transfer') || childCatName.toLowerCase().trim() === 'credit card payment') : false;
                        const childIsUncategorized = !c.category_id;
                        return {
                            id: c.id,
                            date: c.date ? c.date.split('T')[0] : undefined,
                            payee: c.payee,
                            amount: c.amount,
                            currency: c.currency,
                            category_id: c.category_id || undefined,
                            category_name: childCatName,
                            is_transfer: childIsTransfer ? true : undefined,
                            is_uncategorized: childIsUncategorized ? true : undefined,
                            notes: c.notes || undefined
                        };
                    }) : undefined
                };
                return { content: [{ type: "text", text: JSON.stringify(cleanObject(massagedTransaction) || {}) }] };
            }

            case "get_category": {
                const { id } = args;
                if (!id) {
                    return { content: [{ type: "text", text: "Error: Missing required argument 'id'" }], isError: true };
                }
                const { status, body } = await nativeFetch(`/categories/${id}`, "GET", LM_API_TOKEN);
                // Specs state 201 is returned on item queries, fallback safely checking 200/201
                if (status !== 200 && status !== 201) {
                    return { content: [{ type: "text", text: `Error retrieving category: ${body.message || body.error || status}` }], isError: true };
                }
                const cat = body;
                const massagedCategory = {
                    id: cat.id,
                    name: cat.name,
                    is_group: cat.is_group || undefined,
                    group_id: cat.group_id || undefined,
                    is_income: cat.is_income || undefined,
                    children: cat.children ? cat.children.map(c => ({ id: c.id, name: c.name })) : undefined
                };
                return { content: [{ type: "text", text: JSON.stringify(cleanObject(massagedCategory) || {}) }] };
            }

            case "get_tag": {
                const { id } = args;
                if (!id) {
                    return { content: [{ type: "text", text: "Error: Missing required argument 'id'" }], isError: true };
                }
                const { status, body } = await nativeFetch(`/tags/${id}`, "GET", LM_API_TOKEN);
                if (status !== 200 && status !== 201) {
                    return { content: [{ type: "text", text: `Error retrieving tag: ${body.message || body.error || status}` }], isError: true };
                }
                const tag = body;
                const massagedTag = {
                    id: tag.id,
                    name: tag.name,
                    description: tag.description || undefined,
                    text_color: tag.text_color || undefined,
                    background_color: tag.background_color || undefined,
                    archived: tag.archived ? true : undefined
                };
                return { content: [{ type: "text", text: JSON.stringify(cleanObject(massagedTag) || {}) }] };
            }

            case "get_recurring_item": {
                const { id } = args;
                if (!id) {
                    return { content: [{ type: "text", text: "Error: Missing required argument 'id'" }], isError: true };
                }
                const apiArgs = { ...args };
                delete apiArgs.id;
                const params = new URLSearchParams(apiArgs).toString();
                const requestPath = params ? `/recurring_items/${id}?${params}` : `/recurring_items/${id}`;
                const { status, body } = await nativeFetch(requestPath, "GET", LM_API_TOKEN);
                if (status !== 200) {
                    return { content: [{ type: "text", text: `Error retrieving recurring item: ${body.message || body.error || status}` }], isError: true };
                }
                const item = body;
                const massagedItem = {
                    id: item.id,
                    description: item.description || undefined,
                    status: item.status,
                    transaction_criteria: item.transaction_criteria ? {
                        start_date: item.transaction_criteria.start_date ? item.transaction_criteria.start_date.split('T')[0] : undefined,
                        end_date: item.transaction_criteria.end_date ? item.transaction_criteria.end_date.split('T')[0] : undefined,
                        granularity: item.transaction_criteria.granularity,
                        quantity: item.transaction_criteria.quantity,
                        anchor_date: item.transaction_criteria.anchor_date ? item.transaction_criteria.anchor_date.split('T')[0] : undefined,
                        payee: item.transaction_criteria.payee || undefined,
                        amount: item.transaction_criteria.amount,
                        to_base: safeParseFloat(item.transaction_criteria.to_base),
                        currency: item.transaction_criteria.currency,
                        plaid_account_id: item.transaction_criteria.plaid_account_id || undefined,
                        manual_account_id: item.transaction_criteria.manual_account_id || undefined
                    } : undefined,
                    overrides: item.overrides ? {
                        payee: item.overrides.payee || undefined,
                        notes: item.overrides.notes || undefined,
                        category_id: item.overrides.category_id || undefined
                    } : undefined
                };
                return { content: [{ type: "text", text: JSON.stringify(cleanObject(massagedItem) || {}) }] };
            }

            case "get_manual_account": {
                const { id } = args;
                if (!id) {
                    return { content: [{ type: "text", text: "Error: Missing required argument 'id'" }], isError: true };
                }
                const { status, body } = await nativeFetch(`/manual_accounts/${id}`, "GET", LM_API_TOKEN);
                if (status !== 200) {
                    return { content: [{ type: "text", text: `Error retrieving manual account: ${body.message || body.error || status}` }], isError: true };
                }
                const a = body;
                const massagedAccount = {
                    id: a.id,
                    name: a.name,
                    institution: a.institution_name || undefined,
                    balance: a.balance,
                    type: a.type,
                    currency: a.currency,
                    status: a.status
                };
                return { content: [{ type: "text", text: JSON.stringify(cleanObject(massagedAccount) || {}) }] };
            }

            case "get_plaid_account": {
                const { id } = args;
                if (!id) {
                    return { content: [{ type: "text", text: "Error: Missing required argument 'id'" }], isError: true };
                }
                const { status, body } = await nativeFetch(`/plaid_accounts/${id}`, "GET", LM_API_TOKEN);
                if (status !== 200) {
                    return { content: [{ type: "text", text: `Error retrieving Plaid account: ${body.message || body.error || status}` }], isError: true };
                }
                const p = body;
                const massagedAccount = {
                    id: p.id,
                    name: p.display_name || p.name,
                    institution: p.institution_name,
                    balance: p.balance,
                    status: p.status,
                    currency: p.currency
                };
                return { content: [{ type: "text", text: JSON.stringify(cleanObject(massagedAccount) || {}) }] };
            }

            case "get_account": {
                const { id } = args;
                if (!id) {
                    return { content: [{ type: "text", text: "Error: Missing required argument 'id'" }], isError: true };
                }

                let accounts;
                try {
                    accounts = await getAccountsData(LM_API_TOKEN);
                } catch (e) {
                    console.error("Failed to fetch accounts cache for get_account routing:", e);
                }

                let isPlaid = false;
                let isManual = false;

                if (accounts) {
                    isManual = accounts.manual.some(a => Number(a.id) === Number(id));
                    isPlaid = accounts.synced.some(p => Number(p.id) === Number(id));
                }

                if (!isManual && !isPlaid) {
                    isManual = true; 
                }

                if (isManual) {
                    const { status, body } = await nativeFetch(`/manual_accounts/${id}`, "GET", LM_API_TOKEN);
                    if (status === 200) {
                        const a = body;
                        const massagedAccount = {
                            id: a.id,
                            name: a.name,
                            institution: a.institution_name || undefined,
                            balance: a.balance,
                            type: a.type,
                            currency: a.currency,
                            status: a.status,
                            account_type: "manual"
                        };
                        return { content: [{ type: "text", text: JSON.stringify(cleanObject(massagedAccount) || {}) }] };
                    }
                    if (!accounts || (!isPlaid && isManual)) {
                        const { status: pStatus, body: pBody } = await nativeFetch(`/plaid_accounts/${id}`, "GET", LM_API_TOKEN);
                        if (pStatus === 200) {
                            const p = pBody;
                            const massagedAccount = {
                                id: p.id,
                                name: p.display_name || p.name,
                                institution: p.institution_name,
                                balance: p.balance,
                                status: p.status,
                                currency: p.currency,
                                account_type: "plaid"
                            };
                            return { content: [{ type: "text", text: JSON.stringify(cleanObject(massagedAccount) || {}) }] };
                        }
                    }
                    return { content: [{ type: "text", text: `Error retrieving account: ${body.message || body.error || status}` }], isError: true };
                } else {
                    const { status, body } = await nativeFetch(`/plaid_accounts/${id}`, "GET", LM_API_TOKEN);
                    if (status !== 200) {
                        return { content: [{ type: "text", text: `Error retrieving Plaid account: ${body.message || body.error || status}` }], isError: true };
                    }
                    const p = body;
                    const massagedAccount = {
                        id: p.id,
                        name: p.display_name || p.name,
                        institution: p.institution_name,
                        balance: p.balance,
                        status: p.status,
                        currency: p.currency,
                        account_type: "plaid"
                    };
                    return { content: [{ type: "text", text: JSON.stringify(cleanObject(massagedAccount) || {}) }] };
                }
            }

            case "list_transactions": {
                const { resolve_names = true, fields, search, timeframe } = args || {};

                const apiArgs = { ...args };
                delete apiArgs.resolve_names;
                delete apiArgs.fields;
                delete apiArgs.search;
                delete apiArgs.timeframe;

                if (timeframe) {
                    const { startDate, endDate } = resolveTimeframe(timeframe);
                    apiArgs.start_date = startDate;
                    apiArgs.end_date = endDate;
                }

                const requestedLimit = apiArgs.limit !== undefined ? apiArgs.limit : 50;
                const clientLimit = Math.min(requestedLimit, 100);
                const clientOffset = apiArgs.offset !== undefined ? apiArgs.offset : 0;

                if (search) {
                    apiArgs.limit = 2000;
                    delete apiArgs.offset;
                } else {
                    apiArgs.limit = clientLimit;
                }

                const params = new URLSearchParams(apiArgs).toString();
                const { status, body } = await nativeFetch(`/transactions?${params}`, "GET", LM_API_TOKEN);
                if (status !== 200) {
                    return { content: [{ type: "text", text: `Error retrieving transactions: ${body.message || body.error || status}` }], isError: true };
                }

                let categoryMap = {};
                let tagsMap = {};
                let accountsMaps = { manualMap: {}, syncedMap: {} };
                let hydrationWarnings = [];

                if (resolve_names) {
                    categoryMap = await getCategoriesMap(LM_API_TOKEN);
                    if (metadataCache.categories.lastError) {
                        hydrationWarnings.push(`Failed to resolve category names: ${metadataCache.categories.lastError}`);
                    }
                    tagsMap = await getTagsMap(LM_API_TOKEN);
                    if (metadataCache.tags.lastError) {
                        hydrationWarnings.push(`Failed to resolve tag names: ${metadataCache.tags.lastError}`);
                    }
                    try {
                        accountsMaps = await getAccountsMaps(LM_API_TOKEN);
                    } catch (e) {
                        console.error("Failed to populate accounts cache for transactions:", e);
                    }
                    if (accountsCache.lastError) {
                        hydrationWarnings.push(`Failed to resolve account names: ${accountsCache.lastError}`);
                    }
                } else {
                    try {
                        categoryMap = await getCategoriesMap(LM_API_TOKEN);
                    } catch (e) {
                        console.error("Failed to populate categories cache for transfer check:", e);
                    }
                }

                let rawTransactions = body.transactions || body || [];
                if (search) {
                    const searchQuery = String(search).toLowerCase();
                    rawTransactions = rawTransactions.filter(tx => {
                        return (tx.payee && tx.payee.toLowerCase().includes(searchQuery)) ||
                            (tx.notes && tx.notes.toLowerCase().includes(searchQuery)) ||
                            (tx.original_name && tx.original_name.toLowerCase().includes(searchQuery));
                    });
                }

                let truncated = false;
                if (search) {
                    if (clientOffset > 0) {
                        rawTransactions = rawTransactions.slice(clientOffset);
                    }
                    if (rawTransactions.length > clientLimit) {
                        rawTransactions = rawTransactions.slice(0, clientLimit);
                        truncated = true;
                    }
                } else {
                    if (rawTransactions.length > clientLimit) {
                        rawTransactions = rawTransactions.slice(0, clientLimit);
                        truncated = true;
                    }
                }

                let activeFields = (fields && Array.isArray(fields) && fields.length > 0 && !fields.includes("all"))
                    ? fields
                    : (fields?.includes("all") ? null : ["id", "date", "payee", "amount", "currency", "category_name", "tag_names", "account_name", "is_split_parent", "split_parent_id", "is_group_parent", "group_parent_id", "is_transfer", "is_uncategorized"]);

                const massagedTransactions = rawTransactions.map(tx => {
                    const categoryName = tx.category_id ? categoryMap[tx.category_id] : undefined;
                    const isTransfer = categoryName ? (categoryName.toLowerCase().includes('transfer') || categoryName.toLowerCase().trim() === 'credit card payment') : false;
                    const isUncategorized = !tx.category_id;

                    const item = {
                        id: tx.id,
                        date: tx.date ? tx.date.split('T')[0] : undefined,
                        payee: tx.payee,
                        amount: tx.amount,
                        currency: tx.currency,
                        to_base: safeParseFloat(tx.to_base),
                        category_id: tx.category_id || undefined,
                        is_transfer: isTransfer ? true : undefined,
                        is_uncategorized: isUncategorized ? true : undefined,
                        tag_ids: tx.tag_ids || undefined,
                        recurring_id: tx.recurring_id || undefined,
                        original_name: tx.original_name || undefined,
                        notes: tx.notes || undefined,
                        needs_review: tx.status === 'unreviewed' ? true : undefined,
                        pending: tx.is_pending ? true : undefined,
                        is_split_parent: tx.is_split_parent || undefined,
                        split_parent_id: tx.split_parent_id || undefined,
                        is_group_parent: tx.is_group_parent || undefined,
                        group_parent_id: tx.group_parent_id || undefined,
                        manual_account_id: tx.manual_account_id || undefined,
                        plaid_account_id: tx.plaid_account_id || undefined,
                        created_at: tx.created_at ? tx.created_at.split('T')[0] : undefined,
                        updated_at: tx.updated_at ? tx.updated_at.split('T')[0] : undefined
                    };

                    if (resolve_names) {
                        if (categoryName) {
                            item.category_name = categoryName;
                        }
                        if (tx.tag_ids && Array.isArray(tx.tag_ids)) {
                            item.tag_names = tx.tag_ids.map(id => tagsMap[id]).filter(Boolean);
                        }
                        if (tx.manual_account_id && accountsMaps.manualMap[tx.manual_account_id]) {
                            item.account_name = accountsMaps.manualMap[tx.manual_account_id];
                        } else if (tx.plaid_account_id && accountsMaps.syncedMap[tx.plaid_account_id]) {
                            item.account_name = accountsMaps.syncedMap[tx.plaid_account_id];
                        }
                    }

                    if (activeFields) {
                        const filtered = {};
                        for (const field of activeFields) {
                            if (item[field] !== undefined) filtered[field] = item[field];
                        }
                        return filtered;
                    }

                    return item;
                });

                const responseObj = {
                    transactions: massagedTransactions
                };

                if (body.has_more || truncated) {
                    responseObj.has_more = true;
                    const nextOffset = clientOffset + massagedTransactions.length;
                    responseObj._meta = `Results truncated. Use offset=${nextOffset} to fetch the next page.`;
                }

                if (hydrationWarnings.length > 0) {
                    const warningText = `Hydration warnings: ${hydrationWarnings.join("; ")}`;
                    if (responseObj._meta) {
                        responseObj._meta = `${responseObj._meta} | ${warningText}`;
                    } else {
                        responseObj._meta = warningText;
                    }
                }

                return { content: [{ type: "text", text: JSON.stringify(cleanObject(responseObj) || { transactions: [] }) }] };
            }

            case "list_tags": {
                const { status, body } = await nativeFetch("/tags", "GET", LM_API_TOKEN);
                if (status !== 200) {
                    return { content: [{ type: "text", text: `Error retrieving tags: ${body.message || body.error || status}` }], isError: true };
                }
                const rawTags = body.tags || body || [];
                const massagedTags = rawTags.map(tag => ({
                    id: tag.id,
                    name: tag.name,
                    description: tag.description || undefined,
                    text_color: tag.text_color || undefined,
                    background_color: tag.background_color || undefined,
                    archived: tag.archived ? true : undefined
                }));
                return { content: [{ type: "text", text: JSON.stringify(cleanObject(massagedTags) || []) }] };
            }

            case "list_recurring_items": {
                const params = new URLSearchParams(args).toString();
                const pathString = params ? `/recurring_items?${params}` : "/recurring_items";
                const { status, body } = await nativeFetch(pathString, "GET", LM_API_TOKEN);
                if (status !== 200) {
                    return { content: [{ type: "text", text: `Error retrieving recurring items: ${body.message || body.error || status}` }], isError: true };
                }
                const rawItems = body.recurring_items || body || [];
                const massagedItems = rawItems.map(item => ({
                    id: item.id,
                    description: item.description || undefined,
                    status: item.status,
                    transaction_criteria: item.transaction_criteria ? {
                        start_date: item.transaction_criteria.start_date ? item.transaction_criteria.start_date.split('T')[0] : undefined,
                        end_date: item.transaction_criteria.end_date ? item.transaction_criteria.end_date.split('T')[0] : undefined,
                        granularity: item.transaction_criteria.granularity,
                        quantity: item.transaction_criteria.quantity,
                        anchor_date: item.transaction_criteria.anchor_date ? item.transaction_criteria.anchor_date.split('T')[0] : undefined,
                        payee: item.transaction_criteria.payee || undefined,
                        amount: item.transaction_criteria.amount || undefined,
                        to_base: safeParseFloat(item.transaction_criteria.to_base),
                        currency: item.transaction_criteria.currency,
                        plaid_account_id: item.transaction_criteria.plaid_account_id || undefined,
                        manual_account_id: item.transaction_criteria.manual_account_id || undefined
                    } : undefined,
                    overrides: item.overrides ? {
                        payee: item.overrides.payee || undefined,
                        notes: item.overrides.notes || undefined,
                        category_id: item.overrides.category_id || undefined
                    } : undefined
                }));
                return { content: [{ type: "text", text: JSON.stringify(cleanObject(massagedItems) || []) }] };
            }

            case "get_budget_settings": {
                const { status, body } = await nativeFetch("/budgets/settings", "GET", LM_API_TOKEN);
                if (status !== 200) {
                    return { content: [{ type: "text", text: `Error retrieving budget settings: ${body.message || body.error || status}` }], isError: true };
                }
                const massagedSettings = {
                    budget_period_granularity: body.budget_period_granularity,
                    budget_period_quantity: safeParseFloat(body.budget_period_quantity),
                    budget_period_anchor_date: body.budget_period_anchor_date ? body.budget_period_anchor_date.split('T')[0] : undefined,
                    budget_hide_no_activity: body.budget_hide_no_activity,
                    budget_use_last_day_of_month: body.budget_use_last_day_of_month,
                    budget_income_option: body.budget_income_option,
                    budget_rollover_left_to_budget: body.budget_rollover_left_to_budget
                };
                return { content: [{ type: "text", text: JSON.stringify(cleanObject(massagedSettings) || {}) }] };
            }

            case "get_budget_summary": {
                const { fields, timeframe, format = "flattened" } = args || {};
                const apiArgs = { ...args };
                delete apiArgs.fields;
                delete apiArgs.timeframe;
                delete apiArgs.format;

                // Strictly disable include_occurrences and include_rollover_pool unless explicitly set to true
                if (apiArgs.include_rollover_pool === undefined) {
                    apiArgs.include_rollover_pool = false;
                }
                if (apiArgs.include_occurrences === undefined) {
                    apiArgs.include_occurrences = false;
                }

                if (!timeframe && (!apiArgs.start_date || !apiArgs.end_date)) {
                    return { content: [{ type: "text", text: "Error: Must provide either 'timeframe' or both 'start_date' and 'end_date'" }], isError: true };
                }

                if (timeframe) {
                    const { startDate, endDate } = resolveTimeframe(timeframe);
                    apiArgs.start_date = startDate;
                    apiArgs.end_date = endDate;
                }

                const params = new URLSearchParams(apiArgs).toString();
                const { status, body } = await nativeFetch(`/summary?${params}`, "GET", LM_API_TOKEN);
                if (status !== 200) {
                    return { content: [{ type: "text", text: `Error retrieving budget summary: ${body.message || body.error || status}` }], isError: true };
                }

                let activeFields = (fields && Array.isArray(fields) && fields.length > 0 && !fields.includes("all"))
                    ? fields
                    : (fields?.includes("all") ? null : ["category_id", "budgeted", "available"]);

                const massagedSummary = {
                    aligned: body.aligned,
                    categories: (body.categories || []).map(cat => {
                        const item = {};

                        // Helper to set nested or flattened totals property
                        const setTotal = (key, val) => {
                            if (val !== undefined && val !== null) {
                                if (format === "nested") {
                                    if (!item.totals) item.totals = {};
                                    item.totals[key] = val;
                                } else {
                                    item[key] = val;
                                }
                            }
                        };

                        if (activeFields) {
                            if (activeFields.includes("category_id")) {
                                item.category_id = cat.category_id;
                            }
                            if (cat.totals) {
                                if (activeFields.includes("budgeted")) {
                                    setTotal("budgeted", safeParseFloat(cat.totals.budgeted));
                                }
                                if (activeFields.includes("available")) {
                                    setTotal("available", safeParseFloat(cat.totals.available));
                                }
                                if (activeFields.includes("other_activity")) {
                                    setTotal("other_activity", cat.totals.other_activity);
                                }
                                if (activeFields.includes("recurring_activity")) {
                                    setTotal("recurring_activity", cat.totals.recurring_activity);
                                }
                                if (activeFields.includes("recurring_remaining")) {
                                    setTotal("recurring_remaining", cat.totals.recurring_remaining);
                                }
                                if (activeFields.includes("recurring_expected")) {
                                    setTotal("recurring_expected", cat.totals.recurring_expected);
                                }
                            }
                            if (activeFields.includes("occurrences") && cat.occurrences) {
                                item.occurrences = cat.occurrences.map(occ => ({
                                    in_range: occ.in_range,
                                    start_date: occ.start_date ? occ.start_date.split('T')[0] : undefined,
                                    end_date: occ.end_date ? occ.end_date.split('T')[0] : undefined,
                                    other_activity: occ.other_activity,
                                    recurring_activity: occ.recurring_activity,
                                    budgeted: safeParseFloat(occ.budgeted),
                                    notes: occ.notes || undefined
                                }));
                            }
                            if (activeFields.includes("rollover_pool") && cat.rollover_pool) {
                                item.rollover_pool = {
                                    budgeted_to_base: cat.rollover_pool.budgeted_to_base,
                                    all_adjustments: cat.rollover_pool.all_adjustments ? cat.rollover_pool.all_adjustments.map(adj => ({
                                        date: adj.date ? adj.date.split('T')[0] : undefined,
                                        amount: adj.amount,
                                        currency: adj.currency,
                                        to_base: adj.to_base
                                    })) : undefined
                                };
                            }
                        } else {
                            item.category_id = cat.category_id;
                            if (cat.totals) {
                                setTotal("other_activity", cat.totals.other_activity);
                                setTotal("recurring_activity", cat.totals.recurring_activity);
                                setTotal("budgeted", safeParseFloat(cat.totals.budgeted));
                                setTotal("available", safeParseFloat(cat.totals.available));
                                setTotal("recurring_remaining", cat.totals.recurring_remaining);
                                setTotal("recurring_expected", cat.totals.recurring_expected);
                            }
                            if (cat.occurrences) {
                                item.occurrences = cat.occurrences.map(occ => ({
                                    in_range: occ.in_range,
                                    start_date: occ.start_date ? occ.start_date.split('T')[0] : undefined,
                                    end_date: occ.end_date ? occ.end_date.split('T')[0] : undefined,
                                    other_activity: occ.other_activity,
                                    recurring_activity: occ.recurring_activity,
                                    budgeted: safeParseFloat(occ.budgeted),
                                    notes: occ.notes || undefined
                                }));
                            }
                            if (cat.rollover_pool) {
                                item.rollover_pool = {
                                    budgeted_to_base: cat.rollover_pool.budgeted_to_base,
                                    all_adjustments: cat.rollover_pool.all_adjustments ? cat.rollover_pool.all_adjustments.map(adj => ({
                                        date: adj.date ? adj.date.split('T')[0] : undefined,
                                        amount: adj.amount,
                                        currency: adj.currency,
                                        to_base: adj.to_base
                                    })) : undefined
                                };
                            }
                        }

                        return item;
                    }),
                    totals: body.totals ? {
                        inflow: body.totals.inflow,
                        outflow: body.totals.outflow
                    } : undefined,
                    rollover_pool: body.rollover_pool ? {
                        budgeted_to_base: body.rollover_pool.budgeted_to_base,
                        all_adjustments: body.rollover_pool.all_adjustments ? body.rollover_pool.all_adjustments.map(adj => ({
                            date: adj.date ? adj.date.split('T')[0] : undefined,
                            amount: adj.amount,
                            currency: adj.currency,
                            to_base: adj.to_base
                        })) : undefined
                    } : undefined
                };

                return { content: [{ type: "text", text: JSON.stringify(cleanObject(massagedSummary) || {}) }] };
            }

            case "list_categories": {
                const params = new URLSearchParams(args).toString();
                const targetPath = params ? `/categories?${params}` : "/categories";
                const { status, body } = await nativeFetch(targetPath, "GET", LM_API_TOKEN);
                if (status !== 200 && status !== 201) {
                    return { content: [{ type: "text", text: `Error retrieving categories: ${body.message || body.error || status}` }], isError: true };
                }
                const rawCategories = body.categories || body || [];
                const massagedCategories = rawCategories.map(cat => ({
                    id: cat.id,
                    name: cat.name,
                    is_group: cat.is_group || undefined,
                    group_id: cat.group_id || undefined,
                    is_income: cat.is_income || undefined,
                    children: cat.children ? cat.children.map(c => ({ id: c.id, name: c.name })) : undefined
                }));
                return { content: [{ type: "text", text: JSON.stringify(cleanObject(massagedCategories) || []) }] };
            }

            case "list_accounts": {
                try {
                    const data = await getAccountsData(LM_API_TOKEN);
                    return { content: [{ type: "text", text: JSON.stringify(data) }] };
                } catch (e) {
                    return { content: [{ type: "text", text: `Error retrieving accounts: ${e.message}` }], isError: true };
                }
            }

            default:
                return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
        }
    } catch (error) {
        return { content: [{ type: "text", text: `Internal server failure processing tool execution: ${error.message}` }], isError: true };
    }
});

// Hook up MCP directly to stdio transport pipeline
const transport = new StdioServerTransport();
await mcpServer.connect(transport);
console.error("[MCP] Direct Server successfully attached to stdio pipeline.");
