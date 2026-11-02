#!/usr/bin/env bash
# Runs a desktop test inside a private, invisible KWin session on its own
# D-Bus, so nothing appears on (or touches) the real desktop.
#
#   e2e/desktop-nested.sh <electron> <pravda-binary> <shots-dir>
#   PRAVDA_NESTED_SCRIPT=update.ts e2e/desktop-nested.sh <old.AppImage> <new-release-folder> <shots-dir>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if [[ "${PRAVDA_NESTED:-}" != 1 ]]; then
  exec env -u WAYLAND_DISPLAY -u DISPLAY PRAVDA_NESTED=1 dbus-run-session -- "$0" "$@"
fi

socket="pravda-test-$$"
log="$(mktemp -t pravda-kwin-XXXX.log)"
kwin_wayland --virtual --no-lockscreen --no-global-shortcuts --width 1600 --height 1000 --socket "$socket" >"$log" 2>&1 &
kwin=$!

cleanup() {
  # Stop only what belongs to this private session: the nested KWin by its
  # PID, and services D-Bus started on the private bus (matched by address).
  kill "$kwin" 2>/dev/null || true
  for env in /proc/[0-9]*/environ; do
    pid="${env#/proc/}"; pid="${pid%/environ}"
    [[ "$pid" == "$$" ]] && continue
    if grep -qaF "DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS" "$env" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

for _ in $(seq 100); do
  [[ -S "$XDG_RUNTIME_DIR/$socket" ]] && break
  sleep 0.1
done
[[ -S "$XDG_RUNTIME_DIR/$socket" ]] || { echo "nested KWin did not start; see $log" >&2; exit 1; }

WAYLAND_DISPLAY="$socket" deno run -A --no-lock "$here/${PRAVDA_NESTED_SCRIPT:-desktop.ts}" "$@"
