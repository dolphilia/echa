# Phase 3 Stage E: previous snapshot fallback

更新日: 2026-07-27  
状態: shadow modeのcurrent / previous / full replay復旧と再試行安全性が成立

## 実装

Durable ObjectのSQLite schemaをversion 9へ更新し、`snapshot_state`へ
`previous_job_id`を追加した。新しいmanifestのcommitは
`transactionSync()`内で次を一括実行する。

1. jobとmanifestのversion、generation、baseRoomSeqを検証
2. manifestをinsert
3. jobを`committed`へ更新
4. 従来のcurrentをpreviousへ移動
5. 新しいmanifestをcurrentへ設定

Browserは失敗したsnapshot job IDを接続中だけ最大2件保持し、WebSocket再接続時に
`snapshotExcludeJobs`として送る。serverはcurrent、previousの順に、除外されて
いないsnapshotだけを提示する。

復旧順序:

```text
current snapshot
  -> current失敗: previous snapshot + tail
  -> previous失敗/不在: full event replay
```

同じ失敗済みjobが再提示された場合はloopを避けるため、直ちにsnapshot recoveryを
無効化する。除外指定は最大2件、重複なし、既存identifier形式に限定し、WorkerとDOの
両方で検証する。

## 障害・冪等性試験

Realtime / Durable Object:

- 2世代のmanifest commit後、currentとpreviousが正しく保持される
- current除外時にpreviousを提示し、previous base以降をtail replayする
- currentとpreviousを両方除外するとsnapshotを提示せずfull replayする
- R2 object欠落は404、metadata不整合は502でfail closed

Snapshot Worker:

- manifest commit前後の失敗を想定し、R2 PUT後にcommitが失敗しても同じjobを
  再実行してcommitできる
- Queue重複相当の同じjob再実行で同じobject hashを使用する
- より新しいsnapshotにsupersedeされたjobのstaging objectを削除する
- 同じR2 keyに異なるobjectが存在する場合、manifestをcommitせず停止する

Browser:

- current失敗後はpreviousを許可
- previousも失敗するとfull replayへ移行
- 同じjobの再失敗ではsnapshot retry loopを停止
- object破損、version不一致、RGBA hash不一致で未検証pixelを適用しない

## Compaction前に見つかった必要条件

currentの`baseRoomSeq = 100`、previousの`baseRoomSeq = 50`で
`roomSeq <= 100`を削除すると、previousからcurrentへ進む51〜100のeventが失われる。
previous fallbackとcurrent基準の全削除は同時に成立しない。

さらに現行Snapshot Workerはevent logのseq 1から生成する。eventを削除した後も
次世代snapshotを生成するには、current snapshotを復号してrendererへloadし、
current baseより後のtailだけを適用するincremental generationが必要である。

このため、まだevent削除は実装・有効化しない。安全な初期方式は次とする。

- 最初のsnapshotだけではcompactionしない
- currentとpreviousを保持する
- previous baseからcurrentまでのbridge eventを保持する
- 削除境界はpreviousの`baseRoomSeq`以前
- incremental snapshot generation成立後だけ`shadow`から
  `snapshot_compacted`へ進める

## 次の作業

1〜4は[`phase3-snapshot-incremental-generation.md`](phase3-snapshot-incremental-generation.md)
でlocal / previewともに成立した。次はprevious境界でのchunk deletionと
中断再開を試験する。

追加のCloudflare resourceやsecretは不要。

## Validationとpreview

- `npm run check`: 成功
- `npm run cf:types:check`: 成功
- Realtime integration tests: 13件成功
- Snapshot Worker tests: 5件成功
- Browser snapshot recovery tests: 6件成功
- Realtime preview version: `4cba5200-beca-4977-8d39-ef68e39db7b1`
- Web preview version: `8034e543-5d64-47ae-aeff-fad38b5b9de8`

previewの新規Durable Object `phase3-schema9-probe`で
`{"ok":true,"schemaVersion":9}`を確認した。unique queryで取得したpreview HTMLは
`drawing-room-DGKJzNXa.js`を参照し、bundleに`snapshotExcludeJobs`とfallback処理が
含まれる。

通常queryでは配備直後に直前の`drawing-room-CBD0P34-.js`を参照するHTMLが一度返り、
既知のvinext cache切替遅延を再現した。unique query + `Cache-Control: no-cache`では
新assetへ切り替わっている。cache invalidation手順の固定はPhase 7の残課題とする。
