# 実装前仕様書

更新日: 2026-07-27

このディレクトリは、`docs/notes/drawing-chat-service-design-foundation.md`で決めた方針を、実装と試験へ渡せる粒度にした仕様書を置く。

## 読み方

各仕様の項目には次の状態を使う。

- **決定**: 実装計画の前提としてよい。
- **暫定**: 初期値として実装し、fixture・負荷試験・運用で調整する。
- **未決定**: 実装開始前または該当spikeの判定点までに決める。

仕様間で矛盾した場合は、次の順で解決する。

1. 後から承認された設計判断
2. このディレクトリの個別仕様
3. `docs/notes/drawing-chat-service-design-foundation.md`
4. モックアップ

## 現在の仕様

| ファイル | 対象 | 状態 |
| --- | --- | --- |
| `stroke-protocol.md` | stroke wire semantics、順序、再送、上限 | 初稿 |
| `room-lifecycle.md` | 状態遷移、終了、証跡、cleanup | 初稿 |
| `event-log-recovery.md` | event log、snapshot、復帰、compaction | 初稿 |
| `data-model.md` | D1、DO SQLite、R2、retention | 初稿 |
| `guest-session.md` | guest cookie、招待token、room ticket | 初稿 |
| `load-test-plan.md` | event log・WebSocket・snapshotの測定条件 | 初稿 |

関連成果物:

- `tools/renderer-fixtures/`: canonical renderer fixture
- `docs/spikes/`: 2 client、snapshot、Hibernation、cleanup、認証の実行票
- `tools/event-log-benchmark/`: raw stroke解析、event生成、Canvas cold replay

## 仕様化しても固定しないもの

次は実測前の暫定値である。

- 50ms / 最大12 pointsのappend batching
- 2秒の未完了stroke timeout
- 100,000 drawing events / 64MiB / 作成から2時間
- snapshot triggerの50,000 events / 16MiB / replay推定2秒
- guest session 30日、room ticket 60秒
- rate limit、チャット保持数、snapshot生成頻度

## 外部仕様の確認

CloudflareのAPI、制限、料金、compatibility flagは変更される可能性がある。実装時には公式ドキュメントを再確認し、数値をこのリポジトリの定数へ重複して埋め込まない。
