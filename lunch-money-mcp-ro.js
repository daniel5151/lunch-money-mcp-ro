import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { 
    ListToolsRequestSchema, 
    CallToolRequestSchema, 
    ListResourcesRequestSchema, 
    ReadResourceRequestSchema, 
    ListPromptsRequestSchema, 
    GetPromptRequestSchema, 
    McpError, 
    ErrorCode 
} from "@modelcontextprotocol/sdk/types.js";
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const ajv = new Ajv({
    allErrors: true,
    coerceTypes: true,
    useDefaults: true
});
addFormats(ajv);

const validators = {};

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
    generation: 0,
    TTL: 60 * 1000 
};

const categoriesCache = {
    data: null,
    lastFetched: 0,
    promise: null,
    generation: 0,
    TTL: 60 * 1000
};

const tagsCache = {
    data: null,
    lastFetched: 0,
    promise: null,
    generation: 0,
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

function isEmptyValue(val) {
    if (val === null || val === undefined || val === "") return true;
    if (Array.isArray(val)) return val.length === 0;
    if (typeof val === 'object') return Object.keys(val).length === 0;
    return false;
}

function cleanObject(obj) {
    if (Array.isArray(obj)) {
        return obj.map(cleanObject);
    } else if (obj !== null && typeof obj === 'object') {
        const cleaned = {};
        for (const [key, val] of Object.entries(obj)) {
            const cleanedVal = cleanObject(val);
            if (!isEmptyValue(cleanedVal)) {
                cleaned[key] = cleanedVal;
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

// The /categories response is a forest: top-level categories may be groups
// whose subcategories live in a `children` array (and children carry group_id).
// Most transactions and budget rows reference a CHILD category id, so any
// id->name lookup that walks only the top level silently fails to resolve the
// majority of real data. Flatten parents and children into one list.
function flattenCategories(categories) {
    const out = [];
    if (!Array.isArray(categories)) return out;
    for (const cat of categories) {
        if (!cat) continue;
        out.push(cat);
        if (Array.isArray(cat.children)) {
            for (const child of cat.children) {
                if (child) out.push(child);
            }
        }
    }
    return out;
}

// Build an id -> name Map covering every category at any depth.
function buildCategoryNameMap(categories) {
    const map = new Map();
    for (const cat of flattenCategories(categories)) {
        if (cat.id !== undefined && cat.id !== null) map.set(cat.id, cat.name);
    }
    return map;
}

// Lunch Money returns transaction amounts as fixed-decimal STRINGS ("126.8500")
// and budget totals as JSON numbers (IEEE-754 floats). We never do arithmetic
// on transaction strings, but budget activity must be summed, and naive float
// addition leaks noise like 43.360000000000014 into output. Sum in integer
// cents and format to 2 dp only at render. Returns a string; passes through
// null/undefined and any non-finite input untouched.
function formatMoney(value) {
    if (value === null || value === undefined) return value;
    const n = typeof value === "string" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isFinite(n)) return value;
    return (Math.round(n * 100) / 100).toFixed(2);
}

// Add money values without float drift by working in integer cents.
function addMoney(...values) {
    let cents = 0;
    for (const v of values) {
        const n = typeof v === "string" ? Number(v) : v;
        if (typeof n === "number" && Number.isFinite(n)) cents += Math.round(n * 100);
    }
    return cents / 100;
}

// Lunch Money HTML-encodes user-authored text (tag/category/account names,
// payees, notes) in API responses, e.g. "Penny&#x27;s". The markdown we emit
// is plain text for humans, not HTML, so decode the common entities back to
// their literal characters. Applied only on the rendered markdown string;
// the output_format:"json" path passes the raw API payload through untouched.
function decodeEntities(text) {
    if (typeof text !== "string" || text.indexOf("&") === -1) return text;
    return text
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
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
    
    const gen = accountsCache.generation;
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

        const result = {
            manual: manual.body.manual_accounts || [],
            synced: plaid.body.plaid_accounts || []
        };
        // Only write back if no clear_cache happened while this fetch was in
        // flight. Otherwise a clear would be silently undone by a late resolver.
        if (gen === accountsCache.generation) {
            accountsCache.data = result;
            accountsCache.lastFetched = Date.now();
        }
        return result;
    })().finally(() => {
        if (gen === accountsCache.generation) accountsCache.promise = null;
    });
    return accountsCache.promise;
}

async function getCategoriesData(token) {
    const now = Date.now();
    if (categoriesCache.data && (now - categoriesCache.lastFetched <= categoriesCache.TTL)) return categoriesCache.data;
    if (categoriesCache.promise) return categoriesCache.promise;

    const gen = categoriesCache.generation;
    categoriesCache.promise = (async () => {
        const { status, body } = await nativeFetch("/categories", "GET", token);
        if (status !== 200 && status !== 201) throw new Error(`Categories fetch failed: ${extractError(body, status)}`);
        const result = body.categories || [];
        if (gen === categoriesCache.generation) {
            categoriesCache.data = result;
            categoriesCache.lastFetched = Date.now();
        }
        return result;
    })().finally(() => {
        if (gen === categoriesCache.generation) categoriesCache.promise = null;
    });
    return categoriesCache.promise;
}

async function getTagsData(token) {
    const now = Date.now();
    if (tagsCache.data && (now - tagsCache.lastFetched <= tagsCache.TTL)) return tagsCache.data;
    if (tagsCache.promise) return tagsCache.promise;

    const gen = tagsCache.generation;
    tagsCache.promise = (async () => {
        const { status, body } = await nativeFetch("/tags", "GET", token);
        if (status !== 200) throw new Error(`Tags fetch failed: ${extractError(body, status)}`);
        const tagsArray = body && body.tags ? body.tags : (Array.isArray(body) ? body : []);
        if (gen === tagsCache.generation) {
            tagsCache.data = tagsArray;
            tagsCache.lastFetched = Date.now();
        }
        return tagsArray;
    })().finally(() => {
        if (gen === tagsCache.generation) tagsCache.promise = null;
    });
    return tagsCache.promise;
}

function generateMarkdown(data) {
    if (!data) return "";

    // --- Recurring Items List ---
    // v2 schema: each item nests the matching rule under `transaction_criteria`
    // (amount/currency/payee/granularity/quantity) and user-facing overrides
    // under `overrides` (payee/category_id/notes). There is NO top-level
    // amount/currency/payee/billing_date. Upcoming dates live in
    // `matches.expected_occurrence_dates`. Cadence = quantity + granularity.
    if (data.recurring_items && Array.isArray(data.recurring_items)) {
        if (data.recurring_items.length === 0) return "No recurring items found.";
        let md = "### Recurring Items\n\n";
        md += "| ID | Payee | Amount | Currency | Cadence | Next | Status |\n";
        md += "| --- | --- | --- | --- | --- | --- | --- |\n";
        for (const r of data.recurring_items) {
            const tc = r.transaction_criteria || {};
            const ov = r.overrides || {};
            const payee = ov.payee || tc.payee || r.description || "";
            const amount = tc.amount != null ? formatMoney(tc.amount) : "";
            const currency = tc.currency || "";
            const cadence = (tc.quantity != null && tc.granularity)
                ? `every ${tc.quantity} ${tc.granularity}${tc.quantity > 1 ? "s" : ""}`
                : (tc.granularity || "");
            const next = (r.matches && Array.isArray(r.matches.expected_occurrence_dates)
                && r.matches.expected_occurrence_dates.length)
                ? r.matches.expected_occurrence_dates[0] : "";
            md += `| ${r.id} | ${payee} | ${amount} | ${currency} | ${cadence} | ${next} | ${r.status || ""} |\n`;
        }
        return md;
    }

    // --- Recurring Item (Single) ---
    // Must precede the transaction-detail branch below: recurring items also
    // carry id and would otherwise be rendered as a transaction. The
    // distinguishing field is `transaction_criteria` (txns/accounts lack it).
    if (data.transaction_criteria !== undefined && data.id !== undefined) {
        const tc = data.transaction_criteria || {};
        const ov = data.overrides || {};
        let md = `### Recurring Item #${data.id}\n\n`;
        if (data.description) md += `- **Description**: ${data.description}\n`;
        md += `- **Payee**: ${ov.payee || tc.payee || ""}\n`;
        if (tc.amount != null) md += `- **Amount**: ${formatMoney(tc.amount)}${tc.currency ? " " + tc.currency : ""}\n`;
        if (tc.quantity != null && tc.granularity) {
            md += `- **Cadence**: every ${tc.quantity} ${tc.granularity}${tc.quantity > 1 ? "s" : ""}\n`;
        } else if (tc.granularity) {
            md += `- **Cadence**: ${tc.granularity}\n`;
        }
        if (tc.anchor_date) md += `- **Anchor Date**: ${tc.anchor_date}\n`;
        if (data.status) md += `- **Status**: ${data.status}\n`;
        const catId = ov.category_id != null ? ov.category_id : tc.category_id;
        if (data.category_name) md += `- **Category**: ${data.category_name} (${catId})\n`;
        else if (catId != null) md += `- **Category ID**: ${catId}\n`;
        const notes = ov.notes || data.notes;
        if (notes) md += `- **Notes**: ${notes}\n`;
        if (data.matches && Array.isArray(data.matches.expected_occurrence_dates)
            && data.matches.expected_occurrence_dates.length) {
            md += `- **Expected Occurrences**: ${data.matches.expected_occurrence_dates.join(", ")}\n`;
        }
        if (data.matches && Array.isArray(data.matches.missing_transaction_dates)
            && data.matches.missing_transaction_dates.length) {
            md += `- **Missing**: ${data.matches.missing_transaction_dates.join(", ")}\n`;
        }
        return md;
    }

    // --- Single Account (manual or plaid) ---
    // Keyed on balance (accounts have it; transactions use amount, categories/
    // tags/budget-settings have none). date===undefined guards against any txn.
    if (data.id !== undefined && data.balance !== undefined && data.date === undefined) {
        const ctx = data._mcp_context_type;
        const kind = ctx ? `${ctx.charAt(0).toUpperCase() + ctx.slice(1)} Account` : "Account";
        let md = `### ${kind}: ${data.display_name || data.name} (#${data.id})\n\n`;
        if (data.name && data.display_name && data.name !== data.display_name) md += `- **Name**: ${data.name}\n`;
        md += `- **Type**: ${data.type || ""}${data.subtype ? ` / ${data.subtype}` : ""}\n`;
        md += `- **Balance**: ${formatMoney(data.balance)} ${data.currency}\n`;
        if (data.institution_name) md += `- **Institution**: ${data.institution_name}\n`;
        if (data.status) md += `- **Status**: ${data.status}\n`;
        if (data.last_import) md += `- **Last Imported**: ${data.last_import}\n`;
        return md;
    }

    // --- Budget Settings ---
    if (data.start_day_of_month !== undefined) {
        let md = "### Budget Settings\n\n";
        md += `- **Start Day of Month**: ${data.start_day_of_month}\n`;
        md += `- **Show Rollover**: ${data.show_rollover ? "Yes" : "No"}\n`;
        if (data.currency) md += `- **Currency**: ${data.currency}\n`;
        return md;
    }

    // --- Budget Settings ---
    // GET /budgets/settings returns the budgeting-period and display config.
    // Distinctive keys (budget_period_granularity + budget_income_option) gate
    // this branch so it can't collide with any other payload.
    if (data.budget_period_granularity !== undefined && data.budget_income_option !== undefined) {
        const qty = data.budget_period_quantity;
        const period = qty !== undefined && qty !== null
            ? `every ${qty} ${data.budget_period_granularity}${qty === 1 ? "" : "s"}`
            : data.budget_period_granularity;
        let md = "### Budget Settings\n\n";
        md += `- **Period**: ${period}\n`;
        if (data.budget_period_anchor_date) md += `- **Anchor Date**: ${data.budget_period_anchor_date}\n`;
        md += `- **Income Basis**: ${data.budget_income_option}\n`;
        if (data.budget_rollover_left_to_budget !== undefined) md += `- **Roll Over Left to Budget**: ${data.budget_rollover_left_to_budget ? "Yes" : "No"}\n`;
        if (data.budget_hide_no_activity !== undefined) md += `- **Hide Categories With No Activity**: ${data.budget_hide_no_activity ? "Yes" : "No"}\n`;
        if (data.budget_use_last_day_of_month !== undefined) md += `- **Use Last Day of Month**: ${data.budget_use_last_day_of_month ? "Yes" : "No"}\n`;
        return md;
    }

    // --- Transaction Attachment URL ---
    // The real GET /transactions/attachments/{file_id} returns only
    // { url, expires_at } (see OpenAPI). Gate on `url` alone; file_name/file_id
    // are not part of the response but are displayed if a caller ever supplies
    // them. expires_at tells the user when the signed url stops working, so it
    // is surfaced explicitly.
    if (data.url !== undefined && data.transactions === undefined) {
        let md = "### Transaction Attachment\n\n";
        if (data.file_name) md += `- **File**: ${data.file_name}\n`;
        if (data.file_id) md += `- **File ID**: ${data.file_id}\n`;
        md += `- **URL**: ${data.url}\n`;
        if (data.expires_at) md += `- **Expires**: ${data.expires_at}\n`;
        return md;
    }

    // 1. Transactions List
    if (data.transactions && Array.isArray(data.transactions)) {
        if (data.transactions.length === 0) return "No transactions found.";
        // Only surface Tags/Notes columns when the enriched/underlying data
        // actually carries them, so the default output stays compact.
        const showTags = data.transactions.some(t => (Array.isArray(t.tag_names) && t.tag_names.length > 0) || (Array.isArray(t.tags) && t.tags.length > 0));
        const showNotes = data.transactions.some(t => t.notes);
        let md = "### Transactions\n\n";
        md += `| ID | Date | Payee | Amount | Currency | Category | Status${showTags ? " | Tags" : ""}${showNotes ? " | Notes" : ""} |\n`;
        md += `| --- | --- | --- | --- | --- | --- | ---${showTags ? " | ---" : ""}${showNotes ? " | ---" : ""} |\n`;
        for (const t of data.transactions) {
            // Prefer a resolved name; otherwise mark a bare id with "#" so the
            // cell reads as an id reference (e.g. "#83") rather than a mystery
            // number under the "Category" header. Matches the single-detail view.
            const cat = t.category_name
                || (t.category_id != null ? `#${t.category_id}` : "Uncategorized");
            let row = `| ${t.id} | ${t.date} | ${t.payee || ""} | ${formatMoney(t.amount)} | ${t.currency} | ${cat} | ${t.status}`;
            if (showTags) {
                const names = (Array.isArray(t.tag_names) && t.tag_names.length > 0)
                    ? t.tag_names
                    : (Array.isArray(t.tags) ? t.tags.map(tag => tag && tag.name).filter(Boolean) : []);
                row += ` | ${names.join(", ")}`;
            }
            if (showNotes) row += ` | ${t.notes || ""}`;
            md += row + " |\n";
        }
        if (data.has_more) {
            md += "\n*Note: There are more transactions available (has_more: true).*";
        }
        return md;
    }
    
    // 2. Transaction Detail (Single)
    if (data.id && data.amount !== undefined && data.date !== undefined && (data.payee !== undefined || data.original_name !== undefined)) {
        let md = `### Transaction #${data.id}\n\n`;
        md += `- **Date**: ${data.date}\n`;
        md += `- **Payee**: ${data.payee || ""}\n`;
        if (data.original_name) md += `- **Original Name**: ${data.original_name}\n`;
        md += `- **Amount**: ${formatMoney(data.amount)} ${data.currency}\n`;
        md += `- **Status**: ${data.status}\n`;
        if (data.category_name) md += `- **Category**: ${data.category_name} (${data.category_id})\n`;
        else if (data.category_id) md += `- **Category ID**: ${data.category_id}\n`;
        if (data.notes) md += `- **Notes**: ${data.notes}\n`;
        if (data.tags && data.tags.length > 0) {
            md += `- **Tags**: ${data.tags.map(t => t.name).join(", ")}\n`;
        }
        return md;
    }

    // 3. Accounts List
    if (data.manual || data.synced) {
        let md = "### Accounts\n\n";
        if (data.manual && data.manual.length > 0) {
            md += "#### Manual Accounts\n\n";
            md += "| ID | Name | Type | Balance | Currency |\n";
            md += "| --- | --- | --- | --- | --- |\n";
            for (const a of data.manual) {
                md += `| ${a.id} | ${a.name} | ${a.type} | ${formatMoney(a.balance)} | ${a.currency} |\n`;
            }
            md += "\n";
        }
        if (data.synced && data.synced.length > 0) {
            md += "#### Plaid Synced Accounts\n\n";
            md += "| ID | Name | Institution | Balance | Currency | Last Imported |\n";
            md += "| --- | --- | --- | --- | --- | --- |\n";
            for (const a of data.synced) {
                md += `| ${a.id} | ${a.name} | ${a.institution_name || ""} | ${formatMoney(a.balance)} | ${a.currency} | ${a.last_import || ""} |\n`;
            }
        }
        return md;
    }

    // 4. Categories List
    if (data.categories && Array.isArray(data.categories) && data.aligned === undefined) {
        if (data.categories.length === 0) return "No categories found.";
        let md = "### Categories\n\n";
        md += "| ID | Name | Group? | Group ID | Description |\n";
        md += "| --- | --- | --- | --- | --- |\n";
        // Render the full nested structure: a group's subcategories live in its
        // children[] and are shown as indented rows beneath it. The flattened
        // format carries no children, so this degrades to a flat list. Recursion
        // handles arbitrary depth even though LM nests only one level today.
        const renderCategoryRow = (c, depth) => {
            const indent = depth > 0 ? "\u00a0\u00a0\u00a0\u00a0\u21b3 " : "";
            md += `| ${c.id} | ${indent}${c.name} | ${c.is_group ? "Yes" : "No"} | ${c.group_id || ""} | ${c.description || ""} |\n`;
            if (Array.isArray(c.children)) {
                for (const child of c.children) renderCategoryRow(child, depth + 1);
            }
        };
        for (const c of data.categories) renderCategoryRow(c, 0);
        return md;
    }

    // 5. Tags List
    if (data.tags && Array.isArray(data.tags)) {
        if (data.tags.length === 0) return "No tags found.";
        let md = "### Tags\n\n";
        md += "| ID | Name | Description |\n";
        md += "| --- | --- | --- |\n";
        for (const t of data.tags) {
            md += `| ${t.id} | ${t.name} | ${t.description || ""} |\n`;
        }
        return md;
    }

    // 6. Budget Summary
    if (data.categories && data.aligned !== undefined) {
        let md = "### Budget Summary\n\n";
        md += "| Category | Budgeted | Actual Activity | Available |\n";
        md += "| --- | --- | --- | --- |\n";
        for (const item of data.categories) {
            // The API's summary categories carry only category_id; category_name
            // is enriched by the get_budget_summary handler from a parallel
            // /categories fetch. That fetch is best-effort, so fall back to the
            // bare id if enrichment was unavailable.
            const catIdentifier = item.category_name ? `${item.category_name} (${item.category_id})` : `#${item.category_id}`;
            const budgeted = item.totals.budgeted !== null && item.totals.budgeted !== undefined ? formatMoney(item.totals.budgeted) : "Not set";
            // Sum activity in integer cents to avoid float drift (e.g. 43.360000000000014).
            const actual = formatMoney(addMoney(item.totals.other_activity, item.totals.recurring_activity));
            const available = item.totals.available !== null && item.totals.available !== undefined ? formatMoney(item.totals.available) : "";
            md += `| ${catIdentifier} | ${budgeted} | ${actual} | ${available} |\n`;
        }
        // Overall totals (present when include_totals is set, which is the
        // default). The API returns inflow/outflow groups; surface the headline
        // numbers as a footer so the markdown reflects the same rollup the JSON
        // carries. Each group's "activity" is other_activity + recurring_activity
        // (summed in integer cents to avoid float drift).
        if (data.totals && typeof data.totals === "object") {
            const groupTotal = g => (g && typeof g === "object")
                ? formatMoney(addMoney(g.other_activity, g.recurring_activity))
                : null;
            const inflow = groupTotal(data.totals.inflow);
            const outflow = groupTotal(data.totals.outflow);
            if (inflow !== null || outflow !== null) {
                md += "\n**Totals**\n\n";
                if (inflow !== null) md += `- **Inflow activity**: ${inflow}\n`;
                if (outflow !== null) md += `- **Outflow activity**: ${outflow}\n`;
                const unc = data.totals.outflow && data.totals.outflow.uncategorized;
                const uncCount = data.totals.outflow && data.totals.outflow.uncategorized_count;
                if (unc !== null && unc !== undefined && Number(unc) !== 0) {
                    md += `- **Uncategorized outflow**: ${formatMoney(unc)}${uncCount ? ` (${uncCount} txn${uncCount === 1 ? "" : "s"})` : ""}\n`;
                }
            }
        }
        return md;
    }

    // 7. Single Category
    if (data.id && data.name && data.exclude_from_budget !== undefined) {
        let md = `### Category: ${data.name} (#${data.id})\n\n`;
        md += `- **Description**: ${data.description || "None"}\n`;
        md += `- **Is Group**: ${data.is_group ? "Yes" : "No"}\n`;
        if (data.group_id) md += `- **Group ID**: ${data.group_id}\n`;
        md += `- **Exclude from Budget**: ${data.exclude_from_budget ? "Yes" : "No"}\n`;
        md += `- **Exclude from Totals**: ${data.exclude_from_totals ? "Yes" : "No"}\n`;
        return md;
    }

    // 8. Single Tag
    if (data.id && data.name && data.background_color !== undefined) {
        let md = `### Tag: ${data.name} (#${data.id})\n\n`;
        if (data.description) md += `- **Description**: ${data.description}\n`;
        return md;
    }

    // 9. Current User
    if (data.name && data.email && data.account_id !== undefined) {
        let md = `### User Profile: ${data.name}\n\n`;
        md += `- **Email**: ${data.email}\n`;
        md += `- **Account ID**: ${data.account_id}\n`;
        md += `- **Budget Name**: ${data.budget_name}\n`;
        md += `- **Primary Currency**: ${data.primary_currency}\n`;
        return md;
    }

    return "";
}

const mcpResponse = {
    success: (data) => {
        const cleaned = cleanObject(data) || {};
        const markdown = generateMarkdown(cleaned);
        return {
            content: [{ type: "text", text: JSON.stringify(cleaned) }],
            _mcp_raw_data: cleaned,
            ...(markdown && { _mcp_markdown: markdown })
        };
    },
    error: (msg) => ({ content: [{ type: "text", text: `Error processing operation: ${msg}` }], isError: true })
};

// ==========================================
// 4. DELEGATION HANDLERS
// ==========================================
const toolHandlers = {
    "clear_cache": async () => {
        // Also drop any in-flight fetch promise. Nulling only data/lastFetched
        // leaves a pending single-flight promise that resolves AFTER the clear
        // and silently repopulates the cache, so the clear would not stick under
        // concurrency (proven via live race probe). Dropping the promise detaches
        // that resolution: it still settles for its awaiters but no longer writes
        // back into the (already cleared) cache slot.
        for (const c of [accountsCache, categoriesCache, tagsCache]) {
            c.data = null;
            c.lastFetched = 0;
            c.promise = null;
            c.generation++;
        }
        return mcpResponse.success({ message: "Internal memory cache cleared successfully." });
    },

    "get_current_user": async () => {
        const { status, body } = await nativeFetch("/me", "GET", LM_API_TOKEN);
        if (status !== 200) return mcpResponse.error(`Failed to load user: ${extractError(body, status)}`);
        return mcpResponse.success(body);
    },

    "get_transaction": async (args) => {
        const { id } = args || {};
        if (!id) return mcpResponse.error("Missing required parameter 'id'");
        const safeId = encodeURIComponent(String(id));
        const { status, body } = await nativeFetch(`/transactions/${safeId}`, "GET", LM_API_TOKEN);
        if (status !== 200) return mcpResponse.error(`Failed lookup (Status ${status}): ${extractError(body, status)}`);
        // Resolve category_id -> category_name so a single-transaction drill-down
        // is not less informative in MARKDOWN than the list row it came from
        // (list_transactions resolves names by default). One cached lookup. The
        // resolved name is passed as a markdown-only source so the JSON output
        // stays a faithful passthrough of the raw API body.
        if (body && body.category_id != null) {
            const categories = await getCategoriesData(LM_API_TOKEN).catch(() => []);
            const name = buildCategoryNameMap(categories).get(body.category_id);
            if (name) return mcpResponse.success(body, { ...body, category_name: name });
        }
        return mcpResponse.success(body);
    },

    "get_category": async (args) => {
        const { id } = args || {};
        if (!id) return mcpResponse.error("Missing required parameter 'id'");
        const safeId = encodeURIComponent(String(id));
        const { status, body } = await nativeFetch(`/categories/${safeId}`, "GET", LM_API_TOKEN);
        
        // Defensively handling standard 200 and spec-indicated 201 response statuses
        if (status !== 200 && status !== 201) {
            return mcpResponse.error(`Category load failure (Status ${status}): ${extractError(body, status)}`);
        }
        return mcpResponse.success(body);
    },

    "get_categories_by_ids": async (args) => {
        const { ids } = args || {};
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return mcpResponse.error("Missing or invalid parameter 'ids'. Must be a non-empty array of integers.");
        }
        const categories = await getCategoriesData(LM_API_TOKEN).catch(() => []);
        const idSet = new Set(ids.map(Number));
        // Subcategories live in a parent group's children[], so filter the
        // flattened list — a top-level-only filter silently drops child ids.
        const filtered = flattenCategories(categories).filter(c => idSet.has(c.id));
        // Strip children[] from each result: the categories renderer recurses
        // into children[] and would re-expand a requested group's subcategories
        // as extra rows that were NOT in `ids`, breaking the by-ids contract
        // (e.g. asking for [83,84,315174] returned 6 rows). A requested child
        // already appears as its own row via the flatten above. Shallow-clone
        // so we never mutate the shared categories cache.
        const stripped = filtered.map(({ children, ...rest }) => rest);
        return mcpResponse.success({ categories: stripped });
    },

    "get_tag": async (args) => {
        const { id } = args || {};
        if (!id) return mcpResponse.error("Missing required parameter 'id'");
        const safeId = encodeURIComponent(String(id));
        const { status, body } = await nativeFetch(`/tags/${safeId}`, "GET", LM_API_TOKEN);
        if (status !== 200 && status !== 201) return mcpResponse.error(`Tag lookup failure (Status ${status}): ${extractError(body, status)}`);
        return mcpResponse.success(body);
    },

    "get_tags_by_ids": async (args) => {
        const { ids } = args || {};
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return mcpResponse.error("Missing or invalid parameter 'ids'. Must be a non-empty array of integers.");
        }
        const tags = await getTagsData(LM_API_TOKEN).catch(() => []);
        const idSet = new Set(ids.map(Number));
        const filtered = tags.filter(t => idSet.has(t.id));
        return mcpResponse.success({ tags: filtered });
    },

    "get_account": async (args) => {
        const { id } = args || {};
        if (!id) return mcpResponse.error("Missing required parameter 'id'");
        const safeId = encodeURIComponent(String(id));
        
        const mRes = await nativeFetch(`/manual_accounts/${safeId}`, "GET", LM_API_TOKEN);
        if (mRes.status === 200) return mcpResponse.success({ ...mRes.body, _mcp_context_type: "manual" });
        
        const pRes = await nativeFetch(`/plaid_accounts/${safeId}`, "GET", LM_API_TOKEN);
        if (pRes.status === 200) return mcpResponse.success({ ...pRes.body, _mcp_context_type: "plaid" });
        
        return mcpResponse.error(`Account not found matching identifier across endpoints: ${id}`);
    },

    "get_manual_account": async (args) => {
        const { id } = args || {};
        if (!id) return mcpResponse.error("Missing required parameter 'id'");
        const safeId = encodeURIComponent(String(id));
        const { status, body } = await nativeFetch(`/manual_accounts/${safeId}`, "GET", LM_API_TOKEN);
        if (status !== 200) return mcpResponse.error(`Manual account fetch error: ${extractError(body, status)}`);
        return mcpResponse.success(body);
    },

    "get_plaid_account": async (args) => {
        const { id } = args || {};
        if (!id) return mcpResponse.error("Missing required parameter 'id'");
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
        
        if (args && args.format === "flattened" && body && Array.isArray(body.categories)) {
            body.categories = body.categories.map(c => ({
                ...c,
                children: null
            }));
        }
        
        return mcpResponse.success(body);
    },

    "list_tags": async () => {
        const { status, body } = await nativeFetch("/tags", "GET", LM_API_TOKEN);
        if (status !== 200) return mcpResponse.error(`Error retrieving tags: ${extractError(body, status)}`);
        // Handle if body is already wrapped or is a raw array, unpack to ensure clean shape
        const tagsArray = body && body.tags ? body.tags : (Array.isArray(body) ? body : []);
        return mcpResponse.success({ tags: tagsArray });
    },

    "list_recurring_items": async (args) => {
        const cleanArgs = {};
        if (args && args.start_date !== undefined) cleanArgs.start_date = args.start_date;
        if (args && args.end_date !== undefined) cleanArgs.end_date = args.end_date;
        if (args && args.include_suggested !== undefined) cleanArgs.include_suggested = args.include_suggested;

        // If the user specified status === "suggested", we must ensure include_suggested is true
        if (args && args.status === "suggested" && cleanArgs.include_suggested === undefined) {
            cleanArgs.include_suggested = true;
        }

        const { status: fetchStatus, body } = await nativeFetch(`/recurring_items${buildQueryString(cleanArgs)}`, "GET", LM_API_TOKEN);
        if (fetchStatus !== 200) return mcpResponse.error(`Failed retrieving recurring items: ${extractError(body, fetchStatus)}`);
        
        let result = body.recurring_items || [];
        if (args && args.status !== undefined) {
            const statusFilter = args.status;
            result = result.filter(item => {
                if (statusFilter === "suggested") {
                    return item.status === "suggested";
                } else if (statusFilter === "manual" || statusFilter === "reviewed") {
                    return item.status === "reviewed";
                }
                return true;
            });
        }
        
        return mcpResponse.success({ recurring_items: result });
    },

    "get_recurring_item": async (args) => {
        const { id, start_date, end_date } = args || {};
        if (!id) return mcpResponse.error("Missing required parameter 'id'");
        const safeId = encodeURIComponent(String(id));
        const cleanArgs = {};
        if (start_date) cleanArgs.start_date = start_date;
        if (end_date) cleanArgs.end_date = end_date;

        const { status, body } = await nativeFetch(`/recurring_items/${safeId}${buildQueryString(cleanArgs)}`, "GET", LM_API_TOKEN);
        if (status !== 200) return mcpResponse.error(`Failed retrieving recurring item with ID ${id}: ${extractError(body, status)}`);
        // Resolve the effective category id (override wins over criteria) to a
        // name for the MARKDOWN view, mirroring the transaction detail view. The
        // resolved name is passed as a markdown-only source so the JSON output
        // stays a faithful passthrough of the raw API body. Renderer reads
        // data.category_name.
        if (body) {
            const tc = body.transaction_criteria || {};
            const ov = body.overrides || {};
            const catId = ov.category_id != null ? ov.category_id : tc.category_id;
            if (catId != null) {
                const categories = await getCategoriesData(LM_API_TOKEN).catch(() => []);
                const name = buildCategoryNameMap(categories).get(catId);
                if (name) return mcpResponse.success(body, { ...body, category_name: name });
            }
        }
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

        const [summaryRes, categoriesRes] = await Promise.all([
            nativeFetch(`/summary${buildQueryString(apiArgs)}`, "GET", LM_API_TOKEN),
            nativeFetch("/categories", "GET", LM_API_TOKEN).catch(() => null)
        ]);

        if (summaryRes.status !== 200) {
            return mcpResponse.error(`Failed parsing budget summary: ${extractError(summaryRes.body, summaryRes.status)}`);
        }

        const body = summaryRes.body;

        // Build category map if available to resolve category IDs to names
        let categoryMap = new Map();
        if (categoriesRes && (categoriesRes.status === 200 || categoriesRes.status === 201) && categoriesRes.body && Array.isArray(categoriesRes.body.categories)) {
            // Flatten parents + children: budget rows are keyed by child id.
            categoryMap = buildCategoryNameMap(categoriesRes.body.categories);
        }

        // Resolve names in categories array
        if (body && Array.isArray(body.categories)) {
            body.categories = body.categories.map(item => {
                if (item.category_id && categoryMap.has(item.category_id)) {
                    return {
                        ...item,
                        category_name: categoryMap.get(item.category_id)
                    };
                }
                return item;
            });
        }

        return mcpResponse.success(body);
    },

    "list_transactions": async (args) => {
        const { timeframe, search, include_category_names, include_tag_names, category_ids, category_group_id } = args || {};
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

        // Resolve child categories if filtering by group
        let matchingCategoryIds = null;
        if (category_group_id !== undefined) {
            const categories = await getCategoriesData(LM_API_TOKEN).catch(() => []);
            matchingCategoryIds = new Set();
            matchingCategoryIds.add(category_group_id);
            for (const cat of categories) {
                if (cat.group_id === category_group_id) {
                    matchingCategoryIds.add(cat.id);
                }
            }
        }

        // Handle array of category IDs
        if (category_ids && Array.isArray(category_ids) && category_ids.length > 0) {
            if (matchingCategoryIds === null) {
                matchingCategoryIds = new Set(category_ids.map(Number));
            } else {
                // Intersect with existing group filter
                const newSet = new Set();
                for (const cid of category_ids) {
                    const numCid = Number(cid);
                    if (matchingCategoryIds.has(numCid)) {
                        newSet.add(numCid);
                    }
                }
                matchingCategoryIds = newSet;
            }
        }

        // If filtering by categories result in an empty set, short-circuit
        if (matchingCategoryIds !== null && matchingCategoryIds.size === 0) {
            return mcpResponse.success({
                transactions: [],
                has_more: false
            });
        }

        // Optimize single category ID matching to allow remote DB filtering
        if (matchingCategoryIds !== null && matchingCategoryIds.size === 1) {
            apiArgs.category_id = Array.from(matchingCategoryIds)[0];
        }

        // Decide if we need to do server-side category filtering
        const serverSideFiltering = matchingCategoryIds !== null && !apiArgs.category_id;
        
        const apiLimit = apiArgs.limit;
        const apiOffset = apiArgs.offset;
        
        const needsInMemoryFiltering = serverSideFiltering || !!search;

        let allTransactions = [];
        let finalHasMore = false;

        if (needsInMemoryFiltering) {
            let currentOffset = 0;
            const batchLimit = 2000;

            // Remove pagination fields from root arguments since we will manage them in the loop
            delete apiArgs.limit;
            delete apiArgs.offset;

            let pagesFetched = 0;
            const maxPages = 25; // Safety cap of 50,000 transactions to prevent runaway loops

            while (pagesFetched < maxPages) {
                const queryArgs = {
                    ...apiArgs,
                    limit: batchLimit,
                    offset: currentOffset
                };

                const { status, body } = await nativeFetch(`/transactions${buildQueryString(queryArgs)}`, "GET", LM_API_TOKEN);
                if (status !== 200) return mcpResponse.error(`Transactions retrieval error: ${extractError(body, status)}`);

                const fetched = body.transactions || [];
                allTransactions = allTransactions.concat(fetched);
                pagesFetched++;

                if (!body.has_more || fetched.length < batchLimit) {
                    break;
                }
                currentOffset += fetched.length;
            }
        } else {
            // Native path: clamp values and query once
            const requestedLimit = apiArgs.limit !== undefined ? apiArgs.limit : 1000;
            apiArgs.limit = Math.max(1, Math.min(requestedLimit, 2000));

            const { status, body } = await nativeFetch(`/transactions${buildQueryString(apiArgs)}`, "GET", LM_API_TOKEN);
            if (status !== 200) return mcpResponse.error(`Transactions retrieval error: ${extractError(body, status)}`);

            allTransactions = body.transactions || [];
            finalHasMore = body.has_more || false;
        }

        let result = allTransactions;

        // Filter in-memory by category IDs if server-side filtering is active
        if (serverSideFiltering) {
            result = result.filter(t => t.category_id !== null && t.category_id !== undefined && matchingCategoryIds.has(t.category_id));
        }

        // Filter in-memory by search term
        if (search) {
            const query = String(search).toLowerCase();
            result = result.filter(t => 
                (t.payee && t.payee.toLowerCase().includes(query)) || 
                (t.notes && t.notes.toLowerCase().includes(query)) || 
                (t.original_name && t.original_name.toLowerCase().includes(query))
            );
        }

        // Apply pagination parameters in-memory if we did in-memory filtering
        if (needsInMemoryFiltering) {
            const requestedOffset = apiOffset || 0;
            const requestedLimit = apiLimit !== undefined ? apiLimit : 1000;
            const slicedResult = result.slice(requestedOffset, requestedOffset + requestedLimit);

            finalHasMore = (requestedOffset + requestedLimit < result.length);
            result = slicedResult;
        }

        // Resolve and join category and/or tag names if requested (Optimized: done after slicing)
        if (include_category_names || include_tag_names) {
            let categoryMap = null;
            let tagMap = null;

            if (include_category_names) {
                const categories = await getCategoriesData(LM_API_TOKEN).catch(() => []);
                // Walk children too: most transactions reference a subcategory id.
                categoryMap = buildCategoryNameMap(categories);
            }

            if (include_tag_names) {
                const tags = await getTagsData(LM_API_TOKEN).catch(() => []);
                tagMap = new Map(tags.map(t => [t.id, t]));
            }

            for (const t of result) {
                if (include_category_names && t.category_id !== null && t.category_id !== undefined) {
                    t.category_name = categoryMap?.get(t.category_id) || null;
                }
                if (include_tag_names && t.tag_ids && Array.isArray(t.tag_ids)) {
                    t.tags = t.tag_ids.map(id => tagMap?.get(id)).filter(Boolean);
                    t.tag_names = t.tags.map(tag => tag.name);
                }
            }
        }

        return mcpResponse.success({
            transactions: result,
            has_more: finalHasMore
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
const TOOLS = [
    { 
        name: "clear_cache", 
        description: "Clear the cached accounts data.", 
        inputSchema: { type: "object", properties: {} } 
    },
    { 
        name: "get_current_user", 
        description: "Get the current user's profile information.", 
        inputSchema: { type: "object", properties: {} } 
    },
    { 
        name: "get_transaction", 
        description: "Get details of a single transaction by ID.", 
        inputSchema: { 
            type: "object", 
            properties: { 
                id: { type: "integer", description: "The unique transaction ID." } 
            }, 
            required: ["id"] 
        } 
    },
    { 
        name: "get_category", 
        description: "Get details of a single category by ID.", 
        inputSchema: { 
            type: "object", 
            properties: { 
                id: { type: "integer", description: "The unique category ID." } 
            }, 
            required: ["id"] 
        } 
    },
    { 
        name: "get_categories_by_ids", 
        description: "Get details for a specific subset of categories by their IDs.", 
        inputSchema: { 
            type: "object", 
            properties: { 
                ids: { 
                    type: "array", 
                    items: { type: "integer" }, 
                    description: "An array of category IDs to resolve." 
                } 
            }, 
            required: ["ids"] 
        } 
    },
    { 
        name: "get_tag", 
        description: "Get details of a single tag by ID.", 
        inputSchema: { 
            type: "object", 
            properties: { 
                id: { type: "integer", description: "The unique tag ID." } 
            }, 
            required: ["id"] 
        } 
    },
    { 
        name: "get_tags_by_ids", 
        description: "Get details for a specific subset of tags by their IDs.", 
        inputSchema: { 
            type: "object", 
            properties: { 
                ids: { 
                    type: "array", 
                    items: { type: "integer" }, 
                    description: "An array of tag IDs to resolve." 
                } 
            }, 
            required: ["ids"] 
        } 
    },
    { 
        name: "get_recurring_item", 
        description: "Get details of a recurring transaction item by ID.", 
        inputSchema: { 
            type: "object", 
            properties: { 
                id: { type: "integer", description: "The unique recurring item ID." },
                start_date: { type: "string", format: "date", description: "Start date for calculating occurrences (YYYY-MM-DD)." },
                end_date: { type: "string", format: "date", description: "End date for calculating occurrences (YYYY-MM-DD)." }
            }, 
            required: ["id"],
            dependencies: {
                start_date: ["end_date"],
                end_date: ["start_date"]
            }
        } 
    },
    { 
        name: "get_manual_account", 
        description: "Get details of a manual account by ID.", 
        inputSchema: { 
            type: "object", 
            properties: { 
                id: { type: "integer", description: "The unique manual account ID." } 
            }, 
            required: ["id"] 
        } 
    },
    { 
        name: "get_plaid_account", 
        description: "Get details of a Plaid-synced account by ID.", 
        inputSchema: { 
            type: "object", 
            properties: { 
                id: { type: "integer", description: "The unique Plaid account ID." } 
            }, 
            required: ["id"] 
        } 
    },
    { 
        name: "get_account", 
        description: "Get details of an account by ID, checking both manual and Plaid-synced accounts.", 
        inputSchema: { 
            type: "object", 
            properties: { 
                id: { type: "integer", description: "The unique account ID." } 
            }, 
            required: ["id"] 
        } 
    },
    {
        name: "list_transactions",
        description: "List transactions. Note: Filtering by search, category_ids, or category_group_id uses recursive fetching. Use a timeframe to avoid rate limits.",
        inputSchema: {
            type: "object",
            properties: {
                start_date: { type: "string", format: "date", description: "Start date to filter transactions (YYYY-MM-DD)." }, 
                end_date: { type: "string", format: "date", description: "End date to filter transactions (YYYY-MM-DD)." },
                timeframe: { type: "string", enum: ["this_month", "last_month", "year_to_date", "this_year", "last_year"], description: "Predefined timeframe filter (e.g., this_month, last_month)." },
                created_since: { type: "string", description: "Filter transactions created after this timestamp (ISO 8601)." },
                updated_since: { type: "string", description: "Filter transactions updated after this timestamp (ISO 8601)." },
                manual_account_id: { type: "integer", description: "Filter by manual account ID." }, 
                plaid_account_id: { type: "integer", description: "Filter by Plaid-synced account ID." }, 
                recurring_id: { type: "integer", description: "Filter by recurring transaction ID." },
                category_id: { type: "integer", description: "Filter by category ID." }, 
                category_ids: { 
                    type: "array", 
                    items: { type: "integer" }, 
                    description: "Filter by multiple category IDs." 
                },
                category_group_id: { 
                    type: "integer", 
                    description: "Filter by parent category group ID (includes child categories)." 
                },
                tag_id: { type: "integer", description: "Filter by tag ID." },
                is_group_parent: { type: "boolean", description: "Filter to return only parent transactions of a group." },
                status: { type: "string", enum: ["reviewed", "unreviewed", "delete_pending"], description: "Filter by transaction status." },
                is_pending: { type: "boolean", description: "Filter for pending transactions." }, 
                include_pending: { type: "boolean", default: false, description: "Include pending transactions in the results." },
                include_metadata: { type: "boolean", default: false, description: "Include developer metadata in the response." },
                include_split_parents: { type: "boolean", default: false, description: "Include parent transactions of split transactions." }, 
                include_group_children: { type: "boolean", default: false, description: "Include child transactions of group transactions." }, 
                include_children: { type: "boolean", default: false, description: "Include child transactions of split transactions in the response." },
                include_files: { type: "boolean", default: false, description: "Include file attachment metadata." },
                limit: { type: "integer", minimum: 1, maximum: 2000, default: 1000, description: "Maximum number of transactions to return (1-2000)." }, 
                offset: { type: "integer", minimum: 0, description: "Number of transactions to skip for pagination." },
                search: { type: "string", maxLength: 100, description: "Search term matched against payee, notes, or original name (max 100 chars)." },
                include_category_names: { 
                    type: "boolean", 
                    default: false, 
                    description: "Resolve and include category_name." 
                },
                include_tag_names: { 
                    type: "boolean", 
                    default: false, 
                    description: "Resolve and include tags and tag_names." 
                }
            },
            oneOf: [
                {
                    required: ["timeframe"],
                    not: {
                        anyOf: [
                            { required: ["start_date"] },
                            { required: ["end_date"] }
                        ]
                    }
                },
                {
                    not: { required: ["timeframe"] }
                }
            ]
        }
    },
    { 
        name: "list_tags", 
        description: "List all custom tags.", 
        inputSchema: { type: "object", properties: {} } 
    },
    { 
        name: "list_recurring_items", 
        description: "List recurring transaction items.", 
        inputSchema: { 
            type: "object", 
            properties: { 
                start_date: { type: "string", format: "date", description: "Filter by start date (YYYY-MM-DD)." }, 
                end_date: { type: "string", format: "date", description: "Filter by end date (YYYY-MM-DD)." }, 
                include_suggested: { type: "boolean", description: "Include system-suggested recurring items." },
                status: { type: "string", enum: ["suggested", "manual", "reviewed"], description: "Filter by status: manual/reviewed items, or system-suggested items." }
            } 
        } 
    },
    { 
        name: "get_budget_settings", 
        description: "Get general budget settings including currency.", 
        inputSchema: { type: "object", properties: {} } 
    },
    {
        name: "get_budget_summary",
        description: "Get budget summary with category totals and usage.",
        inputSchema: {
            type: "object",
            properties: {
                start_date: { type: "string", format: "date", description: "Start date for budget summary (YYYY-MM-DD)." }, 
                end_date: { type: "string", format: "date", description: "End date for budget summary (YYYY-MM-DD)." },
                timeframe: { type: "string", enum: ["this_month", "last_month", "year_to_date", "this_year", "last_year"], description: "Predefined timeframe filter (e.g., this_month, last_month)." },
                include_exclude_from_budgets: { type: "boolean", default: false, description: "Include items marked 'exclude from budget'." },
                include_occurrences: { type: "boolean", default: false, description: "Include actual transaction occurrences in the summary." },
                include_past_budget_dates: { type: "boolean", default: false, description: "Include past budget dates." },
                include_totals: { type: "boolean", default: true, description: "Include overall inflow/outflow totals (default true). The canonical \"how am I tracking against budget\" question wants the rollup, so it is included by default to avoid a second call; the totals are summarized in the markdown footer. Set false to omit and return per-category rows only." },
                include_rollover_pool: { type: "boolean", default: false, description: "Include rollover calculations." }
            },
            oneOf: [
                {
                    required: ["timeframe"],
                    not: {
                        anyOf: [
                            { required: ["start_date"] },
                            { required: ["end_date"] }
                        ]
                    }
                },
                {
                    required: ["start_date", "end_date"],
                    not: { required: ["timeframe"] }
                }
            ]
        }
    },
    { 
        name: "list_categories", 
        description: "List all categories.", 
        inputSchema: { 
            type: "object", 
            properties: { 
                format: { type: "string", enum: ["nested", "flattened"], default: "nested", description: "Format of the categories list ('nested' or 'flattened')." }, 
                is_group: { type: "boolean", description: "Filter for category groups." } 
            } 
        } 
    },
    { 
        name: "list_accounts", 
        description: "List all manual and Plaid-synced accounts.", 
        inputSchema: { type: "object", properties: {} } 
    },
    {
        name: "get_transaction_attachment_url",
        description: "Get a temporary download URL for a transaction attachment.",
        inputSchema: {
            type: "object",
            properties: { 
                file_id: { type: "integer", description: "The ID of the attachment file." } 
            },
            required: ["file_id"]
        }
    }
];

// Compile schemas
for (const tool of TOOLS) {
    if (tool.inputSchema) {
        if (!tool.inputSchema.properties) {
            tool.inputSchema.properties = {};
        }
        tool.inputSchema.properties.output_format = {
            type: "string",
            enum: ["markdown", "json"],
            default: "markdown",
            description: "The format of the response output ('markdown' or 'json')."
        };
        validators[tool.name] = ajv.compile(tool.inputSchema);
    }
}

const mcpServer = new Server(
    { name: "lunchmoney-exhaustive-readonly-mcp", version: "2.2.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
});

mcpServer.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
        resources: [
            {
                uri: "lunchmoney://budget/settings",
                name: "Budget Settings",
                description: "General budget settings including primary currency.",
                mimeType: "application/json"
            },
            {
                uri: "lunchmoney://accounts",
                name: "Accounts",
                description: "List of all manual and Plaid-synced accounts.",
                mimeType: "application/json"
            }
        ]
    };
});

mcpServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri === "lunchmoney://budget/settings") {
        const { status, body } = await nativeFetch("/budgets/settings", "GET", LM_API_TOKEN);
        if (status !== 200) {
            throw new Error(`Failed to read budget settings: ${extractError(body, status)}`);
        }
        return {
            contents: [
                {
                    uri,
                    mimeType: "application/json",
                    text: JSON.stringify(cleanObject(body))
                }
            ]
        };
    }
    if (uri === "lunchmoney://accounts") {
        const data = await getAccountsData(LM_API_TOKEN);
        return {
            contents: [
                {
                    uri,
                    mimeType: "application/json",
                    text: JSON.stringify(cleanObject({ manual: data.manual, synced: data.synced }))
                }
            ]
        };
    }
    throw new Error(`Unknown resource URI: ${uri}`);
});

