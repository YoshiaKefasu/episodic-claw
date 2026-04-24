/**
 * runtime-mode.ts — [v0.4.28d][D1] Runtime mode detection (pure function).
 *
 * Extracted from index.ts for testability — no dependencies on any other module.
 * This allows unit testing without triggering the full import chain (rpc-client, etc.).
 *
 * Deferred items (see v0.4.28d plan, Deferral Record):
 * - OPENCLAW_SERVICE_KIND env priority check
 * - "node" daemon classification
 * Both require register() lazy-init refactor to be safe (see incident 2026-04-24).
 */

/** Known daemon subcommands in OpenClaw's argv. */
const DAEMON_CMDS = ["gateway", "agent", "test"] as const;

/** Result of runtime mode detection. */
export interface RuntimeModeResult {
  mode: "daemon" | "cli";
  reason: string;
}

/**
 * Resolve runtime mode from argv (pure function, no side effects).
 *
 * - daemon: argv contains a known daemon subcommand (gateway | agent | test).
 * - cli: everything else (including "node" and "start" — see comments below).
 *
 * "start" is excluded because npm start / yarn start also put "start" in argv.
 * "node" is currently excluded — daemon classification for node is deferred to a
 * follow-up PR pending register() lazy-init refactor (see v0.4.28d plan, Deferral Record).
 *
 * OPENCLAW_SERVICE_KIND env priority is also deferred — setting SERVICE_KIND=node would
 * return mode=daemon, which triggers full initialization (NarrativeWorker + OpenRouterClient +
 * kuromojin + watchers) and would worsen the gateway timeout issue (incident 2026-04-24).
 */
export function resolveRuntimeMode(argv: string[]): RuntimeModeResult {
  const matchedCmd = DAEMON_CMDS.find(cmd => argv.includes(cmd));
  if (matchedCmd) {
    return { mode: "daemon", reason: `argv:${matchedCmd}` };
  }
  return { mode: "cli", reason: "argv:no-daemon-cmd" };
}
