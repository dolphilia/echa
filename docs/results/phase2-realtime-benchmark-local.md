# Phase 2 realtime local benchmark

日付: 2026-07-27  
runtime: Wrangler local Workers runtime  
生データ: [`phase2-realtime-benchmark-local.json`](./phase2-realtime-benchmark-local.json)

## 結果

| 条件 | 実効events/s | ack p50 | ack p95 | ack p99 | replay完了 | broadcast欠落 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 3接続、900 events、40 events/s/接続 | 120.3 | 3.5ms | 7.0ms | 9.2ms | 168.8ms | 0 / 2,700 |
| 20接続、1,200 events、20 events/s/接続 | 405.2 | 7.0ms | 11.5ms | 16.8ms | 235.3ms | 0 / 24,000 |

## 判断

- 暫定上限20接続で、短時間のbroadcast順序と配信完全性は成立した。
- 50ms batchingの通常上限は1接続あたり概ね20 append/sである。測定した20 events/s/接続は通常の高活動状態に近く、20接続時にもack p95は11.5msだった。
- 3接続では暫定rate limit 80 events/s/接続の半分にあたる40 events/sを維持できた。
- replay値は1,200 eventsまでの基準値であり、100,000 eventsのGate判定を代替しない。
- local runtimeの値は回帰検出用であり、Cloudflare edge、実回線、端末decode/rasterizeを含むproduction容量とはみなさない。

次は同じCLIをpreviewへ実行し、100,000 eventについては既存fixture generatorと段階的な10,000 / 50,000 / 100,000 replay測定を組み合わせる。
