# Production room thumbnail cleanup verification

更新日: 2026-07-30

## 概要

1000 x 1000 canvas / room thumbnailのProduction smokeで、host終了後にroomのD1投影と
公開一覧は削除された。Wrangler CLIの`r2 object get`と`bucket info`では終了前の
thumbnailが残っているように見えたため、Production smokeを停止して調査した。

その後、Production R2へread-onlyで接続したWorkers bindingの`head`と`list`では、
thumbnailとruntime snapshotの両prefixが0件であることを確認した。Cloudflare R2の
runtime data planeではcleanup済みだが、最初の終了直後にbinding確認をしていないため、
実残存後に手動deleteが成功したのか、Wrangler CLI経路が遅延した値を返したのかは
断定しない。

## 検出

- 対象room: `f57792ad-d2eb-4725-ac5d-0c083bea6bd3`
- thumbnail: `rooms/f57792ad-d2eb-4725-ac5d-0c083bea6bd3/thumbnails/387.png`
- D1 room projection: 0件
- cleanup Queue / DLQ: backlog 0
- stuck cleanup projection: 0
- Wrangler CLI: thumbnailを取得可能、bucket count 1
- Workers bindingによる最終確認: thumbnail / runtime両prefix 0件

公開endpointとR2 objectは、終了前に512 x 512 PNG、同一SHA-256として確認した。
終了後は公開endpointと一覧から参照されず、情報公開の継続はなかった。

## 検証上の問題と防御修正

cleanupはroom prefixをR2 `list`して削除していたが、D1が保持する
`thumbnail_object_key`を直接削除・検証せず、prefixが空であることもD1削除前に
再確認していなかった。そのため、cleanup自身が空prefixを証明する明示的な完了fenceが
なかった。今回のCLI表示異常が実残存であったかにかかわらず、この不足を防御的に
修正した。

修正後は次の順で処理する。

1. D1の`thumbnail_object_key`が対象room prefix内であることを検証する。
2. 投影中のobjectをキー指定で直接削除する。
3. `head`が`null`であることを確認する。
4. prefix配下のsuperseded thumbnailを全page列挙して最大1,000件単位で削除する。
5. prefixを再度`list(limit: 1)`し、残存時は例外としてQueue retryへ戻す。
6. R2が空になった後にだけDOとD1 projectionを削除する。

Cloudflare R2のWorkers APIではdelete完了後のreadは強整合であるため、`head`または
再`list`で残存した場合は成功扱いにしない。

## 検証

- 全workspace check: pass
- Realtime: 68 tests pass
- Snapshot: 13 tests pass
- Web: 69 tests pass
- Protocol: 30 tests pass
- Preview Realtime version:
  `96e6b337-85c9-447c-9486-1125cc7ce67b`
- Production Realtime version:
  `5ffcaa7d-822f-4fbc-8701-4495b7d40603`
- Preview実roomでsnapshotとthumbnailを生成後、終了cleanupを実行
- 終了後D1 room: 0
- 終了後runtime snapshot prefix: 0
- 終了後thumbnail prefix: 0
- cleanup Queue / DLQ: backlog 0
- Production対象roomのWorkers binding `head`: `present: false`
- Production対象roomのthumbnail prefix: 0
- Production対象roomのruntime snapshot prefix: 0

## 防御修正版のProduction再試験

2026-07-30に防御修正版を配備した新しいpublicルームで、終了前後を同じ検査経路で
再試験した。

- public slug: `d12277590b44cd202ac7b8d9009b217f`
- internal room ID: `027c1fae-4c84-4bad-ba22-fff3527456e3`
- room作成: `2026-07-30T04:39:12.656Z`
- 初回thumbnail commit: `2026-07-30T04:44:18.928Z`
- 初回生成まで: 306,272 ms（約5分6秒）
- base room sequence: 420
- thumbnail: 512 x 512 PNG、13,054 bytes
- object SHA-256:
  `06454809a150360e89089d7d0eb4ceaf61214eb578b8f5eae7fc2e8441ae7b56`
- 公開endpoint: HTTP 200、`private, max-age=31536000, immutable`
- Workers binding `head`: endpointと同じsize、ETag、object hash

host終了後、利用者E2Eで一覧からの消失と再入室拒否を確認した。同じ終了処理について
次を確認した。

- D1 room projection: 0件
- Workers bindingのthumbnail prefix: 0件
- Workers bindingのruntime snapshot prefix: 0件
- cleanup main Queue / DLQ backlog: 0 / 0
- cleanup pending / stuck projection: 0 / 0
- evidence main Queue / DLQ backlog: 0 / 0
- evidence pending / stuck / deletion projection: 0
- runtime snapshot orphan inventory: object 0、orphan 0、inventory 0

これにより、修正版がR2の空状態を完了fenceとしてからD1 projectionを削除し、
通常終了を完了できることをProductionで確認した。

## UnlistedルームのProduction試験

public限定の生成・配信fenceを、新しいunlistedルームで確認した。

- public slug: `a7207d094d4b282e0719fe938915669a`
- internal room ID: `170e87af-0b42-4e2b-9348-d17b100e8e81`
- room作成: `2026-07-30T04:54:33.979Z`
- 作成から約7分45秒後のD1 thumbnail列: すべてNULL
- thumbnail R2 prefix: 0件
- 公開ルーム一覧API: 非掲載
- thumbnail endpoint: HTTP 404、`private, no-store`

host終了後は利用者E2Eで再入室拒否を確認した。同時点のD1 room projection、
runtime snapshot R2 prefix、thumbnail R2 prefixはすべて0件で、cleanup /
evidence Queue・DLQ backlog、pending / stuck projectionも0だった。

smoke終了後のservice controlsはrevision 4で、新規作成・入室・描画がすべて有効、
開催中roomは0件だった。

## Worker Analytics

Production smoke全体を含む`2026-07-30T04:38:00Z`〜`05:07:00Z`を確認した。

| Worker | requests | errors | 最大CPU P99 | P999 memory | 128 MiB上限への余裕 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Realtime | 20 | 0 | 9.308 ms | 2.4 MiB | 98.1% |
| Snapshot | 1 | 0 | 195.346 ms | 18.2 MiB | 85.8% |
| Web | 72 | 0 | 53.883 ms | 12.9 MiB | 89.9% |

Realtimeの20 requestsには`clientDisconnected` 4件を含むが、WebSocket終了に伴う
statusでerrorsは0だった。3 WorkerともP999 memoryが30% headroom基準の
89.6 MiB（`93,952,409 bytes`）以下であり、resource gateをpassした。

Preview試験用roomと、関連room / session / accountがないことを条件にした合成userは
試験後に削除した。

Wrangler CLIの`r2 object get`と`bucket info`は、runtime cleanupの完了判定には
使用しない。Workers bindingの`head` / `list`、D1 projection、Queue / DLQを
同じ時点で照合する。

## 判定

防御修正版cleanup、public / unlistedの生成・配信fence、終了後削除、resource gateを
Productionで確認した。本計画に関する残作業はない。
