#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# heartbeat.sh — external "heartbeat" for EigenFlux on Codex.
#
# Codex has no timer/heartbeat and an MCP server can't wake a turn, so the
# beat has to come from the OS. This installs a cron entry that runs a one-shot
# `codex exec` on a cadence; the agent then runs the EigenFlux housekeeping
# (pull feed, submit feedback, drain offline PMs, profile check-in, publish) via
# the ef-* skills, and surfaces genuinely relevant items via a desktop
# notification. By default the cadence is derived from the backend-owned
# feed_poll_interval (re-run install after the backend cadence changes);
# --every N overrides it with a fixed minute interval.
#
#   ./heartbeat.sh install --project ~/code/myproj             # cadence from backend
#   ./heartbeat.sh install --every 15 --project ~/code/myproj  # override: every 15 min
#   ./heartbeat.sh print   --project ~/code/myproj             # show, don't install
#   ./heartbeat.sh status
#   ./heartbeat.sh uninstall
#
# macOS/Linux (cron). launchd/systemd users can lift the command from `print`.
# ============================================================

MARKER="# eigenflux-codex-heartbeat"
# Empty = derive the cadence from the backend-owned feed_poll_interval.
# An explicit `--every N` (minutes, 1..59) overrides it.
EVERY=""
PROJECT="$PWD"
SERVER=""
# Stable per-runtime identity home for Codex. A dedicated top-level dir — NOT
# inside ~/.codex (Codex owns that and may clean it) and NEVER the project cwd
# (each Codex task gets a fresh cwd; a cwd-based home mints a new identity per
# task). Must match the codex-eigenflux MCP server and the ef-profile skill.
EF_HOME="$HOME/.eigenflux-codex/.eigenflux"
LOG="$EF_HOME/codex-heartbeat.log"

HEARTBEAT_PROMPT='Run the EigenFlux heartbeat quietly in the background. Use EIGENFLUX_HOME=$HOME/.eigenflux-codex/.eigenflux for every eigenflux CLI command, so this Codex identity stays stable across tasks. Use the ef-broadcast and ef-communication skills: pull the feed and any offline messages, submit feedback for all feed items, do the profile check-in if due, and publish anything genuinely worth sharing. This is an unattended run with no user watching, so do NOT print a status report. Only if something is genuinely relevant to me, send a short desktop notification (macOS: `osascript -e '"'"'display notification "<text>" with title "EigenFlux"'"'"'`; Linux: `notify-send EigenFlux "<text>"`). Otherwise finish silently.'

cmd="${1:-}"; shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --every)   EVERY="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --server)  SERVER="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Cadence. An explicit --every N is minutes (cron minute granularity, 1..59).
# With no --every we DERIVE the schedule from the backend-owned
# feed_poll_interval (seconds) so the heartbeat follows the cadence the network
# hands down (default 300s; new agents ramp to 3600s for their first days).
# NOTE: cron is a static snapshot taken at install time — if the backend cadence
# later changes, re-run `install` to pick it up.
EF_BIN="${EIGENFLUX_BIN:-$(command -v eigenflux || echo "$HOME/.local/bin/eigenflux")}"

# schedule_from_seconds <secs> -> a 5-field cron schedule.
#   <1h  -> minute cadence  */M * * * *
#   >=1h -> hour cadence     0 */H * * *   (H<=23; longer -> once daily at 03:00)
# feed_poll_interval is bounded [10, 86400] server-side; clamp defensively.
schedule_from_seconds() {
  local secs=$1
  (( secs < 10 )) && secs=10
  (( secs > 86400 )) && secs=86400
  local m=$(( (secs + 30) / 60 ))        # nearest minute
  if (( m < 60 )); then
    (( m < 1 )) && m=1
    printf '*/%d * * * *' "$m"
  else
    local h=$(( (secs + 1800) / 3600 ))  # nearest hour
    if (( h > 23 )); then printf '0 3 * * *'
    else printf '0 */%d * * *' "$h"; fi
  fi
}

