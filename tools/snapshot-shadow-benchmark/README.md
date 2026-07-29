# Snapshot shadow benchmark

実操作のraw stroke fixtureを増幅し、同じevent列について次を比較する。

- event log先頭からの共通WASM full replay
- event log prefixからのsnapshot生成
- snapshotの復号・適用とtail replay
- full replayとsnapshot + tailの最終RGBA SHA-256

既定では10,000 / 50,000 / 100,000 drawing eventsを各3回測る。

```sh
npm run benchmark:snapshot-shadow -- \
  --input tools/event-log-benchmark/fixtures/echa-raw-strokes-2026-07-26T16-06-54-108Z.json \
  --events 10000,50000,100000 \
  --runs 3 \
  --tail-events 1000 \
  --output reports/performance/2026-07-27-snapshot-shadow/local.json
```

これはローカルNode上のWASM baselineであり、Browser main-thread、network、Durable
Object chunk read、Queue、R2の時間は含まない。Cloudflare previewと実ブラウザの測定を
置き換えるものではない。
