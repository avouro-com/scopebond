---
"@scopebond/hook": minor
---

Signed workspace rules can no longer be stripped or replaced on the way. Once this computer has received one correctly signed answer from its workspace, it accepts only signed answers from it: an unsigned rules answer, a "use your own rules" answer without a signature, and a refused connection without the workspace's signed revocation all leave the rules in force (a signed revocation still disconnects the computer). Each signed answer now says how long it may be relied on (72 hours); a "nothing changed" answer extends that, and renews the cached rule packs, only when it carries a signed freshness proof. If no fresh signed answer arrives in time, the workspace's allowances stop letting blocked actions through until the next one, while its rules stay in force; `doctor` says so. Computers that have never received a signed answer work as before.
