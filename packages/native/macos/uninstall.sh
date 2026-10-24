#!/bin/sh
# Remove the Scopebond Agent that the macOS installer package installed:
#
#   sudo "/Library/Application Support/Scopebond/uninstall.sh" [--purge]
#
# First the agent's own uninstall, as the person removing it: the agent stopped, the hook taken out of the coding
# agents' settings and the workspace told (with --purge, the person's Scopebond folder goes too). Then the agent launchd
# runs for each person signed in is stopped, then the package's updater, and the package's files and its receipt are
# removed. A workspace that could
# not be told within a few seconds is said, the removal goes on, and the exit code is 75 instead of 0.
set -u
LABEL=com.scopebond.agent
UPDATER=com.scopebond.updater
PACKAGE_ID=com.scopebond.agent
EXE=/usr/local/bin/scopebond-agent
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

code=0
if [ -n "$person" ] && [ -x "$EXE" ]; then
  # With the person's own home (-H), where their Scopebond folder and the coding agents' settings are. The agent leaves
  # the sentence about the Scopebond folder to this script (SCOPEBOND_UNINSTALL_CALLER), which says it last.
  /usr/bin/sudo -H -u "$person" /usr/bin/env SCOPEBOND_UNINSTALL_CALLER=macos-package "$EXE" uninstall $PURGE || code=$?
  [ "$code" -eq 75 ] || code=0
fi

for uid in $(/bin/ps -axo uid=,comm= | /usr/bin/awk '$1 != 0 && $2 ~ /\/loginwindow$/ { print $1 }' | /usr/bin/sort -u); do
  /bin/launchctl bootout "gui/$uid/$LABEL" 2>/dev/null || true
  # `autostart off` (which the agent's uninstall runs) can leave the label disabled in launchd: cleared, so installing
  # again later starts the agent as a first install does.
  /bin/launchctl enable "gui/$uid/$LABEL" 2>/dev/null || true
done

/bin/launchctl bootout "system/$UPDATER" 2>/dev/null || true

/bin/rm -f "$EXE" "$PLIST" "/Library/LaunchDaemons/$UPDATER.plist" /Library/Logs/Scopebond-updater.log
/bin/rm -rf "$SUPPORT"
/usr/sbin/pkgutil --forget "$PACKAGE_ID" >/dev/null 2>&1 || true
echo "Removed the Scopebond Agent ($EXE and its LaunchAgent)."

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
