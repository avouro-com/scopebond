---
"@scopebond/hook": minor
---

Privacy: the command digest no longer hands back what the scrubber removed, and the scrubber catches two more common secret shapes.

- **Digest over scrubbed text.** `redactCommand` recorded a scrubbed, truncated head followed by a SHA-256 of the *original* command, so a secret the head removed (`psql --password hunter2 …`) was still brute-forceable from the retained digest. The digest is now taken over the scrubbed command, so the receipt reveals nothing the head already hid.
- **Attached `-p`/`-u` values.** `mysql -phunter2` / `psql -uadmin` put a password or user on argv with no separator, and passed through unchanged. The scrubber now masks an attached `-p`/`-u` value in the command head; a space-separated operand (`mkdir -p dir`, `-p value`) is untouched, and the `--password`/`--user` forms remain handled as before.
- **Custom secret-named headers.** A header whose name looks like a credential (`X-Custom-Secret:`, `My-Token:`) now has its value masked, alongside the existing `Authorization`/`X-API-Key` rules. Bare `key:` is deliberately excluded so ordinary `key: value` text is left alone.

Both new rules apply to free text (the command head) only, never to the structured parameters a policy matches on, so policy evaluation is unchanged. Command scrubbing remains best-effort — secrets should not be passed on argv in the first place.
