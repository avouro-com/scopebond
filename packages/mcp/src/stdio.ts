// Stdio plumbing for the `scopebond-mcp` CLI: a newline-delimited reader with a line-length
// cap, and the allow-listed environment the upstream server is started with.

import type { Readable } from "node:stream";

/** The largest JSON-RPC line the proxy reads from either side (8 MiB). */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Read newline-delimited lines from a stream. A line longer than `maxBytes` is never buffered
 *  in full: its bytes are dropped as they arrive and `onOversize` is called once it ends. */
export function readLines(stream: Readable, maxBytes: number, onLine: (line: string) => void, onOversize: () => void): void {
  let parts: Buffer[] = [];
  let size = 0;
  let discarding = false;
  const finish = (): void => {
    if (discarding) { discarding = false; onOversize(); }
    else if (parts.length) {
      let line = Buffer.concat(parts).toString("utf8");
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
    parts = []; size = 0;
  };
  stream.on("data", (chunk: Buffer | string) => {
    let buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    while (buf.length) {
      const nl = buf.indexOf(0x0a);
      const piece = nl < 0 ? buf : buf.subarray(0, nl);
      if (!discarding) {
        if (size + piece.length > maxBytes) { discarding = true; parts = []; size = 0; }
        else { parts.push(piece); size += piece.length; }
      }
      if (nl < 0) break;
      finish();
      buf = buf.subarray(nl + 1);
    }
  });
  stream.on("end", () => { if (parts.length || discarding) finish(); });
}

// The variables an upstream server needs to start and find its tools. Everything else in the
// proxy's environment (Cloud credentials, tokens, keys meant for other tools) stays with the
// proxy unless it is passed explicitly with --env.
const POSIX_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TERM"];
const WINDOWS_ENV = [
  "PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP", "USERPROFILE", "USERNAME",
  "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
];

/** The environment the upstream is spawned with: the allow-listed variables that are set, plus
 *  each `--env NAME` (passed through from the proxy's environment) or `--env NAME=value`. */
export function upstreamEnv(parent: NodeJS.ProcessEnv, passes: string[], platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of platform === "win32" ? WINDOWS_ENV : POSIX_ENV) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  for (const pass of passes) {
    const eq = pass.indexOf("=");
    const name = eq < 0 ? pass : pass.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_().-]*$/.test(name)) throw new Error(`--env ${JSON.stringify(pass)}: not a variable name`);
    if (eq >= 0) env[name] = pass.slice(eq + 1);
    else if (parent[name] !== undefined) env[name] = parent[name];
  }
  return env;
}
