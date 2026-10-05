---
"@scopebond/hook": patch
---

On Windows, a user folder with non-ASCII letters (a profile named after a person with an accented name) now gets the fast, pinned hook command. Node 22's `fs.cpSync` wrote the pinned copy to a mis-decoded folder beside the real one and reported success, so the hook fell back to the slower `npx` command on every install; the copy is now made file by file.
