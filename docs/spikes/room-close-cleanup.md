# Spike: Room close, evidence, and cleanup

状態: 通常終了cleanup、障害注入、report/evidence、期限到達時削除、
実Queue/DLQ復旧、runtime snapshot孤児検出を実装

## Goal

host終了、自動終了、上限終了、管理停止で、接続を閉じ、通常データを削除し、必要時だけ証跡を保全できることを確認する。

## Scenarios

- host close
- 全員退出後10分
- createdAt + 2時間
- 100,000 events / 64MiB soft close
- admin suspend/close
- reportあり
- reportなし
- snapshot generation中
- R2 cleanup失敗

## Implementation shape

- closing stateを最初にpersist
- `room.updated(closing)`
- new begin/chat/join拒否
- unfinished stroke終端
- report evidence job
- `room.closed`
- WebSocket close
- R2 object keysをcleanup jobへ登録
- R2 -> DO -> D1の順でcleanup
- Queue投入はDO alarmで再試行、consumerはretry / DLQ

DO alarmは1つなので、SQLite `scheduled_tasks`の最短dueをalarmへ反映する。

## Failure injection

- evidence R2 PUT失敗
- Queue duplicate
- DO restart between steps
- D1 delete timeout
- R2 delete timeout
- close request duplicate
- room closes while snapshot job runs

## Pass

- 通常終了後にroom/event/snapshotが残らない。
- reportありではevidence commit前に元dataを消さない。
- cleanup失敗でroomを再開しない。
- close処理が冪等。
- expired roomをbackupから復活させない。
- orphan snapshotを検出・inventory化し、確認後にだけ削除判断できる。

## 2026-07-28実装

- `room.closed`を`room.updated(closing)`の後、WebSocket closeの前に配信する。
- D1 `rooms.cleanup_job_id`を削除coordination fenceにする。
- `koge-room-cleanup-preview`をRealtime Workerのproducer/consumerへ接続する。
- 5回失敗後の退避先を`koge-room-cleanup-preview-dlq`にする。
- object keyを`rooms/{roomId}/snapshots/`配下へ限定し、最大1,000件とする。
- R2削除、DO `deleteAll()`、D1 room/member/invite削除を順に実行する。
- D1 room行が既にない重複jobは完了済みとしてackする。
- `reports`、`evidence_manifests`、`moderation_actions`の最小D1 schemaを追加する。
- 未解決reportのevidence manifestが`committed`でなければcleanupを開始しない。
- 実D1/R2/DO fixtureでevidence未確定時の停止、commit後の通常data削除、
  report/evidence残存を確認する。
- report APIと利用者dialogから内部subject identityで受付する。
- DOでsnapshot cursorとtarget room sequenceを固定し、snapshot copy、
  tail event chunk、chat/metadata/membership、hash付きmanifestをR2へ保存する。
- evidence commit後にclosing roomのcleanup Queueを再起動する。
- 専用Queue/DLQ、`/health/evidence`、再送runbookを追加する。
- evidence保持期限scan、削除Queue job、R2 -> D1の冪等削除を追加する。
- 実Queueでduplicate ackとDLQ再投入を確認する。
- strict R2 keyと1時間graceを使うruntime snapshot孤児scanを追加する。
- D1 roomとDO job/manifestを照合し、`room_missing`と`unreferenced`を
  D1 inventoryへ投影する。
- scanは最大10,000 object / 500 roomでfail closedにし、R2は自動削除しない。
- `/health/orphan-snapshots`とlocalhost限定の手動scan tool、削除判断runbookを
  追加する。
- 最大時間の15分、5分、1分前に`room.time`を配信し、通知段階を
  DO SQLiteへ永続化する。
- 単一alarmの次回時刻を`max_duration`と通知段階から導出し、遅延復帰時は
  現在時刻に合う最新段階へ追いつく。
- 非公開Service Bindingからadmin suspend / closeを実行し、
  `moderation_actions`へ冪等な監査結果を保存する。
- suspendではactive strokeを確定し、ticket / alarm / snapshot automationを
  停止してWebSocketを閉じるが、通常cleanupは開始しない。
- suspendedからadmin closeで既存のevidence / cleanup fenceへ進める。
- Cloudflare Accessで保護した`/admin/rooms`と`/api/admin/*`をpreviewへ配備する。
- WorkerでもAccess JWTの署名、issuer、audience、期限を検証し、Access `sub`は
  SHA-256内部IDへ変換してから監査記録へ渡す。

未完了:

- admin kick / BAN
- 確認済み孤児objectの削除tool

## Deliverables

- state transition test
- cleanup job schema
- evidence manifest
- retry/DLQ procedure
- admin-visible failure metric

Phase 3で先行完了した範囲と証跡:
[`../results/phase3-room-close-snapshot-fence.md`](../results/phase3-room-close-snapshot-fence.md)

## Sources

- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- https://developers.cloudflare.com/queues/configuration/dead-letter-queues/
