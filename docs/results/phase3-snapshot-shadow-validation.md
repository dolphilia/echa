# Phase 3 Stage E: snapshot shadow validation

更新日: 2026-07-27  
状態: shadow同一性・復旧性能・基本障害注入まで完了

## 実施内容

実操作raw stroke fixtureを10k / 50k / 100k drawing eventsへ増幅し、同一event列を
共通WASM rendererで次の2経路へ適用した。

1. event log先頭からのfull replay
2. 完了stroke境界のsnapshotを復号・適用し、約1,000 eventsのtailをreplay

各条件をローカルNodeで3回実行し、最終RGBA SHA-256を比較した。またBrowserの
snapshot取得・検証を純粋な処理へ切り出し、R2取得失敗、object破損、
renderer version不一致、RGBA hash不一致からfull event replayへfallbackすることを
unit test化した。Realtime WorkerにはR2 object欠落とcustom metadata不整合の
障害注入testを追加した。

## 条件

- runtime: Node v23.2.0
- renderer version: 1
- canvas: 960 x 640 RGBA
- fixture:
  `tools/event-log-benchmark/fixtures/echa-raw-strokes-2026-07-26T16-06-54-108Z.json`
- fixture SHA-256:
  `3e15260e8e0112f894fd3f9a6613226dc8f7afd95600cd4b71cf09622a33bf17`
- actors: 5
- batching: 50ms / 最大12 points
- renderer event chunk: 500
- snapshot tail: 完了stroke境界から約1,000 events
- runs: 各3回

生データ:

- [`../../reports/performance/2026-07-27-snapshot-shadow/local.json`](../../reports/performance/2026-07-27-snapshot-shadow/local.json)
- [`../../reports/performance/2026-07-27-snapshot-shadow/local-preliminary.json`](../../reports/performance/2026-07-27-snapshot-shadow/local-preliminary.json)

## 結果

| events | points | full replay p50 | snapshot + tail p50 | p50比 | snapshot object | RGBA一致 |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 10,001 | 39,823 | 1,840.6ms | 210.5ms | 8.7x | 41,795 bytes | 3/3 |
| 50,001 | 198,606 | 9,139.7ms | 144.8ms | 63.1x | 55,960 bytes | 3/3 |
| 100,001 | 397,210 | 18,250.7ms | 178.8ms | 102.1x | 63,510 bytes | 3/3 |

100,001 eventsではsnapshot prefix生成のrenderer処理がp50 18,091.9ms、
lossless encodeがp50 14.1msだった。復旧側はsnapshot decode、RGBA load、
約1,000-event tail replayを合わせてp50 178.8msだった。

全9回でfull replayとsnapshot + tailのRGBA SHA-256が一致した。100,001 eventsの
event logは推定MessagePack 14,468,160 bytesで、暫定64MiB上限より小さい。

## 障害注入

Browser recoveryは次の全条件でsnapshotをcanonical canvasへ適用せず、
`event-log` fallbackを選択する。

- R2 proxyの非2xx response
- object byteの破損またはobject hash不一致
- renderer version / canvas size不一致
- 復号後RGBA hash不一致

Realtime Workerは1回限りread tokenを消費した後、次をfail closedにする。

- R2 object欠落: 404
- R2 custom metadata不整合: 502

これにより、manifestだけを信用して破損objectを配布する経路はない。

## 解釈

- このfixtureではsnapshot + tailがfull replayより明確に速い。
- 100k full replayはローカル標準環境でも約18秒であり、標準client 3秒、
  低性能client 8秒という初期目標を満たさない。full replayはlossless fallback
  として維持するが、通常復旧にはsnapshot-firstが有力である。
- 100k snapshot objectは約62KiBだった。ただし白地の多い実画面に依存するため、
  高密度・多色fixtureでも別途測る。
- snapshot生成rendererは100kで約18秒を要した。非同期生成なのでclient復旧を
  直接止めないが、Cloudflare preview上のCPU time、wall time、memoryと30%以上の
  余裕はまだ証明できていない。
- ローカルNode測定はBrowser main-thread、network、DO chunk read、Queue、R2を
  含まない。Gate Bの最終判断をこの値だけで行わない。

## Gate Bの現在地

成立:

- 共通fixtureに対するBrowser/Worker共通rendererのcanonical hash
- full replayとsnapshot + tailのRGBA一致
- snapshot + tailの明確な速度優位
- R2欠落、metadata不整合、object破損、version/hash不一致での安全なfallback

未完了:

- Queue重複、consumer途中失敗、manifest commit失敗の自動障害試験
- current snapshot失敗時のprevious snapshot fallback
- `shadow -> snapshot_compacted`遷移と、compaction前後の復旧試験
- room終了中jobの停止・R2 cleanup
- preview Workerでの10k / 50k / 100k CPU・wall・memory測定
- recovery中のlive event queueとtailを含むBrowser E2E
- 高密度・多色fixtureと複数端末での反復測定

Gate Bはまだ通過扱いにしない。次はprevious snapshotを保持するmanifest state、
current -> previous -> full event replayの復旧順序、compactionを行わないshadow
状態でのQueue/manifest障害試験を実装する。

## Validationとpreview

- `npm run check`: 成功
- `npm run cf:types:check`: 成功
- Web preview build / deploy: 成功
- Web Worker version: `1842cfc9-339e-418e-88b2-703002d69c6f`
- URL: `https://preview.koge.app`

配備後HTMLが新しい`drawing-room-CBD0P34-.js`を参照し、そのbundleにsnapshot
offer互換性、object hash、RGBA hash、取得失敗の検証とfallback処理が含まれることを
確認した。今回Realtime Workerのproduction codeは変更していないため再配備せず、
追加したR2障害注入はMiniflare integration testで確認した。

## 再実行

```sh
npm run benchmark:snapshot-shadow -- \
  --events 10000,50000,100000 \
  --runs 3 \
  --tail-events 1000 \
  --output reports/performance/2026-07-27-snapshot-shadow/local.json
```

関連test:

```sh
npm test --workspace @koge/web
npm test --workspace @koge/realtime
npm test --workspace @koge/snapshot
```
