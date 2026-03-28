const fs = require("fs");
const path = require("path");
const os = require("os");

// Windows は chmod が不要（実行権限の概念がない）
if (os.platform() === "win32") {
  process.exit(0);
}

const binaries = [
  path.join(__dirname, "..", "dist", "episodic-core")
];

for (const bin of binaries) {
  if (fs.existsSync(bin)) {
    try {
      fs.chmodSync(bin, 0o755);
      console.log(`[episodic-claw] chmod 755: ${bin}`);
    } catch (e) {
      console.warn(`[episodic-claw] chmod failed (non-fatal): ${e.message}`);
    }
  }
}
