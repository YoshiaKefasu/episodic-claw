import * as fs from "fs";
import * as path from "path";

const MAX_SIZE_BYTES = 50 * 1024; // 50KB を超えるエピソードは異常とみなす

function scanAndCleanup(dir: string): number {
  let deletedCount = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      deletedCount += scanAndCleanup(fullPath);
      continue;
    }

    if (!entry.name.endsWith(".md")) continue;

    const stats = fs.statSync(fullPath);
    let shouldDelete = false;
    let reason = "";

    if (stats.size > MAX_SIZE_BYTES) {
      shouldDelete = true;
      reason = `Size exceeded (${(stats.size / 1024).toFixed(2)} KB)`;
    } else {
      const content = fs.readFileSync(fullPath, "utf-8");
      if (content.includes("toolResult:") || content.includes("tool_result:")) {
        shouldDelete = true;
        reason = "Contains toolResult / tool_result";
      }
    }

    if (shouldDelete) {
      console.log(`[Cleanup] Deleting ${fullPath} - Reason: ${reason}`);
      fs.unlinkSync(fullPath);
      deletedCount++;
    }
  }

  return deletedCount;
}

async function cleanupWorkspace(wsPath: string) {
  const episodesDir = path.join(wsPath, "episodes");
  if (!fs.existsSync(episodesDir)) {
    console.log(`[Cleanup] Directory not found: ${episodesDir}`);
    return;
  }

  const deletedCount = scanAndCleanup(episodesDir);

  console.log(`[Cleanup] Finished. Deleted ${deletedCount} polluted episodes in ${wsPath}.`);
  console.log(`[Cleanup] 注意: GoサイドカーのベクトルDBに反映させるため、エージェントを再起動するか、episodes.db を削除してインデックスを再構築してください。`);
}

const targetWs = process.argv[2];
if (!targetWs) {
  console.error("Usage: npx ts-node scripts/cleanup-polluted-episodes.ts <path-to-agent-workspace>");
  console.error("Example: npx ts-node scripts/cleanup-polluted-episodes.ts C:/Users/yosia/.gemini/tmp/openclaw-related-repos");
  process.exit(1);
}

cleanupWorkspace(targetWs).catch(console.error);
