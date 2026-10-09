---
"@scopebond/hook": patch
"@scopebond/gateway": patch
---

Remove more typed secrets before a receipt is signed: PowerShell environment variables set with `Set-Item Env:`, `New-Item`, `Set-Content`, `[Environment]::SetEnvironmentVariable` or `setx`; credential-named variables and hashtable entries (`$token = '…'`, `@{ Authorization = 'Bearer …' }`); `ConvertTo-SecureString` strings in any parameter order or piped in; a value piped into `--password-stdin`; and a URL password that contains "@".
