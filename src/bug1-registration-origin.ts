export type RegistrationOrigin = "web-fetch-snapshot" | "memory-runtime" | "embedded-runtime" | "unknown";

// 関数名パターンは KASOU 実ログから抽出（docs/plans/v0.4.x/v0.4.31_bug1_episodic_claw_root_fix.md §B1-B2a）。
// OpenClaw が改名した場合は "unknown" に戻り、singleton guard にフォールバックする。
export function classifyRegistrationOrigin(stack?: string): RegistrationOrigin {
  if (!stack) return "unknown";
  if (
    stack.includes("resolvePluginWebFetchProviders") ||
    stack.includes("resolveRuntimeWebTools") ||
    stack.includes("prepareSecretsRuntimeSnapshot")
  ) {
    return "web-fetch-snapshot";
  }
  if (stack.includes("ensureMemoryRuntime") || stack.includes("resolveActiveMemoryBackendConfig")) {
    return "memory-runtime";
  }
  if (stack.includes("ensureRuntimePluginsLoaded") || stack.includes("resolveRuntimePluginRegistry")) {
    return "embedded-runtime";
  }
  return "unknown";
}
