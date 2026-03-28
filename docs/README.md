# episodic-claw ドキュメント索引

## 概要レポート
- [compression_analysis_report.md](./compression_analysis_report.md) — Phase 1〜5 全体設計・実装トレース（E2E 検証結果含む）
- [session_boundary_gap_report.md](./session_boundary_gap_report.md) — セッション境界ギャップ対策
- [model_fallback_impact_report.md](./model_fallback_impact_report.md) — モデルフォールバック対策
- [buffer_config_plan.md](./buffer_config_plan.md) — バッファサイズ設定化

## テスト計画・レポート
- [phase_5_integration_test_report.md](./phase_5_integration_test_report.md) — Phase 5.5〜5.9 統合テスト（メイン・全 PASS）
- [phase_5.6_test_plan.md](./phase_5.6_test_plan.md) — Phase 5.6 テストプラン
- [phase_5.7_test_plan.md](./phase_5.7_test_plan.md) — Phase 5.7 Sleep Consolidation
- [phase_5.8_test_plan.md](./phase_5.8_test_plan.md) — Phase 5.8 Rebuild / フォールバック耐性
- [phase_5.9_test_plan.md](./phase_5.9_test_plan.md) — Phase 5.9 TPM・Circuit Breaker・実動作

## 今後の計画
- [phase_6_topics_plan.md](./phase_6_topics_plan.md) — Phase 6 Semantic Topics プラン

## 研究資料
- [12669_Human_inspired_Episodic_.pdf](./12669_Human_inspired_Episodic_.pdf) — 人間記憶システム参考論文

## 実装詳細 (Implementation/)
- [compression-audits/](./Implementation/compression-audits/) — compression_analysis_report の監査履歴（Round 1〜7）
- [issues/](./Implementation/issues/) — 個別課題追跡
- [phase-1/](./Implementation/phase-1/) 〜 [phase-5.5/](./Implementation/phase-5.5/) — フェーズ別実装ドキュメント
- [api-rpm-optimization/](./Implementation/api-rpm-optimization/) — API RPM 最適化
- [cli-blocker/](./Implementation/cli-blocker/) — CLI ブロッカー対応
- [ep-save-fix/](./Implementation/ep-save-fix/) — ep-save 修正
- [ep-tools-refactor/](./Implementation/ep-tools-refactor/) — ep-tools リファクタ
- [general/](./Implementation/general/) — 一般技術調査
- [issue_api_429_resilience_audit.md](./Implementation/issue_api_429_resilience_audit.md) — 429 耐性監査
- [issue_tpm_embed_truncation.md](./Implementation/issue_tpm_embed_truncation.md) — TPM 超過問題分析
- [phase-5.5-frontmatter/](./Implementation/phase-5.5-frontmatter/) — Frontmatter 欠落調査
