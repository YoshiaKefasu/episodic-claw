import * as fs from "fs";
import * as path from "path";

const MAX_SIZE_BYTES = 50 * 1024; // 50KB を超えるエピソードは異常とみなす

async function cleanupWorkspace(wsPath: string) {
  const episodesDir = path.join(wsPath, "episodes");
  if (!fs.existsSync(episodesDir)) {
    console.log(`[Cleanup] Directory not found: ${episodesDir}`);
    return;
  }

  const files = fs.readdirSync(episodesDir);
  let deletedCount = 0;

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    
    const filePath = path.join(episodesDir, file);
    const stats = fs.statSync(filePath);
    
    let shouldDelete = false;
    let reason = "";

    if (stats.size > MAX_SIZE_BYTES) {
      shouldDelete = true;
      reason = `Size exceeded (${(stats.size / 1024).toFixed(2)} KB)`;
    } else {
      const content = fs.readFileSync(filePath, "utf-8");
      // ツール実行結果の生出力が含まれているかチェック
      if (content.includes("toolResult:") || content.includes("tool_result:")) {
        shouldDelete = true;
        reason = "Contains toolResult / tool_result";
      }
    }

    if (shouldDelete) {
      console.log(`[Cleanup] Deleting ${file} - Reason: ${reason}`);
      fs.unlinkSync(filePath);
      deletedCount++;
    }
  }

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
