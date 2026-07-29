# Phase 3: room close and snapshot fence

更新日: 2026-07-27  
状態: local自動試験とCloudflare previewのdisposable roomで成立

## 目的

roomが終了を開始する瞬間にsnapshot job、manifest commit、compactionが競合しても、
終了後に新しいruntime snapshotを正として採用せず、eventやR2 staging objectを
取り残さないための前方向フェンスを作る。

これはPhase 6の完全なroom cleanupではない。report evidence、D1 projection削除、
R2 cleanup retry / DLQ、DO `deleteAll()`は後続のroom close実装で扱う。

## 実装

Durable Object SQLite schemaをversion 12へ更新し、`room_lifecycle`に次を保存する。

- `active`または`closing`
- 最初の`closeRequestId`
- close reasonとserver時刻
- 終了時にserver確定したstroke数
- supersededにしたsnapshot job数

`beginRoomClose()`は1つのSQLite transactionで次を行う。

1. active strokeをserver-generated `stroke.end`で確定する
2. queued snapshot jobを`superseded`へ変更する
3. 未使用snapshot read ticketを削除する
4. roomを`closing`へ遷移する

transaction後、確定eventと`room.updated(status: closing)`を既存WebSocketへ送り、
close code `1001`で切断する。`1001`は技術spikeの暫定値であり、公開仕様としての
最終close codeはPhase 6で確定する。

close以降は次をfail closedにする。

- 新規WebSocket接続: HTTP 410 `ROOM_NOT_ACTIVE`
- 既存接続からのdrawing event: `ROOM_NOT_ACTIVE`
- snapshot job新規作成
- snapshot read ticket消費
- compaction: `room_closing`、削除0件

重複closeは後から別のrequest IDやreasonが来ても、最初に永続化した結果を返す。

## snapshot workerとの競合

Snapshot WorkerはQueue messageを受け取った直後に
`snapshotJobDisposition(jobId)`を確認する。

- lifecycleが`active`かつjobが`queued`: `run`
- それ以外: `discard`してack

Workerが`run`判定後にcloseが始まる競合も考慮する。manifest commitはjob statusと
room lifecycleを同じDO transaction内で再確認し、closeが先なら`superseded`を返す。
Workerは生成済みR2 staging objectを削除してackする。

これにより順序は次のどちらかへ収束する。

| 順序 | 結果 |
| --- | --- |
| manifest commit → close | commit済みobjectを後続cleanup対象へ列挙 |
| close → manifest commit | commitをsuperseded、staging objectを削除 |

snapshot requestがQueue sendを待っている間にcloseが入った場合も、永続jobは
supersededとなり、配送後のconsumerがdiscardする。

## cleanup準備

close結果は、manifestに記録済みのobject keyに加え、全snapshot jobから導出した
決定的なstaging keyを重複なしで返す。Worker crashがR2 PUT後・manifest commit前に
起きた場合も、後続cleanup taskが候補keyを失わない。

実際のR2 deleteは外部I/Oであり、DOの終了transaction内では行わない。

## local自動試験

追加した条件:

- queued jobはclose前`run`、close後`discard`
- active strokeをserver-generated endで確定
- queued jobを同じclose transactionでsuperseded
- `room.updated(closing)`通知
- reconnectを410で拒否
- close後のmanifest commitをsuperseded
- close後compactionはeventを削除しない
- 重複closeは最初の結果を返す
- cleanup候補に未commit jobの決定的staging keyを含める

検証結果:

- Realtime tests: 15件成功
- Snapshot Worker tests: 6件成功
- Web tests: 6件成功
- Protocol tests: 14件成功
- Renderer tests: 2件成功
- `npm run check`: 成功
- `npm run cf:types:check`: 成功

## Cloudflare preview

- Realtime Worker:
  `ad8cb9e7-3e58-43ef-92cf-b7ff9a1574cf`
- Snapshot Worker:
  `ab4dba7a-90b2-4d3f-9652-6c99a045e39f`
- Worker startup: Realtime 5ms、Snapshot 4ms
- probe room: `snapshot-probe-20260727c10def01`
- room schema: version 12

空roomでsnapshot jobをenqueueし、約1.1秒後にclose fenceを立てた。

- `supersededSnapshotJobCount`: 1
- lifecycle: `closing`
- current manifest: なし
- R2 staging object: なし
- 公開WebSocket再入室: HTTP 410

## 判断と残作業

Phase 3が必要とするsnapshot / compactionの終了競合フェンスは成立した。通常roomで
snapshot compactionを自動有効化する前に残る項目は、feature flag orchestrationと
preview Worker性能測定である。

Phase 6では別途、次を実装する。

1. report evidence commit
2. room list projectionとD1行の削除
3. R2 cleanup task、retry、DLQ
4. DO storageの最終`deleteAll()`
5. cleanup途中のrestartとduplicate job

追加のCloudflare resourceやsecretは不要。
