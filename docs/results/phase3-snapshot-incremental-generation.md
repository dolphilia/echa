# Phase 3 Stage E: incremental snapshot generation

更新日: 2026-07-27  
状態: current snapshot + tailによる次世代生成がlocal / Cloudflare previewで成立

## 実装

Snapshot job作成時に、その時点のcurrent snapshotを生成元として固定する。
Queueの再配送中にcurrentが更新されても入力が変わらないよう、Durable Objectの
SQLite schemaをversion 10へ更新し、`snapshot_jobs`へ次を保存する。

- `source_job_id`
- `source_base_room_seq`

最初のjobや旧version 1 jobは`source_base_room_seq = 0`、sourceなしとして扱い、
event log先頭から生成する。currentがある次世代jobは、固定したmanifestを
`snapshotSource(jobId)` RPCで取得する。

Snapshot Workerは次の順序で処理する。

1. jobと固定sourceのroom、base、protocol、renderer、canvas generationを照合
2. R2 objectのbyte数とcustom metadataをmanifestと照合
3. object SHA-256を検証
4. lossless decode後に寸法、renderer version、RGBA SHA-256を検証
5. 共通WASM rendererへRGBAをload
6. `source_base_room_seq + 1`からtargetまでのeventだけをchunk replay
7. 新しいobjectを条件付きPUTし、manifestをcommit

objectはcanvas RGBA byte数にdeflate overheadの上限を加えた既知の大きさに制限し、
byte数を確認してからbufferする。sourceが欠落・破損・不整合の場合はtail取得、
R2 PUT、manifest commitへ進まない。

## 正しさと障害試験

Workers runtime上で、3 eventsのfull snapshotをsourceにし、さらに3 eventsを
tailとして適用した。`source + tail`の最終RGBA SHA-256は、同じ2 strokesを
event log先頭から描画した結果と一致した。

- Realtime / Durable Object tests: 13件成功
- Snapshot Worker tests: 6件成功
- Web snapshot recovery tests: 6件成功
- Protocol tests: 13件成功
- `npm run check`: 成功
- `npm run cf:types:check`: 成功

追加した障害条件:

- 固定source object欠落時、tailを取得せずmanifestもcommitしない
- R2 PUT後のmanifest commit失敗から同じjobで再開できる
- 同じstaging keyの異なるobjectを拒否する
- superseded jobのstaging objectを削除する

## Cloudflare preview

- Realtime Worker version:
  `a96ae0bd-9662-41c3-bcc3-bbf273be4533`
- Snapshot Worker version:
  `5f05e350-58f9-4080-aff3-0ea14f2feced`
- Realtime startup: 6ms
- Snapshot startup: 5ms
- probe room: `snapshot-probe-20260727a1b2c3d4`
- room schema: version 10

同じpreview roomで3世代を生成した。

| generation | source base | target base | object bytes | RGBA SHA-256 |
| ---: | ---: | ---: | ---: | --- |
| 1 | なし | 0 | 2,428 | `6e82634c3a3bf02821e0265561d869d08cdffaaccef31f2a3b29f78a47a97eb5` |
| 2 | 0 | 3 | 2,892 | `321efa03172e61082292383f6af6937735885fec6c04d540d7e724fcdcb7ae5a` |
| 3 | 3 | 6 | 2,895 | `e62d0c6e8f03cbffd8943d6d539b450fe72099cd31dfb053337f9ebf50998b96` |

generation 3のjobはgeneration 2をsourceとして固定し、
`sourceBaseRoomSeq = 3`からevents 4〜6だけを取得してcommitされた。これにより、
event log先頭が削除された後も次世代を生成するための主要な前提がpreviewで成立した。

再利用できる非空stroke投入用probeを
`tools/snapshot-vertical-slice-probe/draw.mts`へ追加した。

## 判断と次の作業

incremental generationは成立し、その後のcompaction実装と検証も完了した。結果は
[`phase3-snapshot-compaction.md`](phase3-snapshot-compaction.md)を参照。
本記録の時点ではeventを一件も削除していなかったため、以下をcompaction側の
受け入れ条件として引き継いだ。

1. 最初のsnapshotでは削除しない
2. current / previousを保持する
3. previous baseからcurrentまでのbridge eventを残す
4. previous base以前だけを小さいchunkで削除する
5. 削除中断・再開、重複実行、current破損時のprevious復旧を自動試験する
6. room終了とsnapshot / compactionの競合をfail closedで処理する

追加のCloudflare resourceやsecretは不要。
