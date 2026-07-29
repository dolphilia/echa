# Phase 2 realtime preview benchmark

日付: 2026-07-27  
環境: Cloudflare Workers preview、`realtime-preview.koge.app`  
基準commit: `8310025d87cf18db5be4f6818e58d63c547111b3` + 未commitのPhase 2実装  
protocol: v1 MessagePack、1 stroke = begin / append / end  
Cloudflare Workers plan: Paid（利用者確認済み）

## 配備

- Realtime Worker version: `8cae3352-9f1c-48fd-b559-0575991edc39`
- Web Worker version: `7a175a2b-3508-4109-a075-0ca1c1432c33`
- Realtime Worker startup time: 5ms
- Web Worker startup time: 19ms
- `/health`: 正常
- `https://preview.koge.app/?sync=1`: HTTP 200

## 結果

| 条件 | 実event | 実効events/s | ack p50 | ack p95 | ack p99 | replay first | replay完了 | broadcast欠落 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 3接続、900 requested、40 events/s/接続 | 900 | 45.3 | 62.4ms | 83.4ms | 115.4ms | 669.7ms | 732.1ms | 0 / 2,700 |
| 20接続、1,200 requested、20 events/s/接続 | 1,200 | 185.3 | 100.1ms | 132.2ms | 472.2ms | 1,384.6ms | 1,462.1ms | 0 / 24,000 |
| 20接続、10,000 requested、最適化前 | 9,960 | 202.2 | 95.4ms | 125.3ms | 152.5ms | 9,303.1ms | 9,791.3ms | 0 / 199,200 |
| 20接続、10,000 requested、最適化後 | 9,960 | 203.2 | 92.7ms | 128.0ms | 151.4ms | 529.5ms | 3,388.6ms | 0 / 199,200 |

requested event数は、各接続が完全な3-event strokeだけを送信するよう切り下げるため、10,000指定時の実event数は9,960となる。

生データ:

- [`phase2-realtime-benchmark-preview-3.json`](./phase2-realtime-benchmark-preview-3.json)
- [`phase2-realtime-benchmark-preview-20.json`](./phase2-realtime-benchmark-preview-20.json)
- [`phase2-realtime-benchmark-preview-10000.json`](./phase2-realtime-benchmark-preview-10000.json)
- [`phase2-realtime-benchmark-preview-10000-optimized.json`](./phase2-realtime-benchmark-preview-10000-optimized.json)

## 見つかったボトルネックと修正

最初の実装はreplay chunkへeventを1件追加するたびにchunk全体を再エンコードしており、500件ごとに二次的な処理量が発生していた。

修正後はSQLiteから最大500件を読み、まず1回だけMessagePackへエンコードする。64KiB上限を超えた場合だけ二分して再帰的にエンコードする。600-event replayとlive eventの順序試験を含むWorkers統合試験は修正後も成功した。

この変更により、9,960 eventsのfirst frameは9.30秒から0.53秒、completeは9.79秒から3.39秒へ改善した。

## 判断

- 最大20接続で、199,200回のbroadcast deliveryに欠落はなかった。
- 通常の描画頻度に近い20 events/s/接続では、20接続時にもack p95は約128msで、暫定remote committed目標1秒を満たす。
- 9,960-event replayだけでcompleteが約3.39秒であり、100,000-event full recoveryを標準clientで3秒以内にする目標はevent log単独では成立しない。
- このCLIはMessagePack decodeまでは含むが、browser Canvas描画、main-thread slice、memoryは含まない。実際のcold recoveryはさらに重くなる可能性がある。
- snapshot-firstの優先度を維持し、event log replayはfailure時のlossless fallbackとして扱うのが妥当。
- 50,000 / 100,000 event測定は、fallback時の待ち時間・メモリ・Worker CPUを把握するためには必要だが、snapshot要否の判断自体は10,000-event測定で十分に傾いた。
