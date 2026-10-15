#!/bin/sh
set -eu

# ==============================================================================
# Lunch Money Read-Only MCP Server - Alpine Linux (LXC) Deployment Script
# ==============================================================================

# Ensure running as root (standard for container root in an unprivileged LXC)
if [ "$(id -u)" -ne 0 ]; then
    echo "[-] Error: This script must be run as root." >&2
    exit 1
fi

GIT_REPO="${GIT_REPO:-https://github.com/daniel5151/lunch-money-mcp-ro.git}"
GIT_BRANCH="${GIT_BRANCH:-main}"
LOG_DIR="/var/log/lunch-money-mcp-ro"

# Determine app directory: use script's directory if run inside repo, else default to /opt/lunch-money-mcp-ro
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo "")"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ] && [ -f "$SCRIPT_DIR/lunch-money-mcp-ro.js" ]; then
    APP_DIR="$SCRIPT_DIR"
else
    APP_DIR="${APP_DIR:-/opt/lunch-money-mcp-ro}"
fi

echo "==> [1/6] Installing necessary Alpine packages..."
apk update
apk add --no-cache nodejs npm git logrotate curl

# Verify Node.js version >= 20.6.0 (required for native process.loadEnvFile)
NODE_VERSION=$(node -v | sed 's/^v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
NODE_MINOR=$(echo "$NODE_VERSION" | cut -d. -f2)

if [ "$NODE_MAJOR" -lt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -lt 6 ]; }; then
    echo "[-] Error: Node.js version $NODE_VERSION found. Version >= 20.6.0 is required." >&2
    exit 1
fi
echo "[+] Node.js v$NODE_VERSION verified."

echo "==> [2/6] Setting up repository in $APP_DIR..."
if [ ! -d "$APP_DIR" ]; then
    mkdir -p "$APP_DIR"
fi

if [ ! -f "$APP_DIR/package.json" ]; then
    echo "[*] Cloning repository ($GIT_BRANCH)..."
    git clone -b "$GIT_BRANCH" "$GIT_REPO" "$APP_DIR"
elif [ -d "$APP_DIR/.git" ]; then
    echo "[*] Repository already exists at $APP_DIR. Checking for updates..."
    git -C "$APP_DIR" fetch origin "$GIT_BRANCH" || true
fi

echo "==> [3/6] Installing Node dependencies..."
cd "$APP_DIR"
npm ci --omit=dev || npm install --omit=dev

echo "==> [4/6] Initializing .env configuration..."
if [ ! -f "$APP_DIR/.env" ]; then
    echo "[*] Copying .env from .env.example..."
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
    chmod 0600 "$APP_DIR/.env"
else
    echo "[*] Existing $APP_DIR/.env preserved."
fi

# Generate cryptographically secure random secrets if placeholder values exist
if grep -q "generate-a-secure-random-client-secret-here" "$APP_DIR/.env"; then
    echo "[*] Generating random MCP_OAUTH_CLIENT_SECRET..."
    GEN_CLIENT_SECRET=$(node -e 'console.log(crypto.randomBytes(32).toString("hex"))')
    sed -i "s|generate-a-secure-random-client-secret-here|$GEN_CLIENT_SECRET|g" "$APP_DIR/.env"
fi

if grep -q "generate-a-random-64-character-hex-string-here" "$APP_DIR/.env"; then
    echo "[*] Generating random MCP_JWT_SECRET..."
    GEN_JWT_SECRET=$(node -e 'console.log(crypto.randomBytes(32).toString("hex"))')
    sed -i "s|generate-a-random-64-character-hex-string-here|$GEN_JWT_SECRET|g" "$APP_DIR/.env"
fi

echo "==> [5/6] Setting up log rotation..."
mkdir -p "$LOG_DIR"
chmod 0755 "$LOG_DIR"

cat <<EOF > /etc/logrotate.d/lunch-money-mcp-ro
$LOG_DIR/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 root root
    copytruncate
}
EOF
chmod 0644 /etc/logrotate.d/lunch-money-mcp-ro

# Ensure crond is enabled and running so daily logrotate executes
rc-update add crond default >/dev/null 2>&1 || true
rc-service crond start >/dev/null 2>&1 || true

echo "==> [6/6] Installing OpenRC service..."
cat <<EOF > /etc/init.d/lunch-money-mcp-ro
#!/sbin/openrc-run
# OpenRC init script for Lunch Money Read-Only MCP Server

name="lunch-money-mcp-ro"
description="Lunch Money Read-Only MCP Server"

: \${directory:="$APP_DIR"}
: \${logdir:="$LOG_DIR"}

supervisor="supervise-daemon"
command="/usr/bin/node"
command_args="lunch-money-mcp-ro.js --http"

output_log="\$logdir/server.log"
error_log="\$logdir/server.log"

respawn_delay=2
respawn_max=10
respawn_period=60

depend() {
    need net
    after firewall
}

start_pre() {
    checkpath -d -m 0755 "\$directory"
    checkpath -d -m 0755 "\$logdir"
    if [ ! -f "\$directory/.env" ]; then
        eerror "Required configuration \$directory/.env is missing."
        return 1
    fi
}
EOF
chmod 0755 /etc/init.d/lunch-money-mcp-ro

# Enable service on boot
rc-update add lunch-money-mcp-ro default

echo "=============================================================================="
echo "Deployment & Setup Summary"
echo "=============================================================================="

# Extract generated client secret to display for user convenience
CLIENT_ID=$(grep '^MCP_OAUTH_CLIENT_ID=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || echo "gemini-client")
CLIENT_SECRET=$(grep '^MCP_OAUTH_CLIENT_SECRET=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || echo "")

if [ -n "$CLIENT_SECRET" ] && [ "$CLIENT_SECRET" != "generate-a-secure-random-client-secret-here" ]; then
    echo "[+] Security credentials randomly generated and configured in .env:"
    echo "    - MCP_OAUTH_CLIENT_SECRET and MCP_JWT_SECRET were auto-generated."
    echo "    - When connecting Gemini Web as a custom app, use:"
    echo "        OAuth Client ID:     $CLIENT_ID"
    echo "        OAuth Client Secret: $CLIENT_SECRET"
    echo ""
fi

if grep -q "your_lunch_money_api_key_here" "$APP_DIR/.env"; then
    echo "[!] Configuration required before starting the service:"
    echo ""
    echo "    1. Add your Lunch Money API key to .env:"
    echo "       nano $APP_DIR/.env"
    echo ""
    echo "    2. Start the service once configured:"
    echo "       rc-service lunch-money-mcp-ro start"
    echo ""
    echo "    3. View logs with:"
    echo "       tail -f $LOG_DIR/server.log"
else
    echo "[*] Starting lunch-money-mcp-ro service..."
    rc-service lunch-money-mcp-ro restart

    sleep 2
    if curl -sf http://127.0.0.1:3000/health >/dev/null 2>&1; then
        echo "[+] Service started successfully and passed healthcheck on port 3000!"
    else
        echo "[*] Service started. Check logs: tail -n 30 $LOG_DIR/server.log"
    fi
fi
echo "=============================================================================="
