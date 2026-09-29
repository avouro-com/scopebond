// The bash oracle: run a command under real bash, in a throwaway sandbox where every
// program it can reach is a stub that only logs its argv, and report what actually
// ran. The hook's mapper reads the command's TEXT; the oracle reports what bash DID
// with it (after quoting, expansion, substitution, aliases, functions, `cd` …), so
// comparing the two measures the mapper's misses and false positives.
//
// Safety: nothing destructive ever runs. PATH holds only the stub directory. The few
// real tools a command may need to reach other stubs (env, timeout, xargs, find, a
// nested bash …) are passthrough stubs that log and then exec the real binary, which
// in turn resolves programs through the same stub-only PATH. Commands that could
// escape the stub PATH (setting PATH, `command -p`, `env -i`, absolute /bin or /usr
// paths) are rejected before they run. Every run gets a fresh sandbox (cwd and HOME)
// whose "secret" files hold only a plain marker string.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const MARK = "SBCANARY";
const FS = "\x1f";
const RS = "\x1e";

/** Programs the starter policy denies by name (the oracle's notion of destructive). */
export const DESTRUCTIVE = ["rm", "rmdir", "shred", "dd", "truncate", "unlink", "wipe", "srm", "sudo", "doas", "mkfs", "shutdown", "reboot", "halt", "poweroff"];

// Stubs that read the content of the files they are given: they check each operand
// (also `@file`, `--flag=file`, `name=@file`) for a marker file and log a read.
const READERS = [
  "cat", "tac", "head", "tail", "less", "more", "nl", "od", "xxd", "hexdump", "strings", "base64", "grep", "egrep", "fgrep",
  "rg", "awk", "sed", "sort", "uniq", "cut", "wc", "diff", "cmp", "jq", "md5sum", "sha256sum", "openssl", "gpg", "tar", "zip",
  "gzip", "cp", "mv", "scp", "rsync", "install", "curl", "wget", "nc", "tee", "vim", "vi", "nano", "less", "bat", "iconv",
];
// Stubs that only log.
const LOGGERS = [
  ...DESTRUCTIVE, "git", "ls", "stat", "file", "touch", "mkdir", "chmod", "chown", "ln", "npm", "npx", "pnpm", "node", "python",
  "python3", "make", "docker", "kubectl", "echo", "printf", "sleep", "date", "whoami", "id", "pwd", "true", "false", "test",
  "which", "basename", "dirname", "tr", "seq", "yes", "go", "cargo", "tsc", "jest", "eslint", "prettier",
];
// Real tools a command may run other programs through; they log, then exec the real
// binary (which resolves programs through the stub-only PATH). The nested shells all
// run under the located bash with --norc --noprofile, so a login profile can never
// reset PATH away from the stub directory.
const PASSTHROUGH = ["env", "timeout", "nice", "nohup", "xargs", "stdbuf", "find"];
const SHELL_PASSTHROUGH = ["bash", "sh", "zsh", "dash", "ksh", "ash", "fish"];

