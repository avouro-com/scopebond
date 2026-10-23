export type ExecutionEnvironment = "windows" | "macos" | "linux" | "wsl" | "container" | "remote" | "unknown";

/** Classifies this agent process only. A host installation never certifies execution in a different environment. */
export function executionEnvironment(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): ExecutionEnvironment {
  if (env.CODESPACES || env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return "remote";
  if (env.REMOTE_CONTAINERS || env.REMOTE_CONTAINERS_IPC || env.container || env.CONTAINER) return "container";
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return "wsl";
  return platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform === "linux" ? "linux" : "unknown";
}
