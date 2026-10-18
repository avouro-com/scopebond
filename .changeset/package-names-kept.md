---
"@scopebond/hook": patch
"@scopebond/policy-schema": patch
---

Package names and versions in an install are recorded as written. A long scoped name such as `@a-long-scope-name-20-lite/archetype` was masked as `@***`, so Safe Install could not check it by name, and a long repository path in an install URL broke the URL's host. Token shapes, URL credentials and parts that read like a key are still masked. New install-detection vectors cover long names, a key-like name and a URL with credentials.
