#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_JS="$SCRIPT_DIR/host.js"

# Make host.js executable
chmod +x "$HOST_JS"

# Determine manifest directory
if [[ "$OSTYPE" == "darwin"* ]]; then
  MANIFEST_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
else
  MANIFEST_DIR="$HOME/.mozilla/native-messaging-hosts"
fi

mkdir -p "$MANIFEST_DIR"

MANIFEST="$MANIFEST_DIR/yt_sub.json"

cat > "$MANIFEST" <<EOF
{
  "name": "yt_sub",
  "description": "YT Sub native messaging host",
  "path": "$HOST_JS",
  "type": "stdio",
  "allowed_extensions": ["yt-sub@example.com"]
}
EOF

echo ""
echo "Native host registered successfully."
echo "Manifest: $MANIFEST"
echo ""