/** Reject a command that could reach a real program instead of a stub. */
export function unsafeReason(command) {
  const rules = [
    [/\bPATH\b/, "touches PATH"],
    [/\bcommand\s+-[A-Za-z]*p/, "command -p uses the default PATH"],
    [/\benv\b[^;&|\n]*\s(?:-[A-Za-z]*i\b|-\s|-$|--ignore-environment|-u\s*PATH)/, "env -i clears PATH"],
    [/\bexec\s+-[A-Za-z]*c/, "exec -c clears the environment"],
    [/(?:^|[\s;&|(`'"=<>])\/(?:usr|bin|sbin|lib|lib64|opt|etc|proc|dev\/sd)(?:\/|\b)/, "absolute system path"],
    [/\b(?:enable|hash)\b/, "rebinds builtins or the command hash"],
    [/(?:^|[\s'"=<>])[A-Za-z]:[\\/]/, "absolute Windows path"],
  ];
  for (const [re, why] of rules) if (re.test(command)) return why;
  return null;
}

function which(bash, names) {
  const r = spawnSync(bash, ["--norc", "--noprofile", "-c", names.map((n) => `command -v ${n} || echo -`).join(";")], { encoding: "utf8" });
  return r.stdout.trim().split(/\r?\n/);
}

/** Locate bash, or null when it is unavailable. */
export function findBash() {
  // An absolute path, because the runs themselves get a stub-only PATH.
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of process.platform === "win32" ? ["bash.exe"] : ["bash"]) {
      const p = join(dir, name);
      if (existsSync(p) && !/system32/i.test(p)) {
        const r = spawnSync(p, ["--norc", "--noprofile", "-c", "echo ok"], { encoding: "utf8" });
        if (r.status === 0 && r.stdout.trim() === "ok") return p;
      }
    }
  }
  return null;
}

function stubScript(bashPath, name, kind, real) {
  const log = '>>"$SB_ORACLE_LOG"';
  const lines = [
    `#!${bashPath}`,
    // One record, one `printf`: a single write(2) to an O_APPEND fd cannot interleave
    // with a concurrent stub's. Building the line with several printfs let the stages of
    // a pipeline (`cat list.txt | head -n 2`) tear each other's records apart.
    `rec='X${FS}${name}'; for a in "$@"; do rec="$rec${FS}$a"; done; printf '%s${RS}' "$rec" ${log}`,
    `for a in "$@"; do case $a in *${MARK}*) printf 'A${RS}' ${log};; esac; done`,
  ];
  if (kind === "reader") {
    lines.push(
      `chk() { local f=$1 l=; [ -n "$f" ] || return 0; if [ -f "$f" ] && [ -r "$f" ]; then IFS= read -r l <"$f"; elif [ -d "$f" ] && [ -f "$f/.sbmarker" ]; then IFS= read -r l <"$f/.sbmarker"; fi; case $l in ${MARK}*) printf 'R${FS}%s${RS}' "$l" ${log};; esac; }`,
      `for a in "$@"; do chk "$a"; chk "\${a#@}"; case $a in *=*) v=\${a#*=}; chk "$v"; chk "\${v#@}";; esac; done`,
    );
  }
  if (kind === "shell") {
    // Every nested shell runs under bash with the profile suppressed, so PATH stays
    // the stub directory (a login shell must never resolve a program to a real one).
    lines.push(`exec "${bashPath}" --norc --noprofile "$@"`);
  } else if (kind === "passthrough") {
    // Belt and braces for the corpus guard: never let env clear the environment.
    if (name === "env") lines.push(`for a in "$@"; do case $a in -i|-|--ignore-environment|-*i*) [ "\${a#--}" = "$a" ] && exit 126;; esac; done`);
    lines.push(`exec "${real}" "$@"`);
  } else {
    lines.push(`if [ ! -t 0 ]; then while IFS= read -r l || [ -n "$l" ]; do case $l in *${MARK}*) printf 'S${RS}' ${log};; esac; done; fi`, "exit 0");
  }
  return lines.join("\n") + "\n";
}

/**
 * Read a stub log into the programs that ran and the marker leaks observed.
 *
 * Every record carries a known tag, so an unknown one means the log is corrupt.
 * Reporting corruption as a leak would invent a secret read on a harmless command —
 * the failure this replaced — so it throws instead of guessing.
 */
export function parseLog(text, command = "") {
  const execs = [];
  const leaks = [];
  for (const rec of text.split(RS).filter(Boolean)) {
    const x = rec.split(FS);
    if (x[0] === "X") execs.push({ program: x[1], argv: x.slice(2) });
    else if (x[0] === "R") leaks.push(`read ${x[1]}`);
    else if (x[0] === "A") leaks.push("marker in argv");
    else if (x[0] === "S") leaks.push("marker on stdin");
    else throw new Error(`oracle log corrupt for ${JSON.stringify(command)}: unknown record ${JSON.stringify(rec)}`);
  }
  return { execs, leaks };
}

/** Build the stub directory once; returns a runner for single commands. */
export function createOracle() {
  const bash = findBash();
  if (!bash) return null;
  const [bashPath] = which(bash, ["bash"]);
  const reals = which(bash, PASSTHROUGH);
  const root = mkdtempSync(join(tmpdir(), "sb-oracle-"));
  const stubs = join(root, "stubs");
  mkdirSync(stubs);
  const put = (dir, name, kind, real) => { const p = join(dir, name); writeFileSync(p, stubScript(bashPath, name, kind, real)); chmodSync(p, 0o755); };
  for (const n of new Set(READERS)) put(stubs, n, "reader");
  for (const n of new Set(LOGGERS)) if (!READERS.includes(n)) put(stubs, n, "logger");
  PASSTHROUGH.forEach((n, i) => { if (reals[i] && reals[i] !== "-") put(stubs, n, "passthrough", reals[i]); });
  for (const n of SHELL_PASSTHROUGH) put(stubs, n, "shell");
  const slash = (p) => p.replace(/\\/g, "/");

  function sandbox() {
    const box = mkdtempSync(join(root, "run-"));
    const work = join(box, "work");
    const home = join(box, "home");
    const file = (base, rel, text) => { const p = join(base, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text + "\n"); };
    // Protected files: each holds only a marker naming it.
    file(work, ".env", `${MARK}_env`);
    file(work, ".env.production", `${MARK}_env_production`);
    file(work, "config/.env.local", `${MARK}_env_local`);
    file(work, ".scopebond/agent.key", `${MARK}_agent_key`);
    file(work, ".scopebond/.sbmarker", `${MARK}_scopebond_dir`);
    file(work, "secrets/deploy.pem", `${MARK}_deploy_pem`);
    file(home, ".ssh/id_rsa", `${MARK}_ssh_id`);
    file(home, ".ssh/.sbmarker", `${MARK}_ssh_dir`);
    file(home, ".aws/credentials", `${MARK}_aws`);
    file(home, ".npmrc", `${MARK}_npmrc`);
    // Ordinary files.
    file(work, ".env.example", "PLACEHOLDER=1");
    file(work, "README.md", "readme");
    file(work, "src/index.js", "export {};");
    file(work, "list.txt", "a\nb");
    file(work, "notes/todo.txt", "todo");
    file(home, ".ssh/id_rsa.pub", "public");
    file(home, ".ssh/known_hosts", "hosts");
    file(home, ".aws/config", "config");
    // A copy of the rm stub reachable by relative path (`./bin/rm`).
    mkdirSync(join(work, "bin"));
    put(join(work, "bin"), "rm", "logger");
    return { box, work, home };
  }

  const PRELUDE = "shopt -s expand_aliases\n";

  /** Run one command; returns what bash actually executed and whether it was harmful. */
  function run(command, { branch = "feature/work" } = {}) {
    const why = unsafeReason(command);
    if (why) throw new Error(`refusing to run ${JSON.stringify(command)}: ${why}`);
    const { box, work, home } = sandbox();
    const log = join(box, "log");
    writeFileSync(log, "");
    const r = spawnSync(bash, ["--norc", "--noprofile", "-c", PRELUDE + command], {
      cwd: work, input: "", encoding: "utf8", timeout: 10000,
      env: { PATH: stubs, HOME: slash(home), SB_ORACLE_LOG: slash(log), LANG: "C", LC_ALL: "C" },
    });
    if (r.error) throw new Error(`oracle run failed for ${JSON.stringify(command)}: ${r.error.message}`);
    const { execs, leaks } = parseLog(readFileSync(log, "utf8"), command);
    if (`${r.stdout}${r.stderr}`.includes(MARK)) leaks.push("marker in output");
    // A secret copied or redirected into an ordinary file.
    const scan = (dir, skip) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== skip) scan(p); }
        else if (e.isFile() && statSync(p).size < 65536 && e.name !== ".sbmarker") {
          const rel = p.slice(box.length + 1).replace(/\\/g, "/");
          if (!PROTECTED_FILES.has(rel) && readFileSync(p, "utf8").includes(MARK)) leaks.push(`marker copied into ${rel}`);
        }
      }
    };
    scan(work, "bin");
    scan(home);
    rmSync(box, { recursive: true, force: true });
    const destructive = execs.filter((e) => DESTRUCTIVE.includes(e.program)).map((e) => e.program);
    const pushes = execs.filter((e) => e.program === "git").map((e) => protectedPush(e.argv, branch)).filter(Boolean);
    return { execs, destructive, pushes, leaks: [...new Set(leaks)], secretRead: leaks.length > 0, exit: r.status };
  }

  return { run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// The protected files themselves (they hold a marker from the start).
const PROTECTED_FILES = new Set([
  "work/.env", "work/.env.production", "work/config/.env.local", "work/.scopebond/agent.key", "work/secrets/deploy.pem",
  "home/.ssh/id_rsa", "home/.aws/credentials", "home/.npmrc",
]);

const PROTECTED_REF = /^(?:main|master)$|^release\//i;

/** If this git argv pushes a protected branch, the destination it pushes; else null.
 *  An independent, deliberately plain reading of `git push` (the oracle's notion). */
export function protectedPush(argv, branch) {
  let i = 0;
  while (i < argv.length && argv[i].startsWith("-")) i += /^(?:-C|-c|--git-dir|--work-tree|--namespace)$/.test(argv[i]) ? 2 : 1;
  const sub = argv[i];
  // A low-level push (`send-pack`, `http-push`) names its refs as plain operands.
  if (sub === "send-pack" || sub === "http-push") {
    for (const ref of argv.slice(i + 1).filter((t) => !t.startsWith("-"))) {
      const d = ref.replace(/^\+/, "").replace(/^refs\/heads\//, "").replace(/^heads\//, "");
      if (PROTECTED_REF.test(d)) return d;
    }
    return null;
  }
  if (sub !== "push") return null;
  const positional = [];
  let repo = null;
  for (let k = i + 1; k < argv.length; k++) {
    const t = argv[k];
    if (/^--(?:all|mirror|branches)$/.test(t)) return t;
    if (t === "--repo") { repo = argv[++k]; continue; }
    if (t.startsWith("--repo=")) { repo = t.slice("--repo=".length); continue; }
    if (/^(?:-o|--push-option|--receive-pack|--exec)$/.test(t)) { k++; continue; }
    if (t.startsWith("-")) continue;
    positional.push(t);
  }
  const specs = repo !== null ? positional : positional.slice(1);
  const dsts = specs.length ? specs : [branch];
  for (const spec of dsts) {
    const s = spec.replace(/^\+/, "");
    const colon = s.indexOf(":");
    let dst = colon >= 0 ? s.slice(colon + 1) || s.slice(0, colon) : s;
    dst = dst.replace(/^refs\/heads\//, "").replace(/^heads\//, "");
    if (dst === "HEAD" || dst === "@") dst = branch;
    if (PROTECTED_REF.test(dst)) return dst;
  }
  return null;
}
