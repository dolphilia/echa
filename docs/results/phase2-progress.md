# Phase 2 progress

日付: 2026-07-27  
状態: Gate A完了

## 成立した経路

- 1 room = 1 SQLite-backed Durable Object
- WebSocket Hibernation APIによる接続
- protocol v1 MessagePack binary frameのserver-side validation
- `connectionId + clientSeq`による重複・順序検証
- stroke lifecycleと1 actor 1 unfinished strokeの検証
- SQLite transaction内でのpersist、`roomSeq`採番、persist後broadcast
- 64KiB frame、12 points / append、4,096 points / strokeのserver-side上限
- 2秒間更新されなかったunfinished strokeのDO Alarmによる自動確定
- 500 events単位の全event log取得と64KiB未満のreplay frame分割
- `lastRoomSeq`以後のresume
- Durable Object再初期化後のSQLite復帰
- snapshot worker向け`eventsAfter(afterRoomSeq, limit)` RPC境界
- accepted / reject / broadcast / replay event数のDO内counter

server受理eventには`roomSeq`、`actor`、`connectionId`、`acceptedAt`を付与する。`connectionId`は複数tabや再接続が同じactorを共有しても、送信側outboxがackを正しく照合するために追加した。

## Browser client

描画ページは通常のローカルモードを維持しつつ、次のqueryでPhase 2同期モードを有効にできる。

```text
http://localhost:3000/?sync=1&room=room-phase2-demo
```

同期モードでは以下を実装した。

- local provisional描画はnetworkを待たない。
- accepted begin / appendを別Canvasへ描き、remote strokeを途中表示する。
- end受理時だけ全strokeを指定opacityでbase Canvasへ1回合成する。
- 切断後は新しいconnection IDで再接続し、`lastRoomSeq`からresumeする。
- replay完了を示す`ready`受信後、未ack eventを同じstroke ID / clientSeqで再送する。

## 自動試験

Workers runtime統合試験で以下を確認した。

- 2 WebSocket接続が同じaccepted begin / append / endを受け取る。
- duplicateを拒否し、accepted sequenceを進めない。
- begin前append、out-of-order、cancel後appendを拒否する。
- 3 events永続化後にDOをevictし、`lastRoomSeq=1`からroomSeq 2-3を復元する。
- unfinished strokeをAlarmでserver-generated endへ確定する。
- health、schema migration、metric counter、active stroke数を取得できる。

protocol packageではclient eventとserver-generated timeout eventのMessagePack round tripを検証している。

Playwright + system ChromeのE2Eでは、独立した2 browser contextを同じroomへ接続し、次を確認した。

- client Aで描いたstrokeがclient Bへ確定描画される。
- 両clientの960 x 640 base Canvasの全RGBA pixel SHA-256が一致する。
- client Bをreloadし、event log全replay後のpixel hashがreload前のclient Aと一致する。

## Gate A完了判断

計画書のGate A条件を満たした。

- 両clientが同じaccepted event列とlogical stroke集合を得る。
- reload / resumeでevent欠落と二重適用がない。
- provisionalは即時表示し、低opacity strokeはend時に1回だけbaseへ合成する。
- DO再初期化とHibernation後もSQLite / attachmentから継続する。
- reject、persist成功、broadcast、replayのcounterを取得できる。
- snapshot Workerがeventを500件ずつ取得できるRPC境界がある。

browser provisional first-paintの正式測定と、50,000 / 100,000 eventのfallback wall time・memory・Worker CPUは、Phase 3のsnapshot比較matrixへ持ち越す。Gate Aの正しさを妨げる未解決事項ではない。

次の項目は実装・自動試験済み。

- 600 eventsのreplay完了後にlive eventへ順序どおり追従する。
- HibernationによるDO eviction後も、serialized attachmentから同じWebSocket接続を復元して送受信できる。
- 接続上限20、接続単位の80 events/s・burst 120、roomの100,000 events・64 MiB上限と終了用予約領域をserverで強制する。
- ack RTT、accepted event到着、broadcast欠落、replay first frame / completeをJSONで測定できる。

ローカルの3接続・20接続測定は[`phase2-realtime-benchmark-local.md`](./phase2-realtime-benchmark-local.md)、Cloudflare previewの3接続・20接続・約10,000-event測定は[`phase2-realtime-benchmark-preview.md`](./phase2-realtime-benchmark-preview.md)に記録した。

previewでは最大20接続・199,200 broadcast deliveryの欠落は0だった。replay chunkの二次的なエンコード処理を除去した結果、9,960 eventsのfull replayは約9.79秒から約3.39秒へ改善した。一方、10,000 events未満ですでに100,000-event回復目標の3秒を超えるため、snapshot-firstを優先し、event log replayをlossless fallbackとする設計を支持する結果となった。

Better Auth、room ticket、role判定は計画どおりPhase 5まで仮identityから分離する。
