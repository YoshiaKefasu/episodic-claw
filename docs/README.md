# episodic-claw ドキュメント索引

## 概要レポート
- [compression_analysis_report.md](./reports/compression_analysis_report.md) — Phase 1〜5 全体設計・実装トレース（E2E 検証結果含む）
- [session_boundary_gap_report.md](./reports/session_boundary_gap_report.md) — セッション境界ギャップ対策
- [model_fallback_impact_report.md](./reports/model_fallback_impact_report.md) — モデルフォールバック対策
- [buffer_config_plan.md](./reports/buffer_config_plan.md) — バッファサイズ設定化

## テスト計画・レポート
- [phase_5_integration_test_report.md](./phase-5-tests/phase_5_integration_test_report.md) — Phase 5.5〜5.9 統合テスト（メイン・全 PASS）
- [phase_5.6_test_plan.md](./phase-5-tests/phase_5.6_test_plan.md) — Phase 5.6 テストプラン
- [phase_5.7_test_plan.md](./phase-5-tests/phase_5.7_test_plan.md) — Phase 5.7 Sleep Consolidation
- [phase_5.8_test_plan.md](./phase-5-tests/phase_5.8_test_plan.md) — Phase 5.8 Rebuild / フォールバック耐性
- [phase_5.9_test_plan.md](./phase-5-tests/phase_5.9_test_plan.md) — Phase 5.9 TPM・Circuit Breaker・実動作

## 今後の計画
- [semantic_topics_plan.md](./semantic_topics_plan.md) — Phase 6 Semantic Topics プラン

## 研究資料
- [12669_Human_inspired_Episodic_.pdf](./12669_Human_inspired_Episodic_.pdf) — 人間記憶システム参考論文

## 実装詳細 ()
- [compression-audits/](./compression-audits/) — compression_analysis_report の監査履歴（Round 1〜7）
- [issues/](./issues/) — 個別課題追跡（issue_api_429_resilience_audit、issue_tpm_embed_truncation 含む）
- [phase-1/](./phase-1/) 〜 [phase-5.5/](./phase-5.5/) — フェーズ別実装ドキュメント
- [phase-5-tests/](./phase-5-tests/) — Phase 5.5〜5.9 テスト計画・レポート
- [reports/](./reports/) — 設計・調査レポート群
- [api-rpm-optimization/](./api-rpm-optimization/) — API RPM 最適化
- [cli-blocker/](./cli-blocker/) — CLI ブロッカー対応
- [ep-save-fix/](./ep-save-fix/) — ep-save 修正
- [ep-tools-refactor/](./ep-tools-refactor/) — ep-tools リファクタ
- [general/](./general/) — 一般技術調査
- [phase-5.5-frontmatter/](./phase-5.5-frontmatter/) — Frontmatter 欠落調査
