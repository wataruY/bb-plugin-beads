#!/usr/bin/env bash
# Usage: session.sh start [url] | stop
# Creates a BB browser tab + control lease; writes private CDP info to
# /tmp/bb-ui-debug/{state.json,cdp.json}. Run inside a bb thread.
set -euo pipefail
D=/tmp/bb-ui-debug; mkdir -p "$D"; chmod 700 "$D"
HOST=${BB_HOST_ID:-$(bb machine list --json | jq -r '.[0].id')}
case "${1:-}" in
start)
  URL=${2:-http://127.0.0.1:38886}
  INST=$(bb browser instances --host "$HOST" --json | jq -c '.instances[0]')
  [ "$INST" != null ] || { echo "no BB desktop window connected" >&2; exit 1; }
  C=(--host "$HOST" --instance "$(jq -r .instanceId <<<"$INST")" --generation "$(jq -r .generation <<<"$INST")" --thread "$BB_THREAD_ID")
  TAB=$(bb browser create "${C[@]}" --url about:blank --json | jq -r .tab.tabId)
  LEASE=$(bb browser acquire "$TAB" "${C[@]}" --controller bb-ui-debug --ttl-ms 1800000 --json | jq -r .leaseId)
  rm -f "$D/cdp.json"
  bb browser connection "$LEASE" "${C[@]}" --output "$D/cdp.json" --json >/dev/null
  jq -n --arg tab "$TAB" --arg lease "$LEASE" --arg host "$HOST" --argjson c "$(printf '%s\n' "${C[@]}" | jq -R . | jq -sc .)" \
    '{tab:$tab,lease:$lease,host:$host,flags:$c}' > "$D/state.json"
  echo "tab=$TAB lease=$LEASE (cdp: $D/cdp.json)"
  node "$(dirname "$0")/navigate.mjs" "$URL"
  ;;
stop)
  [ -f "$D/state.json" ] || exit 0
  mapfile -t C < <(jq -r '.flags[]' "$D/state.json")
  bb browser release "$(jq -r .lease "$D/state.json")" "${C[@]}" >/dev/null || true
  bb browser close "$(jq -r .tab "$D/state.json")" "${C[@]}" >/dev/null || true
  rm -f "$D/cdp.json" "$D/state.json"; echo stopped
  ;;
*) echo "usage: $0 start [url] | stop" >&2; exit 2;;
esac
