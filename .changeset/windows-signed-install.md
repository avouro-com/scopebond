---
"@scopebond/agent": minor
---

Windows: the signed installer is the one Windows install. A signed install that was never connected signs in by itself
on its first start (the workspace the installer named under `Software\Avouro\Scopebond\Workspace`, HKCU then HKLM, else
Scopebond Cloud; https only), and the tray offers **Sign in…** until it is connected; approved, it sets up the hook
entries and autostart as `setup` does. Signed installs update only to the workspace's `native_agent` (the newest
published signed build; no field means no update), through a copy of the signed program that checks the installer again,
runs msiexec with a verbose log in the updates folder, and confirms the new agent starts; a version that does not
install or start is recorded and not tried again for a day. The signed agent takes over from an npm install (stops it,
removes its sign-in entry, launcher and Apps entry, and points the hook entries at itself). Messages name
`scopebond-agent` and `scopebond-agent hook` under the signed install, and `status` and the self-check name hook
entries whose program is gone.
