#!/bin/sh
set +e

DSH_DESKTOP_TOKEN_PROBE_SOURCE_MARKER='__DSH_DESKTOP_TOKEN_PROBE_SOURCE__='

dsh_desktop_probe_source() {
  printf '%s%s\n' "$DSH_DESKTOP_TOKEN_PROBE_SOURCE_MARKER" "$1"
}

dsh_desktop_probe_tmux() {
  if command -v tmux >/dev/null 2>&1; then
    tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null |
      while IFS= read -r pane; do
        tmux capture-pane -p -J -S -2000 -t "$pane" 2>/dev/null
      done
  fi
}

dsh_desktop_probe_journalctl_user() {
  if command -v journalctl >/dev/null 2>&1; then
    journalctl --user --no-pager -n 2000 2>/dev/null
  fi
}

dsh_desktop_probe_journalctl_system() {
  if command -v journalctl >/dev/null 2>&1; then
    journalctl --no-pager -n 2000 2>/dev/null
  fi
}

# Restart helpers detach from the original terminal and redirect the replacement's
# stdout/stderr to files. Keep the launch line even after it scrolls out of the tail.
dsh_desktop_probe_log_file() {
  log_file="$1"
  case "$log_file" in
    /dev/* | /proc/* | /sys/*) return ;;
    /*) ;;
    *) return ;;
  esac
  [ -f "$log_file" ] && [ ! -L "$log_file" ] && [ -r "$log_file" ] || return
  head -c 65536 "$log_file" 2>/dev/null
  printf '\n'
  tail -c 65536 "$log_file" 2>/dev/null
  printf '\n'
}

dsh_desktop_probe_plugin_restart_logs() {
  # This is node:os.tmpdir()'s POSIX precedence. Also try /tmp when the SSH
  # session and the process that requested the restart have different environments.
  restart_tmp="${TMPDIR:-${TMP:-${TEMP:-/tmp}}}"
  restart_uid="$(id -u)" || return
  for log_dir in "$restart_tmp" /tmp; do
    case "$log_dir" in
      /*) ;;
      *) continue ;;
    esac
    # These are the two installed plugins' log names, not a recursive tmp scan.
    LC_ALL=C ls -1dt "$log_dir"/dsh-simple-restart-*.out.log "$log_dir"/dsh-simple-restart-*.err.log \
      "$log_dir"/dsh-market-restart-*.out.log "$log_dir"/dsh-market-restart-*.err.log 2>/dev/null |
      (
        restart_log_count=0
        while IFS= read -r restart_log; do
          # Filter before applying the limit: shared tmp entries must not crowd
          # this user's actual logs out of the newest 20 readable regular files.
          [ -r "$restart_log" ] || continue
          [ "$(find "$restart_log" -prune -type f -user "$restart_uid" -print 2>/dev/null)" = "$restart_log" ] || continue
          dsh_desktop_probe_log_file "$restart_log"
          restart_log_count=$((restart_log_count + 1))
          [ "$restart_log_count" -ge 20 ] && break
        done
      )
    [ "$log_dir" = /tmp ] && break
  done
}

dsh_desktop_probe_proc_fd_log() {
  if [ -d /proc ]; then
    for fd in /proc/[0-9]*/fd/1 /proc/[0-9]*/fd/2; do
      [ -e "$fd" ] || continue
      pid="${fd#/proc/}"
      pid="${pid%%/*}"
      cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
      case "$cmdline" in
        *"dsh web"* | *"dsh "*" web"* | *"@deepseek-ai/dsh"*" web"* | *"/apps/cli/"*"/bin."*" web"*) ;;
        *) continue ;;
      esac
      target="$(readlink "$fd" 2>/dev/null)" || continue
      case "$target" in
        /*)
          dsh_desktop_probe_log_file "$target"
          ;;
      esac
    done
  fi
}

dsh_desktop_probe_source plugin-restart-log
dsh_desktop_probe_plugin_restart_logs 2>/dev/null || true

dsh_desktop_probe_source tmux
dsh_desktop_probe_tmux 2>/dev/null || true

dsh_desktop_probe_source journalctl-user
dsh_desktop_probe_journalctl_user 2>/dev/null || true

dsh_desktop_probe_source journalctl-system
dsh_desktop_probe_journalctl_system 2>/dev/null || true

dsh_desktop_probe_source proc-fd-log
dsh_desktop_probe_proc_fd_log 2>/dev/null || true
