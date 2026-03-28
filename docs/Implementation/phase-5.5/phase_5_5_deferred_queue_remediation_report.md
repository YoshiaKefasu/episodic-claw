# Phase 5.5: Deferred Queue Remediation & Reliability Report

提供いただいた監査レポート（Google Pro Engineer Audit）の指摘事項を全て反映し、致命的リスクを抱える同期的な `Deferred Queue` 実装を完全に破棄して「**代替案A（即時MD5フォールバック＋非同期リネーマー）**」のアーキテクチャへの全面移行を完了しました。さらに、120点満点の堅牢性を目指すためのマイナーTipsも反映済みです。

## 修正内容のハイライト
1. **プロセスフリーズとタイムアウトリスクの排除 (`main.go`)**
   - `handleSurprise` を長時間ブロックする原因となっていた `drainDeferredQueue` 関数および `time.Sleep` をすべて撤去しました。
   - `handleIngest` / `handleBatchIngest` 内部の固定スリープ付き再試行ループを完全に排除しました。エラー（429等）が発生した場合は即座に実行結果を確定して次に進みます。

2. **完全なデータ堅牢化のためのMD5フォールバック (`main.go`)**
   - エピソードの要約に対するAIからのスラッグ（ID）生成が失敗したり品質エラーが出た場合、**即座にその要約文のMD5ハッシュ値を取り、`episode-[16文字のハッシュ]` というIDで安全に保存**するようにしました。
   - これにより、揮発性のインメモリリストによるプロセス再起動時のエピソード消失リスクを完全に根絶しました。データは即座にファイルとして SSoT (Single Source of Truth) に刻まれます。

3. **安全な非同期リネーム機能 (Asynchronous Slug Refiner)**
   - 新設した `RunAsyncSlugRefiner` が、メインリクエストを一切ブロックすることなく、バックグラウンドでのびのびと未命名（`episode-[hash]`）のファイルを探索し、裏でゆっくりとAIに適切なスラッグを考案させます。
   - 良いスラッグが生成できたら、ファイル名変更・新しいIDでのVector DBの `Add` ・古いハッシュIDの `Delete` を行いクリーンアップします。

## 120点を目指すための「最後の2ピクセル」対応
1. **二重起動防止・排他制御 (`go/internal/vector/store.go`, `go/main.go`)**
   - `vector.Store` 構造体に `IsRefining atomic.Bool` を追加。
   - `RunAsyncSlugRefiner` 実行時に `vstore.IsRefining.CompareAndSwap(false, true)` で排他制御を行い、スキャン中であれば処理をスキップ。万一のキャッシュミス等によるリネーマーの複数同時起動・ファイル競合を完全にシャットアウトしました。

2. **`Delete` メソッドの i2s ゴミ排除 (`go/internal/vector/store.go`)**
   - 新規実装した `vstore.Delete(id)` 実行時に、`epKey` と `s2iKey` に加え、`prefixI2S` (i2sKey) も Pebble DB から綺麗に `Delete` するロジックを追加し、Pebble DB内の不要なメタデータの滞留を防ぎました（Go-HNSW の仕様通りの安全なスキップ動作と組み合わせています）。

## バックグラウンド実行の仕組み
- Workspaceの Vector Store（Pebble DB）がロードされた瞬間に、裏で1度だけスキャンとリネーム（Refine）を実行します。
- さらに `time.NewTicker(30 * time.Minute)` によって **30分おきに自動でスキャンを継続** します。
- 致命的エラー時の一時的なMD5フォールバックファイルも、システムが自動的に補修し続けるクリーンな設計となります。
