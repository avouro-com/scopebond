#!/bin/sh
# Remove the Scopebond Agent that the macOS installer package installed:
#
#   sudo "/Library/Application Support/Scopebond/uninstall.sh" [--purge]
#
# First the agent's own uninstall, as the person removing it: the agent stopped, the hook taken out of the coding
# agents' settings and the workspace told (with --purge, the person's Scopebond folder goes too). Then the same for every
# other person on this Mac who used Scopebond (a Scopebond folder in their home), as them, so no one's coding agents keep
# calling a program that is gone; their Scopebond folders stay. Then the agent launchd runs for each person signed in is
# stopped, then the package's updater, and the package's files and its receipt are removed. A workspace that could not
# be told within a few seconds is said, the removal goes on, and the exit code is 75 instead of 0. An uninstall that
# failed for someone is said, naming them, the removal goes on, and the exit code is 1.
set -u
LABEL=com.scopebond.agent
TRAY=com.scopebond.tray
UPDATER=com.scopebond.updater
PACKAGE_ID=com.scopebond.agent
EXE=/Library/PrivilegedHelperTools/scopebond-agent
# The link on PATH, and where packages built before the agent moved to PrivilegedHelperTools put the program itself.
LINK=/usr/local/bin/scopebond-agent
PLIST="/Library/LaunchAgents/$LABEL.plist"
SUPPORT="/Library/Application Support/Scopebond"

PURGE=""
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=--purge ;;
    *) echo "usage: sudo \"$SUPPORT/uninstall.sh\" [--purge]" >&2; exit 2 ;;
  esac
done
if [ "$(/usr/bin/id -u)" -ne 0 ]; then
  echo "Removing the Scopebond Agent needs an administrator: sudo \"$SUPPORT/uninstall.sh\"${PURGE:+ $PURGE}" >&2
  exit 1
fi

# The person removing it: whoever ran sudo, else whoever is signed in at the screen.
person="${SUDO_USER:-}"
[ -n "$person" ] && [ "$person" != root ] || person="$(/usr/bin/stat -f %Su /dev/console 2>/dev/null)"
[ "$person" != root ] || person=""

# The program to run each person's uninstall with: the installed one (a package from before the move: the file in
# /usr/local/bin itself, never a link there, which a person may have replaced).
PROGRAM="$EXE"
[ -x "$PROGRAM" ] || { [ ! -L "$LINK" ] && [ -x "$LINK" ] && PROGRAM="$LINK"; } || PROGRAM=""

code=0
failed=""
# The agent's own uninstall as `user` (with their own home, -H, where their Scopebond folder and the coding agents'
# settings are), with any further options. The agent leaves the sentence about the Scopebond folder to this script
# (SCOPEBOND_UNINSTALL_CALLER), which says it last for the person removing it. 75: a workspace could not be told; any
# other failure is remembered and named at the end.
uninstall_as() {
  user="$1"; shift
  status=0
  /usr/bin/sudo -H -u "$user" /usr/bin/env SCOPEBOND_UNINSTALL_CALLER=macos-package "$PROGRAM" uninstall "$@" || status=$?
  if [ "$status" -eq 75 ]; then
    [ "$code" -ne 0 ] || code=75
  elif [ "$status" -ne 0 ]; then
    failed="$failed $user"
    code=1
  fi
}

if [ -n "$PROGRAM" ]; then
  [ -z "$person" ] || uninstall_as "$person" $PURGE
  # Everyone else on this Mac who used Scopebond: a person's account (an id of 500 or more, not a system account) with a
  # Scopebond folder. Their folder stays: only the person removing it can ask for theirs to go (--purge).
  # (A list first, then a loop in this shell, so what uninstall_as records is still there after it.)
  others="$(/usr/bin/dscl . -list /Users UniqueID 2>/dev/null | /usr/bin/awk '$2 >= 500 && $1 !~ /^_/ && $1 != "nobody" { print $1 }')"
  homes="$(/usr/bin/dscl . -list /Users NFSHomeDirectory 2>/dev/null)"
  for user in $others; do
    [ "$user" != "$person" ] || continue
    home="$(printf '%s\n' "$homes" | /usr/bin/awk -v u="$user" '$1 == u { sub(/^[^ ]+ +/, ""); print; exit }')"
    [ -n "$home" ] && [ -d "$home/.scopebond" ] || continue
    echo "Removing Scopebond for $user too (their Scopebond folder stays)."
    uninstall_as "$user"
  done
fi

for uid in $(/bin/ps -axo uid=,comm= | /usr/bin/awk '$1 != 0 && $2 ~ /\/loginwindow$/ { print $1 }' | /usr/bin/sort -u); do
  /bin/launchctl bootout "gui/$uid/$TRAY" 2>/dev/null || true
  /bin/launchctl bootout "gui/$uid/$LABEL" 2>/dev/null || true
  # `autostart off` (which the agent's uninstall runs) and Open at Login turned off can leave a label disabled in
  # launchd: cleared, so installing again later starts as a first install does.
  /bin/launchctl enable "gui/$uid/$LABEL" 2>/dev/null || true
  /bin/launchctl enable "gui/$uid/$TRAY" 2>/dev/null || true
done

/bin/launchctl bootout "system/$UPDATER" 2>/dev/null || true

/bin/rm -f "$EXE" "$LINK" "$PLIST" "/Library/LaunchAgents/$TRAY.plist" "/Library/LaunchDaemons/$UPDATER.plist" "/Library/PrivilegedHelperTools/$UPDATER" /Library/Logs/Scopebond-updater.log
/bin/rm -rf /Applications/Scopebond.app
/bin/rm -rf "$SUPPORT"
/usr/sbin/pkgutil --forget "$PACKAGE_ID" >/dev/null 2>&1 || true
echo "Removed the Scopebond Agent ($EXE and its LaunchAgent)."
[ -z "$failed" ] || echo "The agent's uninstall did not finish for:$failed. Their coding agents may still name the removed program: in each one's settings, remove the Scopebond hook entries." >&2

if [ -n "$person" ]; then
  home="$(/usr/bin/sudo -H -u "$person" /usr/bin/printenv HOME 2>/dev/null)"
  if [ -n "$home" ]; then
    dir="$home/.scopebond"
    if [ -e "$dir" ]; then
      echo "Your Scopebond folder $dir stays (keys and records not yet sent). Delete it to remove everything."
    elif [ -n "$PURGE" ]; then
      echo "Your Scopebond folder $dir was removed, with its keys and the records not yet sent."
    else
      echo "No Scopebond folder is left at $dir."
    fi
  fi
fi
exit "$code"