mcpServer.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
        prompts: [
            {
                name: "analyze_spending",
                description: "Analyze spending trends and budget summaries for a given timeframe.",
                arguments: [
                    {
                        name: "timeframe",
                        description: "Timeframe to analyze (e.g. this_month, last_month, year_to_date). Defaults to this_month.",
                        required: false
                    }
                ]
            },
            {
                name: "find_untagged",
                description: "Identify transactions that do not have any tags applied.",
                arguments: []
            }
        ]
    };
});

mcpServer.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === "analyze_spending") {
        const timeframe = args?.timeframe || "this_month";
        return {
            description: "Analyze spending trends",
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `Please analyze my spending trends and budget summary for the timeframe "${timeframe}". Identify areas of high expenditure and compare my actual spending against the budget.`
                    }
                }
            ]
        };
    }
    if (name === "find_untagged") {
        return {
            description: "Identify untagged transactions",
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: "Please search for recent transactions that do not have any tags associated with them and list them. Suggest relevant tags for each of them based on the payee name or category."
                    }
                }
            ]
        };
    }
    throw new Error(`Unknown prompt name: ${name}`);
});

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = toolHandlers[name];
    if (!handler) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown requested capability execution trace: ${name}`);
    }
    
    const validate = validators[name];
    const validArgs = args || {};
    if (validate) {
        const valid = validate(validArgs);
        if (!valid) {
            // Check for timeframe / date mutex validation issues to provide a clear error message
            if (name === "list_transactions" || name === "get_budget_summary") {
                const hasTimeframe = validArgs.timeframe !== undefined;
                const hasStartDate = validArgs.start_date !== undefined;
                const hasEndDate = validArgs.end_date !== undefined;
                
                if (hasTimeframe && (hasStartDate || hasEndDate)) {
                    return mcpResponse.error("Validation failed: You cannot specify both 'timeframe' and 'start_date'/'end_date' simultaneously.");
                }
                if (name === "get_budget_summary" && !hasTimeframe && (!hasStartDate || !hasEndDate)) {
                    return mcpResponse.error("Validation failed: You must specify either 'timeframe' or both 'start_date' and 'end_date'.");
                }
            }

            const errors = validate.errors.map(err => {
                if (err.keyword === 'required') {
                    return `Missing required parameter '${err.params.missingProperty}'`;
                }
                const field = err.instancePath ? err.instancePath.replace(/^\//, '') : '';
                const prefix = field ? `Parameter '${field}' ` : '';
                return `${prefix}${err.message}`;
            }).join('; ');
            return mcpResponse.error(`Validation failed: ${errors}`);
        }
    }

    try {
        const result = await handler(validArgs);
        
        // Format the content based on output_format parameter (defaulting to markdown)
        if (result && result.content) {
            const format = validArgs.output_format || "markdown";
            const hasMarkdown = result._mcp_markdown !== undefined;
            
            if (format === "json" || !hasMarkdown) {
                // Return only JSON text block
                result.content = [{ type: "text", text: JSON.stringify(result._mcp_raw_data || {}) }];
            } else {
                // Return only markdown text block
                result.content = [{ type: "text", text: result._mcp_markdown }];
            }
            
            // Clean up internal properties
            delete result._mcp_raw_data;
            delete result._mcp_markdown;
        }
        
        return result;
    } catch (err) {
        return mcpResponse.error(sanitizeDeep(err));
    }
});

const transport = new StdioServerTransport();

let initialized = false;
const originalConnect = mcpServer.connect.bind(mcpServer);
mcpServer.connect = async (trans) => {
    await originalConnect(trans);
    const sdkOnMessage = trans.onmessage;
    trans.onmessage = (message, extra) => {
        if (message && message.method) {
            if (message.method === 'initialize') {
                initialized = true;
            } else if (!initialized && message.id !== undefined) {
                trans.send({
                    jsonrpc: '2.0',
                    id: message.id,
                    error: {
                        code: -32002,
                        message: 'Server not initialized'
                    }
                }).catch(err => console.error("[MCP Error] Failed to send initialization error response:", err));
                return;
            }
        }
        sdkOnMessage(message, extra);
    };
};

await mcpServer.connect(transport);
console.error("[MCP] Fully Exhaustive Read-Only Server connected via Stdio channels.");
