# Spike: Durable Object WebSocket Hibernation

## Goal

DOがmemoryからevictされconstructorが再実行されても、接続中WebSocket、actor、role、room state、roomSeqを安全に復元できることを確認する。

## Minimum implementation

- `acceptWebSocket`
- `webSocketMessage`, `webSocketClose`, `webSocketError`
- `serializeAttachment` / `deserializeAttachment`
- `getWebSockets`
- SQLite runtime state
- connection tagはroom roleなど最小限

attachmentは16KiB以内にする。

- connection ID
- actor ID
- role
- session reference
- last ack clientSeq

大きいstateと権限はSQLiteから復元し、attachmentだけを信用しない。

## Procedure

1. 10-20 WebSocket接続。
2. attachmentを保存。
3. instance再初期化相当を発生。
4. constructor後にSQLiteとattachmentから復元。
5. message、broadcast、closeを継続。
6. alarm実行とHibernationの相互作用を確認。
7. closing中にwakeした場合、新eventを拒否。

## Pass

- connectionを切らずにmessage処理を再開。
- actor/roleを取り違えない。
- roomSeqが巻き戻らない。
- in-memory cache消失でcritical stateを失わない。
- idle product stateとHibernationを混同しない。

## Tests

- Workers Vitest pool
- direct DO storage inspection
- alarm immediate execution
- attachment max/invalid data
- closing/suspended wake

## Deliverables

- automated integration test
- wake latency
- attachment schema
- constructor/migration方針
- observed limitations

## Sources

- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/durable-objects/api/state/

