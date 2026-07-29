# Phase 3: snapshot preview performance

測定日: 2026-07-27  
環境: Cloudflare Workers Paid / preview  
基準commit: `8310025d87cf18db5be4f6818e58d63c547111b3` + 未commitの本測定instrumentation  
Snapshot Worker version: `01fa06ac-7b75-4479-b142-cd0efa99e113`  
Realtime Worker version: `d62b5760-ed32-43c9-959b-476f494dfad2`  
room: `snapshot-probe-20260727deed7890`

## 結論

実運用候補の50,000-event初回生成と、その後10,000-eventごとの増分生成は、
CPU、wall time、R2/manifest commit、ライブ配信欠落の観点で成立した。
初回生成のCPUは17.121秒で、Paid Workerの既定30秒上限に対して42.9%の余裕がある。
増分10,020 eventsはCPU 3.891秒だった。

20接続・合計約400 events/sのstress条件でもbroadcast欠落は0だった。snapshot中は
ACK RTTが一時的に上昇したが、増分測定全体のp95は196.7ms、最大556.7msで、
確定反映1秒以内の初期目標を維持した。

Cloudflare Analyticsのmemory p999も基準を満たしたためGate Bはpassとし、
snapshot-firstを採用する。通常roomの自動compactionは一括で有効にせず、Phase 6の
終了cleanupと監視を完成してから段階導入する。

## Snapshot Worker

| generation | source → target | events | points | CPU | wall | Queue delay | result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 initial | 0 → 50,220 | 50,220 | 217,620 | 17.121s | 34.908s | 6.421s | committed |
| 2 incremental | 50,220 → 60,000 | 9,780 | 42,380 | 5.439s | 10.417s | 2.970s | committed |
| 3 incremental + live | 60,000 → 70,020 | 10,020 | 43,420 | 3.891s | 8.877s | 2.275s | committed |
| 4 manual + live | 70,020 → 76,020 | 6,000 | 26,000 | 2.093s | 5.665s | 2.467s | committed |

初回は101 chunks、10,020-event増分は21 chunksを取得した。960 x 640 RGBAを
lossless codecへ保存したobjectは12,443 bytesだった。このfixtureは同じ場所を
繰り返し描くため圧縮率が高く、一般的な絵のobject size根拠には使わない。

## ライブ配信への影響

入力は20接続、各20 events/s、1 appendあたり12 points、pipeline送信とした。

### 初回50k生成を含む60k run

- accepted: 60,000 / rejected: 0
- effective rate: 399.76 events/s
- broadcast: 1,200,000 / 1,200,000、欠落0
- run全体ACK RTT: p50 95.1ms、p95 797.2ms、p99 1,415.1ms
- 初回snapshot直前10秒のACK平均: 100.8ms
- 初回snapshot中のACK平均: 135.5ms
- snapshot中の最大1秒bucket p95: 460.6ms

### 増分生成を含む20k run

- accepted: 19,980 / rejected: 0
- effective rate: 399.51 events/s
- broadcast: 399,600 / 399,600、欠落0
- run全体ACK RTT: p50 99.8ms、p95 196.7ms、p99 457.5ms、max 556.7ms
- 10,020-event snapshot直前10秒のACK平均: 96.9ms
- 同snapshot中のACK平均: 113.1ms
- 同snapshot中の最大1秒bucket p95: 211.0ms

この条件は20人が同時に描き続けるstress値であり、実測した1人10分の平均
約6.7 events/sより大幅に高い。初回run全体のp95/p99はsnapshot時間帯以外の
送信backlogも含むため、snapshotによる差分は時間bucketのbefore/duringを正とする。

## 測定中に修正した点

Cloudflare Workersでは、CPU処理中の`Date.now()` / `performance.now()`はI/Oが
発生するまで進まない。純粋な時刻差だけを使ったtoken bucketは、pipeline受信時に
burst上限後のtoken補充が止まった。

Realtime DOはtokenが閾値へ近づいた時だけ、bounded storage readをI/O境界として
時刻を更新するよう修正した。毎eventのstorage I/Oは行わない。これにより
60,000-event runでrate reject 0を確認した。

固定roomを複数回測る場合にstroke IDが衝突したため、benchmarkのstroke IDへ
run固有prefixも追加した。

## Memory

GraphQL Analytics APIの`workersInvocationsAdaptive`で、測定時間帯の4 invocationを
3 samplesとして取得した。

- memory usage p999最大: 31,596,578 bytes（約30.1 MiB）
- Worker上限: 134,217,728 bytes（128 MiB）
- 使用率: 23.5%
- 上限への余裕: 76.5%
- 30%余裕の判定線: 93,952,409 bytes
- errors: 0

memory p999は判定線の33.6%で、上限へ30%以上の余裕という目標を十分に満たした。

## Gate Bとcanary

Cloudflare tail eventはCPU / wallを返すがmemory usageを返さない。GraphQL
Analytics APIの`workersInvocationsAdaptive.quantiles.memoryUsageBytesP999`を取得し、
128 MiB制限の70%である93,952,409 bytes以下を判定線とした。

memory確認後、使い捨てroom `snapshot-probe-20260727deed7890`だけで
70,020 eventsまでcompactionした。current base 76,020、previous base 70,020、
最終roomSeq 79,980に対し、次を確認した。

- compaction cursor: 70,020
- 残存event: 9,960
- current snapshot + tail: 3,960 eventsを再生し79,980へ復帰
- previous snapshot + bridge/tail: 9,960 eventsを再生し79,980へ復帰
- snapshot無効: HTTP 409でfail-closed

最初の500-event canaryでは、SQLiteの1 queryあたり100 bound parameters上限に対し
500個の`IN` placeholderを生成する不具合が判明した。transactionはrollbackされ、
event削除やmode遷移は発生しなかった。削除を選択範囲の先頭・末尾roomSeqによる
range deleteへ修正し、105件を一括削除する回帰試験を追加した。修正版
Realtime Worker `8f6d3b12-bacd-4f83-8fee-a45323ff4a8c`で500-event chunkと
70,020-event完走を確認した。

Gate Bの決定は
[`../decisions/0007-snapshot-first-recovery.md`](../decisions/0007-snapshot-first-recovery.md)
に記録した。
