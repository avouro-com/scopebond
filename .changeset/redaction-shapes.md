---
"@scopebond/hook": patch
---

More credential shapes are removed before a record is signed or sent:
- any URL userinfo, including a token alone, an Azure DevOps or GitHub token in a `git push` or `git remote` URL, and `redis://:password@`;
- a signature or token in a URL query (an Azure SAS `sig=`, OAuth `code=`);
- cookies (`Cookie:` headers and curl `-b`);
- PowerShell `$env:NAME = "value"` and `ConvertTo-SecureString … -AsPlainText`;
- a space-separated `-p <password>` after `sshpass`, `docker login`, `mysql` and similar;
- short password names such as `DB_PASS=` and `PASS=`, and names ending in `KEY`;
- `--key` and `--*-key` flags;
- Vault (`hvs.`) and SendGrid (`SG.`) keys;
- secret-looking segments and email addresses in a fetched URL's path (Slack, Discord and Telegram webhooks).

A package operation's URL now drops userinfo up to the last `@`, so a password containing `@` leaves nothing behind.
