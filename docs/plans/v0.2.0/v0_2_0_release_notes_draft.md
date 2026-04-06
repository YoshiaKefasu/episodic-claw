# v0.2.0 Release Notes Draft

更新日: 2026-03-30

## Highlights

- Empty embed / empty summary hardening for ingest, rebuild, heal, recall, and consolidation
- `topics` metadata for D0 and D1
- Bayesian segmentation for adaptive boundaries
- Human-like D1 consolidation with boundary-aware clustering
- D1-first replay scheduling
- Topics-aware recall with lightweight Bayesian rerank
- Recall calibration guardrails and telemetry bridge
- Release-readiness telemetry closure and structured observability

## Notable Behavior Changes

- `ep-recall` can use `topics` as a strict facet or soft hint depending on the caller
- Replay state is kept separate from episode body data
- Recall results now carry score breakdown fields for calibration and future importance analysis
- Replay scheduler writes a structured run summary for health checks

## Known Limitations

- `importance_score` is not enabled yet
- pruning / tombstone automation is still out of scope
- telemetry is intentionally append-only and not a full analytics pipeline

## Recovery Notes

- If replay or recall behavior drifts, check the `replay:last_summary` meta key and the structured logs first
- If topics recall looks sparse, confirm whether the caller used strict mode or soft mode
- If active D0 drift is suspected, rebuild the active D0 index before tuning recall weights

---

## 🔍 Audit Report — Round 1
> Reviewed from the perspective of an IBM / Google Pro Engineer  
> Date: 2026-03-30  
> Mode: Pre-Implementation  
> Prior audits: 0 | New findings this round: 0

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| None | ✅ N/A |

<!-- ✅ No new critical issues found. Document has converged. -->

### ⚠️ Impact on Related Features *(new only)*
- None identified.

### 🚨 Potential Problems & Risks *(new only)*
- None identified.

### 📋 Missing Steps & Considerations *(new only)*
- None identified.

### 🕳️ Unaddressed Edge Cases *(new only)*
- None identified.

### ✅ Recommended Actions
| Priority | Action | Reason | Is New? |
|----------|--------|--------|---------|
| LOW | Keep the release notes aligned with `docs/v0.2.0/README.md` and the root `README.md` so consumers do not mistake the draft for a different release line. | Avoids release-note drift and version confusion. | ✅ New |
