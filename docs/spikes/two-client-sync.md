# Spike: 2 client drawing sync

## Goal

2ブラウザ間でstrokeの途中表示、確定、再接続、event log全再生が成立する最短経路を確認する。

## Minimum implementation

- TypeScript Worker
- 1 room = 1 SQLite-backed Durable Object
- Hibernation WebSocket API
- `stroke.begin/append/end/cancel`
- roomSeq採番
- DO SQLiteへpersistしてからbroadcast
- 50ms / 最大12 points batching
- 2秒unfinished timeout
- event log先頭からのcold replay
- JSON codecで開始してよい。wire計測前にMessagePack候補へ置換

## Not included

- Better Auth
- room list
- chat
- production moderation
- snapshot compaction

## Procedure

1. fixture eventを単一clientから送る。
2. 送信側と受信側の確定canvasを比較。
3. append途中のremote provisionalを確認。
4. 受信clientをreloadし、event logから復帰。
5. WebSocketを切断し、新connectionで`lastRoomSeq` resume。
6. duplicate、out-of-order、end欠落、cancelを注入。
7. 2人同時strokeでroomSeqと描画順を確認。

## Metrics

- local provisional latency
- remote provisional / commit latency
- persist time
- broadcast time
- event bytes
- replay first drawing / complete
- duplicate/reject count

## Pass

- 同じaccepted event列から両clientが同じlogical stroke集合を得る。
- low opacityの継ぎ目が濃くならない。
- reloadとresumeで欠落・重複がない。
- DO restart/hibernation後もSQLiteから状態を戻せる。
- snapshot spikeへ渡せるevent chunk RPCを追加可能。

## Deliverables

- runnable package
- wrangler configとSQLite migration
- protocol fixture test
- 2-browser E2E
- measurement JSON
- snapshot spikeへのblocker一覧

## Sources

- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/

