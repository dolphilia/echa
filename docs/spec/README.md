# 現行仕様

更新日: 2026-07-29

このディレクトリには、設計方針を実装・試験・運用へ渡せる粒度にした現行仕様を置く。
Phase別の当時の状態は`docs/results/`、採用判断は`docs/decisions/`を参照する。

## 読み方

各仕様の項目には次の状態を使う。

- **決定**: 実装計画の前提としてよい。
- **暫定**: 初期値として実装し、fixture・負荷試験・運用で調整する。
- **未決定**: 実装開始前または該当spikeの判定点までに決める。

仕様間で矛盾した場合は、次の順で解決する。

1. 現在のコード、migration、test、Wrangler config
2. 後から承認された設計判断
3. このディレクトリの個別仕様
4. `docs/notes/drawing-chat-service-design-foundation.md`
5. モックアップ

## 現在の仕様

| ファイル | 対象 | 状態 |
| --- | --- | --- |
| `stroke-protocol.md` | stroke wire semantics、順序、再送、上限 | production利用者E2E済み |
| `room-lifecycle.md` | 状態遷移、終了、証跡、cleanup | production利用者E2E・終了後health済み |
| `event-log-recovery.md` | event log、snapshot、復帰、compaction | snapshot-first採用、productionはshadow |
| `data-model.md` | D1、DO SQLite、R2、retention | D1 migration `0021` local、DO schema v29 |
| `room-thumbnails.md` | 初回生成、配信、retry、cleanup | local実装、preview検証前 |
| `guest-session.md` | guest cookie、招待token、room ticket | guest viewer限定を実装、preview E2E待ち |
| `chat-protocol.md` | chat wire semantics、権限、保持、rate limit | ログインユーザー全role送信を実装、preview E2E待ち |
| `load-test-plan.md` | event log・WebSocket・snapshotの測定条件 | Phase 7測定を反映 |

関連成果物:

- `docs/plans/mvp-implementation-plan.md`: MVP実装順序、依存関係、判断ゲート、完了条件
- `tools/renderer-fixtures/`: canonical renderer fixture
- `docs/spikes/`: 2 client、snapshot、Hibernation、cleanup、認証の実行票
- `tools/event-log-benchmark/`: raw stroke解析、event生成、Canvas cold replay
- `tools/rate-abuse-metrics/`: closed betaのrate abuse baseline取得・差分比較

## 仕様化しても固定しないもの

次は実測前の暫定値である。

- 50ms / 最大12 pointsのappend batching
- 2秒の未完了stroke timeout
- hard limit 100,000 events / 64MiB、通常受付soft limit 93,000 events / 56MiB
- 作成から2時間、退出後10分、idle 30分
- snapshot初回trigger 50,000 events / 16MiB、増分5,000 events / 4MiB
- guest session 30日、room ticket 60秒
- rate limit、チャット保持数（100件 / 24時間）、snapshot生成頻度

## 外部仕様の確認

CloudflareのAPI、制限、料金、compatibility flagは変更される可能性がある。実装時には公式ドキュメントを再確認し、数値をこのリポジトリの定数へ重複して埋め込まない。
