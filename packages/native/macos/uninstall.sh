#!/bin/sh
# Remove the Scopebond Agent that the macOS installer package installed:
#
#   sudo "/Library/Application Support/Scopebond/uninstall.sh" [--purge]
#
# First the agent's own uninstall, as the person removing it: the agent stopped, the hook taken out of the coding
# agents' settings and the workspace told (with --purge, the person's Scopebond folder goes too). Then the same for every
# other person on this Mac whose coding agents' settings still run the package's executable (their Scopebond folder
# stays): otherwise their coding agents would keep calling a program that is gone. Then the agent launchd runs for each
# person signed in is stopped, then the package's updater, and the package's files and its receipt are removed. A
# workspace that could not be told within a few seconds is said, the removal goes on, and the exit code is 75 instead of 0.
set -u
LABEL=com.scopebond.agent
TRAY=com.scopebond.tray
UPDATER=com.scopebond.updater
PACKAGE_ID=com.scopebond.agent
EXE="/Library/Application Support/Scopebond/bin/scopebond-agent"
# Releases before the root-owned folder put the executable here; now it is a link to EXE, for PATH.
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

# An install from before the root-owned folder has its executable at the link's path.
[ -x "$EXE" ] || EXE="$LINK"

code=0
if [ -n "$person" ] && [ -x "$EXE" ]; then
  # With the person's own home (-H), where their Scopebond folder and the coding agents' settings are. The agent leaves
  # the sentence about the Scopebond folder to this script (SCOPEBOND_UNINSTALL_CALLER), which says it last.
  /usr/bin/sudo -H -u "$person" /usr/bin/env SCOPEBOND_UNINSTALL_CALLER=macos-package "$EXE" uninstall $PURGE || code=$?
  [ "$code" -eq 75 ] || code=0
fi

# Everyone else whose coding agents' settings still run the package's executable: the same uninstall as them (their
# Scopebond folder stays; --purge is the person's own choice), as the Windows removal for every user does at each
# person's next sign-in. A person with no such entry is left alone.
/usr/bin/dscl . -list /Users NFSHomeDirectory 2>/dev/null | while read -r other home; do
  case "$other" in ''|_*|root|daemon|nobody) continue ;; esac
  [ "$other" != "$person" ] && [ -d "$home" ] && [ ! -L "$home" ] && [ -x "$EXE" ] || continue
  if /usr/bin/grep -qsF scopebond-agent "$home/.claude/settings.json" "$home/.cursor/hooks.json" "$home/.codex/hooks.json" "$home/.copilot/hooks/scopebond.json"; then
    /usr/bin/sudo -H -u "$other" /usr/bin/env SCOPEBOND_UNINSTALL_CALLER=macos-package "$EXE" uninstall </dev/null >/dev/null 2>&1
    rc=$?
    # 75: taken out, but their workspace could not be told within a few seconds.
    if [ "$rc" -eq 0 ] || [ "$rc" -eq 75 ]; then
      echo "Took Scopebond out of the coding agents' settings of $other."
    else
      echo "Could not take Scopebond out of the coding agents' settings of $other: remove its entries from $home/.claude/settings.json, .cursor/hooks.json, .codex/hooks.json or .copilot/hooks/scopebond.json." >&2
    fi
    # Its `autostart off` can leave the label disabled for them in launchd: cleared, as for the people signed in below.
    ouid=$(/usr/bin/id -u "$other" 2>/dev/null) && /bin/launchctl enable "gui/$ouid/$LABEL" 2>/dev/null || true
  fi
done

for uid in $(/bin/ps -axo uid=,comm= | /usr/bin/awk '$1 != 0 && $2 ~ /\/loginwindow$/ { print $1 }' | /usr/bin/sort -u); do
  /bin/launchctl bootout "gui/$uid/$TRAY" 2>/dev/null || true
  /bin/launchctl bootout "gui/$uid/$LABEL" 2>/dev/null || true
  # `autostart off` (which the agent's uninstall runs) and Open at Login turned off can leave a label disabled in
  # launchd: cleared, so installing again later starts as a first install does.
  /bin/launchctl enable "gui/$uid/$LABEL" 2>/dev/null || true
  /bin/launchctl enable "gui/$uid/$TRAY" 2>/dev/null || true
done

/bin/launchctl bootout "system/$UPDATER" 2>/dev/null || true

# The link only when it is one (or the executable an earlier release put there): a file another tool keeps there stays.
if [ -L "$LINK" ] || [ "$EXE" = "$LINK" ]; then /bin/rm -f "$LINK"; fi
/bin/rm -f "$EXE" "$PLIST" "/Library/LaunchAgents/$TRAY.plist" "/Library/LaunchDaemons/$UPDATER.plist" "/Library/PrivilegedHelperTools/$UPDATER" /Library/Logs/Scopebond-updater.log
/bin/rm -rf /Applications/Scopebond.app
/bin/rm -rf "$SUPPORT"
/usr/sbin/pkgutil --forget "$PACKAGE_ID" >/dev/null 2>&1 || true
echo "Removed the Scopebond Agent ($EXE, its link $LINK and its LaunchAgent)."

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
