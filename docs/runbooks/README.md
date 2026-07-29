# Runbooks

更新日: 2026-07-29

公開前後の運用で、障害を検知してから安全に復旧するまでの手順を置く。
cleanup、evidence、orphan inventory、emergency mode、rate abuse、service BANは
previewで検証済みで、production初回E2Eと終了後healthもpassしている。

- [`room-cleanup-dlq.md`](./room-cleanup-dlq.md) — room cleanup滞留・DLQ対応
- [`moderation-evidence-dlq.md`](./moderation-evidence-dlq.md) —
  通報証跡の生成滞留・DLQ対応
- [`snapshot-orphan-inventory.md`](./snapshot-orphan-inventory.md) —
  runtime snapshot孤児検出・確認・削除判断
- [`emergency-mode.md`](./emergency-mode.md) —
  新規room作成・新規入室・描画受付の緊急停止と復旧
- [`rate-abuse-control.md`](./rate-abuse-control.md) —
  描画・チャットrate超過の短時間muteと自動disconnect
- [`service-bans.md`](./service-bans.md) —
  一時service BANの適用、解除、監査確認

runbookは実装・binding・resource名の変更と同じpull requestで更新する。
secret、session token、room ticket、生IPを記録しない。
