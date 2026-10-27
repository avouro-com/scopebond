---
"@scopebond/agent": minor
---

Removing Scopebond for every user on Windows (`msiexec /x … ALLUSERS=1`, Intune, Group Policy) now also takes it out of every other person's coding-agent settings, at their next sign-in. The removal leaves a copy of the agent in `Program Files\Scopebond Cleanup` and a Windows Active Setup entry; at each person's next sign-in Windows runs `scopebond-agent uninstall --signed-in` as that person, with no window, which removes the hook from their settings and tells their workspace. It does nothing for someone who never used Scopebond, or when Scopebond has been installed again. Installing for every user again removes the entry and the copy.
