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
        tmux capture-pane -p -S -2000 -t "$pane" 2>/dev/null
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

dsh_desktop_probe_proc_fd_log() {
  if [ -d /proc ]; then
    for fd in /proc/[0-9]*/fd/1 /proc/[0-9]*/fd/2; do
      [ -e "$fd" ] || continue
      pid="${fd#/proc/}"
      pid="${pid%%/*}"
      cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
      case "$cmdline" in
        *"dsh web"* | *"@deepseek-ai/dsh"*" web"*) ;;
        *) continue ;;
      esac
      target="$(readlink "$fd" 2>/dev/null)" || continue
      case "$target" in
        /*)
          [ -f "$target" ] || continue
          case "$target" in
            /dev/* | /proc/* | /sys/*) continue ;;
          esac
          tail -n 2000 "$target" 2>/dev/null
          ;;
      esac
    done
  fi
}

dsh_desktop_probe_source tmux
dsh_desktop_probe_tmux 2>/dev/null || true

dsh_desktop_probe_source journalctl-user
dsh_desktop_probe_journalctl_user 2>/dev/null || true

dsh_desktop_probe_source journalctl-system
dsh_desktop_probe_journalctl_system 2>/dev/null || true

dsh_desktop_probe_source proc-fd-log
dsh_desktop_probe_proc_fd_log 2>/dev/null || true
