---
"@scopebond/hook": minor
---

On a computer whose rules your workspace sets with signed answers, the hook now checks the rules files it uses against the signed answer they came from, not only when it downloads them. The answer is kept as received (`managed-answer.json`, beside `policy.json`) with what it compiled to, and the compiled rules, the workspace's rules document and the rule pack list are checked against it each time one of them changes (an unchanged computer pays only a few file checks per action). If any of them was changed outside Scopebond, even into a file that still reads correctly, the action is blocked with the reason, and the rules are fetched from the workspace and installed again at once. `packs add` and `packs remove` now say the workspace sets the rule packs where its signed answer names them. Computers that use their own rules, or whose workspace does not sign its answers, work as before.
