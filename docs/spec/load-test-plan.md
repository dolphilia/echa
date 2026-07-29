# Load test plan

更新日: 2026-07-29
状態: Phase 7測定を実施。継続性能・closed beta測定の基準

## 目的

次の判断に必要な実測を揃える。

- 100,000 drawing events / 64MiB / 2時間が安全か
- 10-20接続で描画broadcastを維持できるか
- event log full replayがfallbackとして成立するか
- 採用済みsnapshot-firstのtrigger、tail、同時復帰を継続検証する
- append batchingとrate limitをどう調整するか

## Fixture

最低限使用する。

- `tools/event-log-benchmark/fixtures/echa-raw-strokes-2026-07-26T16-06-54-108Z.json`
- `tools/renderer-fixtures/v1/canonical-strokes.json`
- 複数人の実操作fixture。今後追加

実fixtureは匿名化し、token、nickname、chatを含めない。

## Test matrix

### Event volume

- 10,000
- 50,000
- 100,000
- 150,000
- 250,000
- 400,000 drawing events

100,000まではMVP判定、150,000以上は上限見直し用。

### Connection

- 2 participants
- 10 participants + 10 viewers
- 20 mixed connections
- 20 connectionsの同時cold recovery

接続試験目標であり、全員が2時間連続描画する保証ではない。

### Network

- local baseline
- 50ms RTT
- 200ms RTT
- 500ms RTT
- 1% packet disruption相当の短いWebSocket切断
- recovery中のlive drawing

### Client

- 標準desktop
- 低性能desktopまたはmobile相当CPU throttle
- 最新Chrome系
- Safari系
- Firefox系

具体機種・versionは実施時に固定する。

## Existing commands

```sh
npm --prefix tools/event-log-benchmark test

npm --prefix tools/event-log-benchmark run analyze-raw -- \
  /absolute/path/to/raw-strokes.json

npm --prefix tools/event-log-benchmark run generate -- \
  --input /absolute/path/to/raw-strokes.json \
  --output /tmp/echa-events-100000.json \
  --target-events 100000 \
  --actors 5
```

Realtime mixed connection / concurrent recovery:

```sh
npm run benchmark:realtime-suite -- \
  --endpoint ws://localhost:8787 \
  --origin http://localhost:3000 \
  --events 10000 \
  --scenarios 2-active,10+10,20-active,20-cold \
  --runs 3 \
  --rate 20 \
  --output reports/performance/YYYY-MM-DD-realtime-suite/local.json
```

- `2-active`: participant 2
- `10+10`: participant 10 + viewer 10
- `20-active`: participant 20
- `20-cold`: 2 participantで生成後、viewer 20が同時full replay

previewは開始済みの公開試験roomを用意し、`--web-origin`と`--public-slug`を追加する。
各connectionは正式なguest session / ticket APIを通す。local actor直指定経路は
previewでは無効であり、検証用bypassを追加しない。

ブラウザcold replay:

```text
http://127.0.0.1:4173/tools/event-log-benchmark/web/?events=100000&actors=5&yield=8&autorun=1
```

各条件を3回以上実行し、median、p95またはmaxを記録する。

通常roomは93,000 drawing eventsでsoft closeへ入るため、Realtimeの同一roomへ
100k以上を投入しない。10k / 50k / 90kを製品境界の判定値とし、100k / 150k /
250k / 400kはoffline renderer、snapshot Worker、full replay fixtureで
上限見直し材料を取得する。製品の活動量fenceを測定のために解除しない。

## Metrics

### Client

- local input to provisional p50/p95
- remote provisional p50/p95
- first drawing
- full recovery
- max main-thread slice
- Long Task
- peak memory
- live catch-up queue count/bytes

### DO

- event persist time
- broadcast time
- SQLite database size
- event read/chunk time
- CPU time / wall time
- reject reason
- hibernation wake recovery

### Snapshot

- Queue delay
- decode/rasterize/encode
- Worker CPU / wall / peak memory
- object bytes
- R2 PUT/GET/delete
- manifest commit
- hash match
- snapshot + tail recovery
- snapshot recoveryはoffer受信、認可済みobject取得、object/RGBA hash検証、
  tail、readyを分けて測る。20同時復帰では接続ごとにsnapshot baseが異なり得るため、
  `tail events = ready roomSeq - snapshot baseRoomSeq`を検証する。
- full replayとの差
- fallback率

previewの本線測定は50,000-event initial snapshotと、その後5,000-eventごとの
incremental snapshotを対象にする。5,000 eventsは10,000 eventsとの比較後に
本番を含む既定値へ昇格した。100,000-event full replayは回帰検知用のlocal worst case
として残し、通常のWorkerが毎回100,000件を先頭から再生する設計にはしない。

実ブラウザのnetwork matrixは
`npm run benchmark:browser-recovery -- --public-slug <slug>`を使用する。
Chrome CDPへ50 / 200 / 500msを指定し、各条件3回以上、snapshot offer / fetch /
hash / decode / apply、tail decode / apply、ready / paintとnavigation timingを
保存する。CDP値は「request送信からresponse header受信までの最小latency」であり、
物理経路RTTとは区別する。同条件のsame-origin GET calibrationも3回以上保存する。
throughputは既定で無制限とし、latency単独比較後に必要な場合だけ固定する。

browser reportへ公開slug、guest cookie、room ticketを保存しない。viewer roleと
正式guest ticket APIだけを使い、snapshot未提示、tail件数不一致、paint timeoutは
fail-fastする。

Worker CPU / wallは`wrangler tail --format json`、memory usageはGraphQL Analytics
APIの`workersInvocationsAdaptive`から取得する。Workers内部の`Date.now()`や
`performance.now()`はI/O間で時刻が進まないため、CPU判定の正本にしない。

## Acceptance

初期目標:

- local provisional p95 <= 32ms
- remote provisional p95 <= 250ms
- remote committed <= 1s
- standard client: first drawing <= 500ms、100k full recovery <= 3s
- low-end client: first drawing <= 1s、100k full recovery <= 8s
- max slice目標16ms、50ms超Long Taskなし
- snapshot generatorは利用するWorker制限へ30%以上の余裕を目標
- snapshotはfull replayより明確に速い
- snapshot/full canonical RGBA hash 100%一致
- snapshot失敗でevent loss 0

## Snapshot decision

2026-07-28にGate Bをpassしてsnapshot-firstを採用した。以下は採用判断と
今後`compact`へ進める際の回帰条件として保持する。

### Adopt

- canonical hash一致
- client/Worker目標達成
- Queue/R2/manifest failure tests成功
- shadow期間の成功率を満たす
- 運用手順が許容範囲

### Defer

- 外部container必須
- renderer差異を解消できない
- snapshotがfull replayより有意に速くない
- event削除の安全性を証明できない
- MVP主要経路を大きく遅延

重大な回帰時は新規roomを`event_log_only`または`shadow`へ戻し、
compaction済みroomだけsnapshot + tailを継続する。

## Result record

結果JSONまたはMarkdownに必ず残す。

- commit SHA
- date、environment、Cloudflare plan
- fixture hash
- protocol / renderer version
- codec / batching
- connection/network/client条件
- raw metrics
- pass/fail
- anomaly
- decision

保存先候補:

```text
reports/performance/YYYY-MM-DD-{scenario}/
```
