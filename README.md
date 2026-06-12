# Lunch Money MCP Server (Read-Only)

A lightweight, token-efficient Model Context Protocol (MCP) server for [Lunch Money](https://lunchmoney.dev/), a developer-friendly personal finance and budgeting platform.

This server allows LLMs (like Claude Desktop, Cursor, or other MCP clients) to read and analyze your financial data—including transactions, accounts, categories, and budget summaries—in a secure, **read-only** manner.

> [!TIP]
> **Why Read-Only? (Security & Philosophy)**
>
> Ideally, Lunch Money API keys would be permission-scoped. However, because they currently grant full access to your account, this implementation explicitly omits all write capabilities to provide defense-in-depth security.
>
> Unlike [other Lunch Money MCP servers](https://lunchmoney.app/developers#mcp-servers), this codebase does not offer *any* APIs or tools for tweaking or modifying your data. While you might be comfortable letting LLMs skim through your sensitive financial data to analyze trends, you likely do *not* want a tool-using agent (especially when run with options like `--dangerously-skip-permissions`) to be able to make edits or alter your finances.

---

## Features

- **Read-Only Security**: Only retrieves data (`GET` requests). No destructive or modifying actions are supported.
- **Strict Input Validation**: Uses `ajv` (v8) and `ajv-formats` for validating input arguments against defined tool schemas.
- **MCP Resources**: Exposes system-level data such as accounts list and budget settings directly as MCP resources.
- **MCP Prompts**: Includes handy pre-packaged prompts (`analyze_spending` and `find_untagged`) for spending analysis and tag suggestion.
- **Performance Caching**: In-memory caching for `categories` and `tags` (60s TTL) to minimize redundant external API requests and lower latency.
- **Token Efficient**: Structurally optimized JSON payloads designed to minimize prompt token overhead. Empty arrays, empty objects, null, undefined, and empty string properties are stripped recursively. Highly meaningful boolean states (like `false` for pending status) are preserved.
- **Strict UTC Date Math**: Timeframe resolutions (like `this_month` or `last_year`) are calculated relative to UTC timezone, preventing local timezone offset shifts from altering query boundaries.
- **Flexible Output Formatting**: All tools support a global `output_format` parameter (`"markdown"` or `"json"`). The default `"markdown"` output renders data into clean, readable Markdown tables and bullet points for the LLM.

---

## Prerequisites

- **Node.js**: Version `20.6.0` or higher (utilizes native `process.loadEnvFile`).
- **Lunch Money API Token**: A developer API key. You can generate one in your [Lunch Money Developer Settings](https://lunchmoney.dev/developers).

---

## Installation

1. Clone or copy this repository to your local machine:
   ```bash
   git clone <repository-url>
   cd lunch-money-mcp-ro
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

---

## Configuration

The server requires your Lunch Money API key, set as `LUNCHMONEY_API_KEY`.

You can configure this in two ways:

### 1. Using a `.env` File
Create a `.env` file in the project's root directory:
```env
LUNCHMONEY_API_KEY=your_lunch_money_api_key_here
```

### 2. Environment Variable
Alternatively, set the environment variable when configuring your MCP server:
```json
"lunchmoney-readonly": {
  "command": "node",
  "args": [
    "/path/to/lunch-money-mcp-ro.js"
  ],
  "env": {
    "LUNCHMONEY_API_KEY": "your_lunch_money_api_key_here"
  }
}
```

---

## MCP Resources

The following resources are exposed:

- **`lunchmoney://budget/settings`**: General budget settings including primary currency.
- **`lunchmoney://accounts`**: List of all manual and Plaid-synced accounts.

---

## MCP Prompts

The following prompts are preconfigured:

- **`analyze_spending`**: Analyzes spending trends and budget summaries for a given timeframe.
  - *Arguments*: `timeframe` (string, optional - e.g., `this_month`, `last_month`, `year_to_date`)
- **`find_untagged`**: Identifies transactions that do not have any tags applied and suggests relevant tags.

---

## Available MCP Tools

All tools accept a global parameter:
- `output_format` (string, optional, default: `"markdown"`): Renders response as `"markdown"` (formatted tables/lists) or `"json"`.

### 1. `list_transactions`
Search, filter, and list historical transactions.
- **Arguments**:
  - `start_date` (string, optional): Format `YYYY-MM-DD`
  - `end_date` (string, optional): Format `YYYY-MM-DD`
  - `timeframe` (string, optional): Predefined timeframe (`this_month`, `last_month`, `year_to_date`, `this_year`, `last_year`). Mutually exclusive with `start_date`/`end_date`.
  - `created_since` (string, optional): Filter transactions created after this ISO 8601 timestamp.
  - `updated_since` (string, optional): Filter transactions updated after this ISO 8601 timestamp.
  - `manual_account_id` (integer, optional): Filter by manual account ID.
  - `plaid_account_id` (integer, optional): Filter by Plaid-synced account ID.
  - `recurring_id` (integer, optional): Filter by recurring transaction ID.
  - `category_id` (integer, optional): Filter by single category ID.
  - `category_ids` (array of integers, optional): Filter by multiple category IDs.
  - `category_group_id` (integer, optional): Filter by parent category group ID (resolves to all child categories).
  - `tag_id` (integer, optional): Filter by tag ID.
  - `is_group_parent` (boolean, optional): Filter to return only parent transactions of a group.
  - `status` (string, optional): Filter by transaction status (`reviewed`, `unreviewed`, `delete_pending`).
  - `is_pending` (boolean, optional): Filter for pending transactions.
  - `include_pending` (boolean, optional, default: `false`)
  - `include_metadata` (boolean, optional, default: `false`)
  - `include_split_parents` (boolean, optional, default: `false`)
  - `include_group_children` (boolean, optional, default: `false`)
  - `include_children` (boolean, optional, default: `false`)
  - `include_files` (boolean, optional, default: `false`)
  - `limit` (integer, optional, minimum: `1`, maximum: `2000`, default: `1000`): Maximum transactions to return.
  - `offset` (integer, optional, minimum: `0`): Number of transactions to skip for pagination.
  - `search` (string, optional, max 100 characters): Search term matched against payee, notes, or original name.
  - `include_category_names` (boolean, optional, default: `false`): Resolves and includes `category_name` on each transaction.
  - `include_tag_names` (boolean, optional, default: `false`): Resolves and includes `tag_names` and `tags` objects on each transaction.

### 2. `list_tags`
List all custom tags.
- **Arguments**: None

### 3. `get_tag`
Get details of a single tag by ID.
- **Arguments** (Required):
  - `id` (integer): The unique tag ID.

### 4. `get_tags_by_ids`
Get details for a specific subset of tags by their IDs.
- **Arguments** (Required):
  - `ids` (array of integers): An array of tag IDs to resolve.

### 5. `list_recurring_items`
List recurring transaction items.
- **Arguments** (Optional):
  - `start_date` (string): Format `YYYY-MM-DD`
  - `end_date` (string): Format `YYYY-MM-DD`
  - `include_suggested` (boolean): Include system-suggested recurring items.
  - `status` (string, enum: `["suggested", "manual", "reviewed"]`): Filter by status.

### 6. `get_recurring_item`
Get details of a recurring transaction item by ID.
- **Arguments**:
  - `id` (integer, Required): The unique recurring item ID.
  - `start_date` (string, optional): Start date for calculating occurrences (YYYY-MM-DD).
  - `end_date` (string, optional): End date for calculating occurrences (YYYY-MM-DD).

### 7. `get_budget_settings`
Get general budget settings including currency.
- **Arguments**: None

### 8. `get_budget_summary`
Get budget summary with category totals and usage.
- **Arguments**:
  - `start_date` (string, optional): Start date (Required if `timeframe` is omitted).
  - `end_date` (string, optional): End date (Required if `timeframe` is omitted).
  - `timeframe` (string, optional): Predefined timeframe (`this_month`, `last_month`, `year_to_date`, `this_year`, `last_year`). Mutually exclusive with `start_date`/`end_date`.
  - `include_exclude_from_budgets` (boolean, optional, default: `false`)
  - `include_occurrences` (boolean, optional, default: `false`)
  - `include_past_budget_dates` (boolean, optional, default: `false`)
  - `include_totals` (boolean, optional, default: `false`)
  - `include_rollover_pool` (boolean, optional, default: `false`)

### 9. `list_categories`
List all categories.
- **Arguments** (Optional):
  - `format` (string, enum: `["nested", "flattened"]`, default: `"nested"`): Format of the categories list.
  - `is_group` (boolean): Filter for category groups.

### 10. `get_category`
Get details of a single category by ID.
- **Arguments** (Required):
  - `id` (integer): The unique category ID.

### 11. `get_categories_by_ids`
Get details for a specific subset of categories by their IDs.
- **Arguments** (Required):
  - `ids` (array of integers): An array of category IDs to resolve.

### 12. `list_accounts`
List all manual and Plaid-synced accounts.
- **Arguments**: None

### 13. `get_manual_account`
Get details of a manual account by ID.
- **Arguments** (Required):
  - `id` (integer): The unique manual account ID.

### 14. `get_plaid_account`
Get details of a Plaid-synced account by ID.
- **Arguments** (Required):
  - `id` (integer): The unique Plaid account ID.

### 15. `get_account`
Get details of an account by ID, checking both manual and Plaid-synced accounts.
- **Arguments** (Required):
  - `id` (integer): The unique account ID.

### 16. `get_current_user`
Get the current user's profile information.
- **Arguments**: None

### 17. `get_transaction`
Get details of a single transaction by ID.
- **Arguments** (Required):
  - `id` (integer): The unique transaction ID.

### 18. `get_transaction_attachment_url`
Get a temporary download URL for a transaction attachment.
- **Arguments** (Required):
  - `file_id` (integer): The ID of the attachment file.

### 19. `clear_cache`
Clear the cached accounts data.
- **Arguments**: None
