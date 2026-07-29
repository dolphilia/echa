# Phase 3 Stage E: snapshot compaction

更新日: 2026-07-28  
状態: local自動試験と70,020-eventのCloudflare preview canaryで成立。通常roomの自動有効化は未実施

## 実装した安全境界

Durable Object SQLite schemaをversion 11へ更新し、roomごとに次を永続化する。

- `mode`: `shadow`または`snapshot_compacted`
- `compacted_through_room_seq`: 削除済みeventの単調増加cursor
- `compaction_updated_at`

削除可能境界はcurrent snapshotではなく、previous snapshotの
`baseRoomSeq`とする。さらに、生成待ちjobが古いsourceを固定している間は、その
`sourceBaseRoomSeq`を越えて削除しない。

```text
safeThroughRoomSeq =
  min(previous.baseRoomSeq, earliestQueuedJob.sourceBaseRoomSeq)
```

最初のsnapshotしかないroom、previousのbaseが0のroom、古いsourceを必要とする
queued jobがあるroomでは削除しない。jobがsupersededになれば再評価できる。

## chunk deletion

`compactSnapshotEvents(currentJobId, limit)` RPCは次を保証する。

1. 呼び出し時に指定したjobがcurrentでなければ`stale`として何も変更しない。
2. 安全境界内のroom sequenceを最大`limit`件だけ選ぶ。
3. 選択したeventの削除、modeの`shadow -> snapshot_compacted`遷移、
   compaction cursor更新を同じSQLite `transactionSync`で確定する。
4. 中断後はcursorより後から再開し、同じ呼び出しを繰り返しても二重削除しない。
5. 1件でも削除した時点でfull replayを禁止し、snapshot recoveryが使えない接続は
   不完全なキャンバスを返さず`409 SNAPSHOT_RECOVERY_REQUIRED`で拒否する。

currentとpreviousの両manifestを残し、previousからcurrentへ到達するbridge eventは
削除しない。compaction後にcurrentが使えない場合も、previous + bridge + tailで
復帰できる。

## local自動試験

Realtime Durable Object試験に次を追加した。

- 最初のsnapshotでは削除しない
- queued jobが古いsourceを固定している間は削除しない
- stale current job指定は何も変更しない
- 2件ずつのchunk削除、中断・再開、冪等な再実行
- 最初の削除と同じtransactionでcompacted modeへ遷移
- compaction後のfull replayを409で拒否
- current snapshot復帰
- previous snapshot + bridge event復帰
- current / previousの両方が使えない場合の409
- compaction境界以降からのtail resume
- 削除後もcurrent snapshot + tailで次世代を生成可能
- 100 bound parameterを超える500-event chunk

検証結果:

- Realtime tests: 22件成功
- Snapshot Worker tests: 6件成功
- Web tests: 6件成功
- Protocol tests: 14件成功
- Renderer tests: 2件成功
- Event log benchmark tests: 8件成功
- Renderer fixture tests: 1件成功
- `npm run typecheck`: 成功
- `npm run lint`: 成功
- `npm run cf:types:check`: 成功

## Cloudflare preview

- Realtime Worker version:
  `5144bcd7-43e8-4d30-ba74-26e0ce1b6d3d`
- Snapshot Worker version:
  `5f05e350-58f9-4080-aff3-0ea14f2feced`
- probe room: `snapshot-probe-20260727a1b2c3d4`
- room schema: version 11

第3世代のcurrent base 6、previous base 3、events 1〜6があるroomで実施した。

| 操作 | 結果 |
| --- | --- |
| 圧縮前 | `shadow`、event 6件、安全境界3 |
| chunk 1 | events 1〜2を削除、cursor 2、`snapshot_compacted` |
| chunk 2 | event 3を削除、cursor 3、完了 |
| 圧縮後 | events 4〜6を保持、last roomSeq 6 |
| snapshotなし・roomSeq 0から接続 | 公開WebSocketで409 |
| roomSeq 6からstroke追加 | events 7〜9をaccept |
| 第4世代生成 | source base 6、target base 9でcommit |

第4世代のobjectは2,900 bytes、RGBA SHA-256は
`cf510a61d41180cb795ef25e526b4a372923d2109a398d6d8eb7dc01257b4901`
だった。events 1〜3が存在しない状態でも、第3世代snapshotとevents 7〜9だけで
第4世代を生成できた。

## Gate B後のscale canary

- Realtime Worker: `8f6d3b12-bacd-4f83-8fee-a45323ff4a8c`
- room: `snapshot-probe-20260727deed7890`
- current base: 76,020
- previous / safe boundary: 70,020
- compaction前: 79,980 events
- compaction後: cursor 70,020、9,960 events保持

最初の500-event処理でSQLiteの最大100 bound parametersを超える不具合を検出した。
失敗したtransactionはrollbackされ、cursorとeventは変化しなかった。選択済み行の
先頭・末尾roomSeqを使うrange deleteへ修正後、500-event chunkを再実行し、
70,020まで完走した。

| recovery | 結果 |
| --- | --- |
| current base 76,020 | tail 3,960件、ready 79,980 |
| current除外、previous base 70,020 | bridge/tail 9,960件、ready 79,980 |
| snapshot無効、roomSeq 0 | HTTP 409 |

## 判断と残作業

previous境界のchunk deletion、中断再開、復旧、圧縮後のincremental generationは
成立し、Gate Bは2026-07-28にpassした。通常roomの自動compactionはまだ一括で
有効にせず、次を完了して段階的に展開する。

1. ~~feature flagとtriggerを通した自動orchestrationを実装する~~
   2026-07-27完了。`phase3-snapshot-automation.md`を参照
2. ~~preview WorkerのCPU、memory、実行時間とlive broadcastへの影響を測る~~
   2026-07-28完了。`phase3-snapshot-preview-performance.md`を参照
3. Phase 6のcleanupでcurrent / previous / staging objectを確実に削除する

room closeとsnapshot job / compactionの競合は、その後
[`phase3-room-close-snapshot-fence.md`](phase3-room-close-snapshot-fence.md)
のとおり成立した。

追加のCloudflare resourceやsecretは不要。
