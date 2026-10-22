#!/usr/bin/env bash
# Free this app's emulator ports: stop the leftovers of this checkout that
# still hold them, and the functions runtimes they orphaned.
#
#   sabeel-ci free-emulator-ports
#
# A killed or crashed run leaves emulators on these ports. The next run then
# talks to a half-dead emulator, one that answers on the port but has no
# functions registered, and every callable 404s. A 404 carries no CORS headers,
# so the browser reports "blocked by CORS policy" and the app a bare
# "internal": every symptom points at the app, not at the leftover process.
#
# It reaches no further than this app's block and this checkout. The ports are
# the emulator suite's (`sabeel-ci ports --suite`), never a dev server's and
# never one outside the block: a sweep that reached further once killed a
# sibling's running emulator. A process holding one is stopped only when its
# working directory is inside this checkout; any other (another checkout of the
# same app, a worktree) is named with its pid and directory, nothing is
# stopped, and this fails.
#
# Owners are found by port, pid and working directory, never by a pattern on a
# command line: `pkill -f firebase` also matches the shell that runs it, and
# the "cleanup" kills its own caller (a shell exiting 144).
set -uo pipefail

: "${CI_TOOLS:?run this as sabeel-ci free-emulator-ports}"
suite=$(node "$CI_TOOLS/scripts/ports.mjs" --suite) || exit 2
read -r -a PORTS <<<"$suite"
ROOT=$(pwd -P)
CALLER_PIDS=" $$ $PPID "

# Who holds a port: `ss` on Linux, `lsof` on macOS, which has no `ss`. Chosen
# here rather than inside the helper: an `exit` within `$(...)` ends only the
# substitution, so a helper that cannot look returns nothing, which reads as
# "the port is free".
if command -v ss >/dev/null 2>&1; then
  pids_on_port() {
    # Every pid on the line: a socket a parent shares with its fork lists both.
    ss -lptn "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
  }
elif command -v lsof >/dev/null 2>&1; then
  pids_on_port() {
    lsof -nP -ti "TCP:$1" -sTCP:LISTEN 2>/dev/null | sort -u
  }
else
  echo "free-emulator-ports: neither ss nor lsof found; cannot see who holds a port" >&2
  exit 1
fi

# A process's working directory: /proc on Linux, lsof on macOS. Empty when it
# is gone or not this user's to read.
cwd_of() {
  if [ -e "/proc/$1/cwd" ]; then
    readlink "/proc/$1/cwd" 2>/dev/null
  else
    lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'
  fi
}

ours() {
  case "$(cwd_of "$1")" in "$ROOT" | "$ROOT"/*) return 0 ;; esac
  return 1
}

# Functions runtimes that outlived their run hold no port, so the sweep below
# never sees them. Each is ~150 MB, and the damage lands on a later run: a long
# browser suite dies partway with ERR_CONNECTION_REFUSED against its own dev
# server, at a different screen each time. Twelve were found after three
# interrupted runs, ~1.7 GB.
#
# An orphan is a runtime whose parent is no longer the emulator that spawned
# it, not one whose parent is 1: a systemd user session adopts orphans itself,
# and a test for ppid 1 never matched. Its parent is matched on 'firebase', not
# 'firebase-tools': a running emulator's command line is `node .../bin/firebase
# emulators:start …`, so the narrower pattern would stop a live run's workers.
# Only runtimes working in this checkout's functions/ are stopped.
reap_orphaned_runtimes() {
  local functions="$ROOT/functions" orphans=() pid ppid
  # shellcheck disable=SC2009 # ps filtered by parent and directory; pgrep -f would match this script's callers
  while read -r pid ppid _; do
    ps -p "$ppid" -o args= 2>/dev/null | grep -q firebase && continue
    case "$CALLER_PIDS" in *" $pid "*) continue ;; esac
    [ "$(cwd_of "$pid")" = "$functions" ] || continue
    orphans+=("$pid")
  done < <(ps -eo pid=,ppid=,args= | grep '[f]irebase-tools')
  [ "${#orphans[@]}" -eq 0 ] && return 0
  echo "stopping ${#orphans[@]} orphaned functions runtime(s): ${orphans[*]}"
  kill "${orphans[@]}" 2>/dev/null || true
}

victims=()
strangers=()
for port in "${PORTS[@]}"; do
  for pid in $(pids_on_port "$port"); do
    case "$CALLER_PIDS" in *" $pid "*) continue ;; esac
    if ours "$pid"; then
      victims+=("$pid")
    elif ps -p "$pid" >/dev/null 2>&1; then
      cwd=$(cwd_of "$pid")
      strangers+=("port $port: pid $pid in ${cwd:-a directory this user cannot read}: $(ps -o args= -p "$pid" 2>/dev/null | cut -c1-80)")
    fi
  done
done

if [ "${#strangers[@]}" -gt 0 ]; then
  echo "free-emulator-ports: this app's ports are held from outside this checkout ($ROOT):" >&2
  printf '  %s\n' "${strangers[@]}" >&2
  echo "Nothing was stopped. Stop them by pid if they are yours." >&2
  exit 1
fi

if [ "${#victims[@]}" -eq 0 ]; then
  echo "emulator ports clear"
  reap_orphaned_runtimes
  exit 0
fi

uniq_victims=$(printf '%s\n' "${victims[@]}" | sort -u)
echo "freeing emulator ports; stopping: $(echo "$uniq_victims" | tr '\n' ' ')"
# shellcheck disable=SC2086 # a list of pids
kill $uniq_victims 2>/dev/null
for _ in $(seq 1 20); do
  still=""
  for port in "${PORTS[@]}"; do still="$still$(pids_on_port "$port")"; done
  [ -z "$still" ] && break
  sleep 0.5
done
for port in "${PORTS[@]}"; do
  for pid in $(pids_on_port "$port"); do
    case "$CALLER_PIDS" in *" $pid "*) continue ;; esac
    ours "$pid" || continue
    echo "  port $port still held by $pid: SIGKILL"
    kill -9 "$pid" 2>/dev/null
  done
done
sleep 1

# Verified, not assumed: a port still held here would fail the next run.
held=""
for port in "${PORTS[@]}"; do
  [ -z "$(pids_on_port "$port")" ] || held="$held $port"
done
if [ -n "$held" ]; then
  echo "free-emulator-ports: still held after SIGKILL:$held" >&2
  exit 1
fi
echo "emulator ports clear"
reap_orphaned_runtimes
