#!/usr/bin/env node
/**
 * postinstall.js — downloads the platform-appropriate Go sidecar binary
 * from GitHub Releases if it is not already present in dist/.
 *
 * This keeps the npm package under 10MB by not bundling the ~24MB Go binaries.
 * The binary is fetched once at install time and cached in dist/.
 *
 * Download URL pattern:
 *   https://github.com/YoshiaKefasu/episodic-claw/releases/download/v{version}/{binary}
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

const pkg = require("../package.json");
const version = pkg.version;

const REPO = "YoshiaKefasu/episodic-claw";
const DIST = path.join(__dirname, "..", "dist");

const platform = os.platform();
const binaryName = platform === "win32" ? "episodic-core.exe" : "episodic-core";
const binaryPath = path.join(DIST, binaryName);
const downloadURL = `https://github.com/${REPO}/releases/download/v${version}/${binaryName}`;

// Already present — nothing to do
if (fs.existsSync(binaryPath)) {
  if (platform !== "win32") {
    try { fs.chmodSync(binaryPath, 0o755); } catch (_) {}
  }
  console.log(`[episodic-claw] Sidecar binary already present: ${binaryPath}`);
  process.exit(0);
}

// Ensure dist/ exists
if (!fs.existsSync(DIST)) {
  fs.mkdirSync(DIST, { recursive: true });
}

console.log(`[episodic-claw] Downloading Go sidecar binary for ${platform}...`);
console.log(`[episodic-claw] ${downloadURL}`);

function download(url, dest, redirectCount = 0) {
  if (redirectCount > 5) {
    console.error("[episodic-claw] Too many redirects. Download failed.");
    process.exit(1);
  }

  https.get(url, { headers: { "User-Agent": "episodic-claw-postinstall" } }, (res) => {
    if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
      return download(res.headers.location, dest, redirectCount + 1);
    }

    if (res.statusCode !== 200) {
      console.error(`[episodic-claw] Download failed: HTTP ${res.statusCode}`);
      console.error("[episodic-claw] You can download manually:");
      console.error(`  ${downloadURL}`);
      console.error(`  → Place it at: ${binaryPath}`);
      process.exit(1);
    }

    const total = parseInt(res.headers["content-length"] || "0", 10);
    let received = 0;
    const file = fs.createWriteStream(dest);

    res.on("data", (chunk) => {
      received += chunk.length;
      if (total > 0) {
        const pct = Math.floor((received / total) * 100);
        process.stdout.write(`\r[episodic-claw] ${pct}% (${(received / 1024 / 1024).toFixed(1)} MB)`);
      }
    });

    res.pipe(file);

    file.on("finish", () => {
      file.close();
      process.stdout.write("\n");

      if (platform !== "win32") {
        try { fs.chmodSync(dest, 0o755); } catch (_) {}
      }

      console.log(`[episodic-claw] Binary ready: ${dest}`);
    });

    file.on("error", (err) => {
      fs.unlink(dest, () => {});
      console.error("[episodic-claw] File write error:", err.message);
      process.exit(1);
    });
  }).on("error", (err) => {
    console.error("[episodic-claw] Network error:", err.message);
    console.error("[episodic-claw] You can download manually:");
    console.error(`  ${downloadURL}`);
    console.error(`  → Place it at: ${binaryPath}`);
    process.exit(1);
  });
}

download(downloadURL, binaryPath);
