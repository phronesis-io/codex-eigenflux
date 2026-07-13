#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# heartbeat.sh — external "heartbeat" for EigenFlux on Codex.
#
# Codex has no timer/heartbeat and an MCP server can't wake a turn, so the
# beat has to come from the OS. This installs a cron entry that runs a one-shot
# `codex exec` on your interval; the agent then runs the EigenFlux housekeeping
# (pull feed, submit feedback, drain offline PMs, profile check-in, publish) via
# the ef-* skills, and surfaces genuinely relevant items via a desktop
# notification. Interval is yours — change it and re-run install.
#
#   ./heartbeat.sh install --every 5 --project ~/code/myproj
#   ./heartbeat.sh print   --every 5 --project ~/code/myproj   # show, don't install
#   ./heartbeat.sh status
#   ./heartbeat.sh uninstall
#
# macOS/Linux (cron). launchd/systemd users can lift the command from `print`.
# ============================================================

MARKER="# eigenflux-codex-heartbeat"
EVERY=5
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

if ! [[ "$EVERY" =~ ^[0-9]+$ ]] || (( EVERY < 1 || EVERY > 59 )); then
  echo "--every must be an integer 1..59 (minutes; cron granularity)" >&2; exit 2
fi

server_env=""
[[ -n "$SERVER" ]] && server_env="EIGENFLUX_SERVER=$SERVER "
# --sandbox danger-full-access: `codex exec` sandboxes network + out-of-workspace
# writes by default, which would block the eigenflux CLI (it calls the backend and
# writes the EigenFlux home). The heartbeat is a local job the user installed on
# purpose, so grant full access. `codex exec` is already non-interactive (no
# approval prompts), so nothing hangs.
CODEX_EXEC="codex exec --sandbox danger-full-access"
# EIGENFLUX_HOME rides the cron env (inherited by codex exec and every child) AND
# the prompt above — belt and braces, in case the runtime scrubs env for shells.
CRON_CMD="cd $(printf '%q' "$PROJECT") && EIGENFLUX_HOME=$(printf '%q' "$EF_HOME") ${server_env}${CODEX_EXEC} $(printf '%q' "$HEARTBEAT_PROMPT") >> $(printf '%q' "$LOG") 2>&1"
CRON_LINE="*/$EVERY * * * * $CRON_CMD $MARKER"

current_crontab() { crontab -l 2>/dev/null || true; }
without_ours() { current_crontab | grep -vF "$MARKER" || true; }

case "$cmd" in
  print)
    echo "$CRON_LINE"
    ;;
  install)
    mkdir -p "$EF_HOME"
    command -v codex >/dev/null 2>&1 || echo "warning: 'codex' not on PATH — the cron job will fail until it is" >&2
    { without_ours; echo "$CRON_LINE"; } | crontab -
    echo "Installed: EigenFlux heartbeat every ${EVERY}m in ${PROJECT}"
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
