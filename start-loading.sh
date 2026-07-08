#!/usr/bin/env bash
#
# start-loading.sh — start the local preview server and print a link to
# open the Sandscape loading window.
#
# Usage: ./start-loading.sh            start server, open browser, print link
#        ./start-loading.sh --no-open  start server and print link only
# Stop:  Ctrl+C
#
set -euo pipefail

# Resolve this script's own directory so it runs from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVE="$SCRIPT_DIR/.claude/serve.mjs"
PORT=8123
URL="http://localhost:$PORT"

OPEN=1
case "${1:-}" in
  -n|--no-open) OPEN=0 ;;
  "") ;;
  *) echo "start-loading: unknown option '$1' (use --no-open)" >&2; exit 2 ;;
esac

# Colours only when writing to a terminal.
if [ -t 1 ]; then
  VIOLET=$'\033[38;5;99m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  VIOLET=''; BOLD=''; DIM=''; RESET=''
fi

banner() {
  printf '\n  %s●%s Sandscape loader\n' "$VIOLET" "$RESET"
  printf '  open %s%s%s\n\n' "$BOLD" "$URL" "$RESET"
  printf '  %spress Ctrl+C to stop%s\n\n' "$DIM" "$RESET"
}

open_browser() {
  command -v open >/dev/null 2>&1 && open "$URL" >/dev/null 2>&1 || true
}

# Succeeds once the server answers on the port.
server_up() {
  command -v curl >/dev/null 2>&1 && curl -fs -o /dev/null "$URL" 2>/dev/null
}

# Poll until the server is reachable, then open the browser once.
open_when_ready() {
  for _ in $(seq 1 50); do
    server_up && { open_browser; return 0; }
    sleep 0.1
  done
}

# Preconditions.
if ! command -v node >/dev/null 2>&1; then
  echo "start-loading: 'node' is required but was not found on PATH." >&2
  exit 1
fi
if [ ! -f "$SERVE" ]; then
  echo "start-loading: server not found at $SERVE" >&2
  exit 1
fi

# If something is already serving on the port, just point at it.
if server_up; then
  echo "start-loading: a server is already running on port $PORT."
  banner
  [ "$OPEN" = 1 ] && open_browser
  exit 0
fi

# Open the browser as soon as the server is up. Detached in its own subshell
# ( ... & ) so it is reparented away and never lingers under the exec'd server.
if [ "$OPEN" = 1 ]; then
  ( open_when_ready & )
fi

banner

# Replace this shell with the server so Ctrl+C stops it directly and cleanly.
exec node "$SERVE"
