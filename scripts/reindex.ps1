#!/usr/bin/env pwsh
# episodic-claw reindex: codesight + graphify in one shot
# Usage: .\scripts\reindex.ps1 [-NoGraphify]

param([switch]$NoGraphify)

$ROOT = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
Set-Location $ROOT

Write-Host "`n=== episodic-claw Reindex ===`n"

# ---- codesight (MCP用スキャン + wiki) ----
Write-Host "[1/2] codesight scan + wiki..."
npx codesight --wiki --no-ai-summaries --no-semantic
if ($LASTEXITCODE -ne 0) { Write-Host "[WARN] codesight exit code: $LASTEXITCODE" }
Write-Host ""

# ---- graphify (グラフ構造) ----
if (-not $NoGraphify) {
    Write-Host "[2/2] graphify update..."
    python3 -m graphify update .
    if ($LASTEXITCODE -ne 0) { Write-Host "[WARN] graphify exit code: $LASTEXITCODE" }
    Write-Host ""
}

Write-Host "=== Done ==="
Write-Host "  codesight: .codesight/ (MCP + wiki)"
Write-Host "  graphify:  graphify-out/ (graph.json + GRAPH_REPORT.md)"
Write-Host ""