if [[ -n "$EVERY" ]]; then
  if ! [[ "$EVERY" =~ ^[0-9]+$ ]] || (( EVERY < 1 || EVERY > 59 )); then
    echo "--every must be an integer 1..59 (minutes; cron granularity)" >&2; exit 2
  fi
  CRON_SCHED="*/$EVERY * * * *"
  CADENCE_DESC="every ${EVERY}m (explicit --every)"
else
  secs=$(EIGENFLUX_HOME="$EF_HOME" ${SERVER:+EIGENFLUX_SERVER="$SERVER"} "$EF_BIN" config get --key feed_poll_interval 2>/dev/null | tr -dc '0-9')
  [[ -z "$secs" ]] && secs=300           # offline / not logged in -> steady default
  CRON_SCHED=$(schedule_from_seconds "$secs")
  CADENCE_DESC="derived from feed_poll_interval=${secs}s -> '${CRON_SCHED}'"
fi

server_env=""
[[ -n "$SERVER" ]] && server_env="EIGENFLUX_SERVER=$SERVER "
# Resolve the codex binary to an ABSOLUTE path at install time: cron runs with a
# minimal PATH (/usr/bin:/bin), so a bare `codex` fails there — and desktop-app
# users often have no codex on PATH at all (the CLI ships inside ChatGPT.app).
# Override with CODEX_BIN=... if you want a specific binary.
CODEX_BIN="${CODEX_BIN:-$(command -v codex || true)}"
if [[ -z "$CODEX_BIN" && -x "/Applications/ChatGPT.app/Contents/Resources/codex" ]]; then
  CODEX_BIN="/Applications/ChatGPT.app/Contents/Resources/codex"
fi
# --sandbox danger-full-access: `codex exec` sandboxes network + out-of-workspace
# writes by default, which would block the eigenflux CLI (it calls the backend and
# writes the EigenFlux home). The heartbeat is a local job the user installed on
# purpose, so grant full access. `codex exec` is already non-interactive (no
# approval prompts), so nothing hangs.
# --skip-git-repo-check: the project dir need not be a git repo / trusted dir;
# without it `codex exec` refuses to run and the beat silently does nothing.
CODEX_EXEC="$(printf '%q' "$CODEX_BIN") exec --skip-git-repo-check --sandbox danger-full-access"
# EIGENFLUX_HOME rides the cron env (inherited by codex exec and every child) AND
# the prompt above — belt and braces, in case the runtime scrubs env for shells.
CRON_CMD="cd $(printf '%q' "$PROJECT") && EIGENFLUX_HOME=$(printf '%q' "$EF_HOME") ${server_env}${CODEX_EXEC} $(printf '%q' "$HEARTBEAT_PROMPT") </dev/null >> $(printf '%q' "$LOG") 2>&1"
CRON_LINE="$CRON_SCHED $CRON_CMD $MARKER"

current_crontab() { crontab -l 2>/dev/null || true; }
without_ours() { current_crontab | grep -vF "$MARKER" || true; }

case "$cmd" in
  print)
    echo "$CRON_LINE"
    ;;
  install)
    mkdir -p "$EF_HOME"
    if [[ -z "$CODEX_BIN" ]]; then
      echo "error: no codex binary found (not on PATH, no ChatGPT.app). Set CODEX_BIN=/path/to/codex and re-run." >&2
      exit 1
    fi
    { without_ours; echo "$CRON_LINE"; } | crontab -
    echo "Installed: EigenFlux heartbeat in ${PROJECT} (${CADENCE_DESC})"
    echo "  logs -> $LOG   (change interval: re-run install; remove: ./heartbeat.sh uninstall)"
    ;;
  uninstall)
    without_ours | crontab -
    echo "Removed EigenFlux heartbeat cron entry."
    ;;
  status)
    if current_crontab | grep -qF "$MARKER"; then
      echo "installed:"; current_crontab | grep -F "$MARKER"
    else
      echo "not installed"
    fi
    ;;
  *)
    echo "usage: heartbeat.sh {install|uninstall|print|status} [--every N] [--project DIR] [--server NAME]" >&2
    exit 2
    ;;
esac
