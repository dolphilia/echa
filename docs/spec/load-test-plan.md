# Load test plan

更新日: 2026-07-27
状態: 初期条件

## 目的

次の判断に必要な実測を揃える。

- 100,000 drawing events / 64MiB / 2時間が安全か
- 10-20接続で描画broadcastを維持できるか
- event log full replayがfallbackとして成立するか
- snapshot-firstをMVPから採用するか
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

ブラウザcold replay:

```text
http://127.0.0.1:4173/tools/event-log-benchmark/web/?events=100000&actors=5&yield=8&autorun=1
```

各条件を3回以上実行し、median、p95またはmaxを記録する。

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
- full replayとの差
- fallback率

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

defer時はevent_log_onlyでMVPを進める。

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
