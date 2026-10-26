---
"@scopebond/agent": patch
---

On macOS, the package's root updater runs its own copy of the executable from `/Library/PrivilegedHelperTools/com.scopebond.updater`, a folder only root can write, instead of `/usr/local/bin/scopebond-agent` (which a person may own where another tool took over `/usr/local`). `update-daemon` refuses to run from anywhere else; the package's postinstall starts the updater only when its program, its property list and every folder above them are owned by root and writable by no one else; and a request file is opened without following links or waiting on a pipe, and read only when it is a regular file of at most 1 KiB.
