# @scopebond/native (not published)

The single-file Scopebond Agent and hook: a [Node single executable application](https://nodejs.org/api/single-executable-applications.html)
built from `@scopebond/agent` and `@scopebond/hook`. One file is both:

- the Scopebond Agent: `scopebond-agent.exe run`, `status`, `check`, … (the same commands as `scopebond-agent` from npm);
- the hook a coding agent runs for each tool call: `scopebond-agent.exe hook claude` (or `cursor`, `codex`), and every
  other hook command after `hook` (`hook init`, `hook log`, `hook rules`, …).

It needs neither npm nor npx at run time, and it is the file the signed Windows installer ships.

## Build

```sh
pnpm -r build
node packages/native/build-sea.mjs     # → packages/native/build/scopebond-agent(.exe)
```

The build bundles the agent and the hook into one CommonJS file with esbuild (versions fixed at build time), makes a
single executable application blob with a code cache, copies the Node that runs the build, removes that copy's own
signature and injects the blob with postject. It is unsigned; the release workflow signs it.

## Test

`node --test packages/native/test/` checks the bundle everywhere. With `SCOPEBOND_SEA=1` it also builds the executable
and checks that it decides Claude Code calls exactly as the npm hook does and how quickly it starts (CI runs this on
Windows).
