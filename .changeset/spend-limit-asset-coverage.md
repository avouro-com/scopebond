---
"@scopebond/verify": patch
"@scopebond/policy-schema": patch
"@scopebond/framework": patch
---

`spend_limit` compares assets with case, width and surrounding space taken away, so an action in `usdc` is limited by a clause for `USDC` instead of counting as spending nothing; windowed totals count earlier actions in any spelling of the asset. An action that carries an amount without an asset is denied under a spend limit. A `spend_limit` clause may now name the money actions it covers in `action_types` (a nonempty list of action types): an action of a listed type is then denied when it names no asset, an asset no spend clause for its type limits, or no amount. The framework tool guard lifts only an asset that is a nonempty string and an amount that is a whole nonnegative number; any other value (an amount sent as text, an asset that is not a string, a fractional or negative amount) is left out, so the spend limit denies the call instead of the guard throwing or the call passing as spending nothing.
