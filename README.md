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
- **Token Efficient**: Structurally optimized JSON payloads designed to minimize prompt token overhead. Empty arrays, empty objects, null, undefined, and empty string properties are stripped recursively. Highly meaningful boolean states (like `false` for pending status) are preserved.
- **Strict UTC Date Math**: Timeframe resolutions (like `this_month` or `last_year`) are calculated relative to UTC timezone, preventing local timezone offset shifts from altering query boundaries.

---

## Prerequisites

- **Node.js**: Version `20.6.0` or higher (utilizes native `process.loadEnvFile`). If running on Node 18 or 19, a fallback warning is printed and environment variables must be supplied manually.
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

## Available MCP Tools

Once connected, the following tools will be made available to the LLM:

### 1. `list_transactions`
Search, filter, and list historical transactions. Use this to find specific purchases, filter by date ranges, or view recent spending. If 'timeframe' is omitted, provide exact start and end dates.
- **Arguments**:
  - `start_date` (string, optional): Format `YYYY-MM-DD`
  - `end_date` (string, optional): Format `YYYY-MM-DD`
  - `timeframe` (string, optional): Optional timeframe abstraction (`this_month`, `last_month`, `year_to_date`, `this_year`, `last_year`). If provided, start_date and end_date will be automatically calculated.
  - `category_id` (number, optional): Filter by category ID
  - `tag_id` (number, optional): Filter by tag ID
  - `status` (string, optional): Filter by status (`reviewed`, `unreviewed`, `delete_pending`)
  - `is_pending` (boolean, optional): Filter by pending status
  - `limit` (number, optional): Maximum transactions to return (default: `50`, max: `100`). Hard-capped at 100.
  - `offset` (number, optional): Use this for pagination. If a previous request returned 'has_more: true', pass the suggested offset here.
  - `manual_account_id` (number, optional): Filter by manual account ID
  - `plaid_account_id` (number, optional): Filter by Plaid account ID
  - `recurring_id` (number, optional): Filter by recurring item ID
  - `resolve_names` (boolean, optional): If `true`, resolves category and tag IDs to names directly in the response using cached metadata (default: `true`).
  - `search` (string, optional): Filter transactions by payee or notes using a case-insensitive substring match. Note: Search evaluates a maximum of 2000 transactions. To search older records, you MUST specify a narrow start_date and end_date. Search is an expensive client-side operation; to avoid timeouts, always pair it with a narrow 'timeframe' or narrow date boundaries.
  - `fields` (array of strings, optional): Sparse field filtering to minimize payload token size. If omitted, returns a default: `["id", "date", "payee", "amount", "currency", "category_name", "tag_names", "account_name", "is_split_parent", "split_parent_id", "is_group_parent", "group_parent_id", "is_transfer", "is_uncategorized"]`. Pass `["all"]` to get all fields, or specify exact fields.

### 2. `list_tags`
List all tags used to organize and label transactions in the user's account.
- **Arguments**: None

### 3. `get_tag`
Get details of a single tag by its ID, such as its name, description, colors, and archived status.
- **Arguments** (Required):
  - `id` (number): The unique tag identifier

### 4. `list_recurring_items`
List all recurring expenses or income items, along with their schedule parameters and suggested recurring items.
- **Arguments** (Optional):
  - `start_date` (string): Format `YYYY-MM-DD`
  - `end_date` (string): Format `YYYY-MM-DD`
  - `include_suggested` (boolean): If `true`, includes suggested recurring items

### 5. `get_budget_settings`
Get budget settings, including granularity (e.g. monthly), anchor date, rollover behavior, and income options.
- **Arguments**: None

### 6. `get_transaction`
Get full details of a single transaction by its ID, including date, payee, amount, category, tags, notes, and split/group details.
- **Arguments** (Required):
  - `id` (number): The unique transaction identifier

### 7. `get_budget_summary`
Get a summary of the budget for a specific timeframe or date range, showing budgeted and available amounts by category, category totals, and rollover details.
- **Arguments**:
  - `start_date` (string, optional): Format `YYYY-MM-DD` (Required if `timeframe` is omitted)
  - `end_date` (string, optional): Format `YYYY-MM-DD` (Required if `timeframe` is omitted)
  - `timeframe` (string, optional): Pre-defined period (`this_month`, `last_month`, `year_to_date`, `this_year`, `last_year`). Calculates start and end dates automatically.
  - `format` (string, optional): Output shape (`nested` or `flattened`, default: `flattened` for token efficiency)
  - `include_totals` (boolean, optional): Include overall totals (default: `false`)
  - `include_rollover_pool` (boolean, optional): Include rollover pool details (default: `false`)
  - `include_exclude_from_budgets` (boolean, optional): Include budget-excluded categories (default: `false`)
  - `include_occurrences` (boolean, optional): Include occurrence details (default: `false`)
  - `include_past_budget_dates` (boolean, optional): Include past budget dates (default: `false`)
  - `fields` (array of strings, optional): Sparse field filtering for categories. Defaults to `["category_id", "budgeted", "available"]`.

### 8. `list_categories`
List all budgeting categories. Can be returned as a nested tree or a flat list, and can be filtered by whether they are category groups.
- **Arguments** (Optional):
  - `format` (string): Format structure (`nested` or `flattened`, default: `nested`)
  - `is_group` (boolean): Filter by category group status

### 9. `get_category`
Get details of a single budgeting category by its ID, such as its name, group status, and sub-categories.
- **Arguments** (Required):
  - `id` (number): The unique category identifier

### 10. `list_accounts`
List all financial accounts (both manual and Plaid-synced) with their current balances, status, and metadata.
- **Arguments**: None

### 11. `get_manual_account`
Get details of a manual account by its ID, including its current balance, currency, type, and status.
- **Arguments** (Required):
  - `id` (number): The unique manual account identifier

### 12. `get_plaid_account`
Get details of a Plaid-synced bank or credit card account by its ID, including its name, institution, balance, and status.
- **Arguments** (Required):
  - `id` (number): The unique Plaid account identifier

### 13. `get_account`
Get details of a single account by its ID. Automatically detects and handles both manual and Plaid-synced accounts.
- **Arguments** (Required):
  - `id` (number): The unique account identifier

### 14. `get_current_user`
Get profile details for the currently logged-in user, including their name, email, user ID, and primary currency.
- **Arguments**: None
