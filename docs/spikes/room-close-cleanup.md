# Spike: Room close, evidence, and cleanup

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
- D1/DO cleanup
- R2 object keysをcleanup jobへ登録
- retry / DLQ

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
- orphan snapshotを検出・削除できる。

## Deliverables

- state transition test
- cleanup job schema
- evidence manifest
- retry/DLQ procedure
- admin-visible failure metric

## Sources

- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- https://developers.cloudflare.com/queues/configuration/dead-letter-queues/

