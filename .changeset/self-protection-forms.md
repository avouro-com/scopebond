---
"@scopebond/hook": patch
---

Scopebond's always-on protection now also holds when code reaches an interpreter on standard input or in a here-document, when a path is built from pieces or matched by a wildcard, when files are deleted through `find -delete`/`-exec rm`, `git clean` or an SQL `ATTACH`, when a home folder is copied or archived, when the connection file is read from a copy, when a coding agent is started with its hooks off or another config folder, and for Glob over the hook's folder. The remote-database rule treats psql SQL it cannot read (standard input, a redirect, a here-document) and inline `PGHOST`/service hosts as unknown, and the SQL classifier refuses text the PostgreSQL and SQLite lexers read differently.
