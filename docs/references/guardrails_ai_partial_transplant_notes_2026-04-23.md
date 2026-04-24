# Guardrails AI 部分移植メモ（2026-04-23）

> Purpose: MiniGuard へ移植する際の外部根拠メモ（設計思想 + ライセンス確認）

---

## 1) 参照元

1. Guardrails LICENSE（Apache-2.0）  
   - https://raw.githubusercontent.com/guardrails-ai/guardrails/main/LICENSE

2. Guardrails README（Guard / Validator / OnFailAction の利用例）  
   - https://raw.githubusercontent.com/guardrails-ai/guardrails/main/README.md

3. 本リポジトリ参照  
   - `docs/references/Filtering AI Story Summaries for Quality.md`

---

## 2) 抽出した要点（移植対象）

1. Guard + Validator の連鎖実行モデル
2. on_fail の明示的アクション分岐（例外・再試行）
3. 複数バリデータの合成運用
4. 失敗理由に基づく再試行戦略

---

## 3) ライセンス観点の扱い

- Guardrails は Apache-2.0。  
- したがって、**コードを直接流用する場合**は出典明記・変更明記・ライセンス保持が必要。  
- 今回の設計方針は、まず「挙動移植（クリーンルーム実装）」を優先する。

---

## 4) episodic-claw への反映先

- 詳細設計:  
  `docs/architecture/narrative_worker_miniguard_hardening_design.md`

---

## 5) メモ

このファイルは「ネット調査結果のローカル保存（ダウンロード相当）」のための参照メモであり、
本体仕様は architecture 側を正とする。
