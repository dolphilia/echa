# Phase 3 Stage C: Snapshot Worker generation

日付: 2026-07-27  
状態: Worker generation成立、client recoveryへ進行可能  
Cloudflare Workers plan: Paid

## 実装した縦切り

1. room Durable ObjectがjobをSQLiteへ永続化する。
2. Queueへevent本体を含まないjob metadataだけを送る。
3. consumerが外部Durable Object RPCから最大500 eventsずつ取得する。
4. 完了strokeを共通WASM rendererへ増分適用する。
5. 960 x 640 RGBAを`koge-rgba-deflate-v1`へlossless encodeする。
6. RGBA SHA-256とobject SHA-256を計算する。
7. job固有のstaging keyへ条件付きR2 PUTを行う。
8. Durable Objectがjob、room sequence、protocol、renderer、canvas generation、snapshot generation、hashを検証してmanifestをcommitする。

Queueはat-least-once deliveryとして扱う。同じjobが再配送された場合、同じR2 keyとhashを確認して`already_committed`へ収束する。manifest commitまではevent logを削除しない。

## Snapshot contract v1

- protocol version: 1
- renderer version: 1
- canvas generation: 1
- snapshot generation: room内で単調増加
- canvas: 960 x 640、sRGB RGBA
- codec: `koge-rgba-deflate-v1`
- event chunk上限: 500
- R2 key: `rooms/{roomId}/snapshots/staging/{jobId}.kgs`

`KGS1` objectは24-byte headerとdeflate streamから成る。Browser recoveryではheader、version、寸法、object hashを検証し、展開後にRGBA hashを検証する。

## ローカルWorkers runtime

- Realtime DO: 10 tests pass
- Snapshot Worker: 2 tests pass
- Protocol: 11 tests pass
- duplicate job:
  - 条件付きR2 PUTが既存objectを検出
  - size / object hash / RGBA hashを照合
  - manifest commitは`already_committed`
- event log:
  - snapshot commit後も全件保持

canonical fixtureのencode測定:

| metric | result |
| --- | ---: |
| RGBA | 2,457,600 bytes |
| snapshot object | 9,080 bytes |
| RGBA比 | 0.369% |
| encode wall time | 13.39ms |

## Cloudflare preview縦切り

- Realtime Worker version: `b1e6cb4c-e7fc-45e4-be78-a65f8ba5837f`
- Snapshot Worker version: `4ba45fad-0aaf-4aa5-a8a2-79f9542f8e58`
- Realtime startup: 7ms
- Snapshot startup: 4ms
- binding:
  - Queue producer: `koge-snapshot-preview`
  - Queue consumer: `koge-snapshot-preview`
  - external DO: `DrawingRoom` in `koge-realtime-preview`
  - R2: `koge-runtime-snapshots-preview`

一時remote probeから空roomのjobを1件送信し、Queue → consumer → external DO RPC → WASM → R2 → manifest commitを確認した。

| metric | result |
| --- | ---: |
| target roomSeq | 0 |
| Queue sendからmanifest作成 | 6,579ms |
| snapshot object | 2,428 bytes |
| object SHA-256 | `98d4743d33a2e03da436e8fa62bf702357c9c0efcbc1626ca45a2ed0212a0df0` |
| RGBA SHA-256 | `6e82634c3a3bf02821e0265561d869d08cdffaaccef31f2a3b29f78a47a97eb5` |

遅延の大部分は現在のQueue `max_batch_timeout: 5`秒による。snapshotは入力critical path外なので暫定値として許容し、実負荷測定後に調整する。

最新probe objectはpreviewの縦切り証跡として残した。旧contractで作成した最初のprobe objectはR2から削除済みで、復元不能だが非製品probe dataである。

## 判断

Worker generationは成立した。共通WASM、Queue、外部DO RPC、R2、manifest commitのために専用containerや外部rendererは不要。

snapshot-first採用はまだ決定しない。次はStage Dとして、Browserが認可済みmanifest/objectを取得し、object hashとRGBA hashを検証してsnapshot + tail + live catch-upを行う経路を実装する。その後、10k / 50k / 100k eventと障害注入を行う。
