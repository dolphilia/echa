# Phase 7: performance measurement foundation

更新日: 2026-07-29  
状態: realtime、snapshot、browser recoveryのpreview測定を完了し、
5k snapshot増分を本番を含む既定値へ採用

## 実装

既存`tools/realtime-benchmark`をschema v2へ更新した。

- 接続総数とdrawing participant数を分離
- 残りをviewer roleのbroadcast-only observerとして接続
- 最大20 viewerの同時cold full replay
- broadcast delivery完了待ちと欠落数
- room再利用時の`roomSeqBefore` / `roomSeqAfter`
- 3回以上を必須にするsuite runner
- run生値とscenario単位のmedian / p95 / max
- commit SHA、dirty state、fixture定義SHA-256
- previewでは正式なguest session / room ticket APIを使用
- `snapshot-required`でsnapshot offerがない接続をfail-fast
- Web client共通のobject hash / RGBA hash検証
- 接続ごとのsnapshot base、tail期待件数、offer / fetch / ready時間

Cloudflare previewへactor直指定の検証bypassは追加していない。公開・開始済みの
試験roomを指定した場合だけ、Web APIからconnectionごとの短命ticketを取得する。
ticketとcookieは結果へ保存しない。

2026-07-29にsnapshot-aware recoveryを追加した。snapshot modeではfull replayへ
暗黙fallbackせず、20接続それぞれについて
`tail event count = ready roomSeq - snapshot baseRoomSeq`を検証する。snapshot生成が
接続開始中に切り替わってbaseが混在しても、集約値ではなく接続単位で判定できる。
`npm run lint`、全workspace typecheck、全test（Realtime 63、Snapshot 6、Web 40、
Protocol 29を含む）は成功した。

## Local smoke

生データ:
[`../../reports/performance/2026-07-29-realtime-suite/local-smoke.json`](../../reports/performance/2026-07-29-realtime-suite/local-smoke.json)

条件:

- local Wrangler / SQLite-backed Durable Object
- synthetic complete stroke、1 appendあたり6 points
- 120 events / scenario
- 40 events/s / active participant
- 各scenario 3回
- Node WebSocket + MessagePack decode。Browser rasterizeは含まない

| scenario | 構成 | ack p95のrun median | cold complete p95のrun median | broadcast欠落 | recovery件数不一致 |
| --- | --- | ---: | ---: | ---: | ---: |
| 2-active | participant 2 | 7.95ms | 10.14ms | 0 | 0 |
| 10+10 | participant 10 + viewer 10 | 7.93ms | 8.77ms | 0 | 0 |
| 20-active | participant 20 | 12.20ms | 6.45ms | 0 | 0 |
| 20-cold | participant 2、同時replay viewer 20 | 6.12ms | 58.59ms | 0 | 0 |

これは測定器の構造確認であり、MVP性能判定値ではない。`10+10`の1 runで
ack p95 78.13ms、max 101.12msの外れ値があり、3回の生値を残す必要性も確認した。

refactor後の追加smokeではparticipant 2 + viewer 2、60 events、同時cold viewer 3で
broadcast 240 / 240、各recovery 60 / 60、ack p95 10.34msだった。

## Preview: 10 participants + 10 viewers

生データ:
[`../../reports/performance/2026-07-29-realtime-suite/preview-10-plus-10.json`](../../reports/performance/2026-07-29-realtime-suite/preview-10-plus-10.json)
／
[`../../reports/performance/2026-07-29-realtime-suite/preview-10-plus-10-worker-metrics.json`](../../reports/performance/2026-07-29-realtime-suite/preview-10-plus-10-worker-metrics.json)

条件:

- `koge-realtime-preview` / 正式guest session・短命room ticket経路
- 公開・開始済みの使い捨てroom
- participant 10 + viewer 10（製品上限20 WebSocket）
- synthetic complete stroke、1 appendあたり6 points
- requested 10,000 events / run、実数9,990 events / run
- 20 events/s / active participant、合計約200 events/s
- 3回、同じroomへ累積29,970 events
- Node WebSocket + MessagePack decode。Browser rasterizeは含まない

| run | roomSeq | ack p95 | ack max | cold first | cold complete | broadcast |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0 → 9,990 | 128.48ms | 382.65ms | 513.60ms | 981.86ms | 199,800 / 199,800 |
| 2 | 9,990 → 19,980 | 142.55ms | 335.49ms | 690.41ms | 1,353.73ms | 199,800 / 199,800 |
| 3 | 19,980 → 29,970 | 380.54ms | 2,379.73ms | 680.17ms | 2,242.80ms | 199,800 / 199,800 |

3 run合計で29,970 events、599,400 broadcast deliveriesの欠落は0だった。
cold full replayのevent件数も9,990 / 19,980 / 29,970ですべて`roomSeqAfter`と一致した。
送信量は各runとも約199.8 events/sを維持できた。

ack p95のrun medianは142.55msでremote provisional 250ms目標内だが、3 run目は
380.54ms、ack maxは2.38秒となった。機能的な欠落はない一方、remote p95を
安定して満たしたとはまだ判定しない。Worker metric、別roomでの再現性、RTT、
Browser main-threadの結果と合わせて原因を分離する。

full replay完了はevent累積に応じて0.98秒、1.35秒、2.24秒と増加した。
29,970 events時点では3秒以内だが、100k目標の判定にはsnapshot + tailを含む
Browser recovery matrixが必要である。

接続前にhostタブが開いていると、host 1 + suite 20が製品上限を超えて
`429 ROOM_CAPACITY_REACHED`になる。20接続試験中はhostタブだけを閉じ、room自体は
終了しない。失敗した試行は全接続確立前に停止したためdrawing eventを生成しなかった。

Worker metrics照合対象は`2026-07-28T17:24:00Z`から
`2026-07-28T17:29:00Z`。13 samples、125 requestsで`errors`合計は0だった。
内訳は`success` 65、`clientDisconnected` 60。後者は各run完了後にsuiteが
WebSocketを閉じた時刻と一致し、Cloudflareでもsuccess requestに含まれる分類である。

最大memory p999は2,482,188 bytes（約2.37 MiB）で、128 MiB上限の約1.85%。
30% headroom基準93,952,409 bytesを大幅に下回った。観測時間窓でmemory圧迫、
`exceededResources`、script exception、internal errorはない。

CPU quantileのAPI生値は、全sample中の最大でp50 4,535、p99 10,226だった。
現在の取得器はGraphQL値へ単位を付与していないため、誤った換算を避けて生値で保存する。
少なくともresource超過は0であり、3 run目のclient ACK外れ値をWorker CPUまたは
memory上限超過で説明する証拠はない。次回はWorker Logs / traceとの時刻相関、
client RTT、GC / local schedulingも候補にして切り分ける。

## Preview: 20 simultaneous cold recovery

生データ:
[`../../reports/performance/2026-07-29-realtime-suite/preview-20-cold.json`](../../reports/performance/2026-07-29-realtime-suite/preview-20-cold.json)
／
[`../../reports/performance/2026-07-29-realtime-suite/preview-20-cold-worker-metrics-summary.json`](../../reports/performance/2026-07-29-realtime-suite/preview-20-cold-worker-metrics-summary.json)

条件:

- `koge-realtime-preview` / 正式guest session・短命room ticket経路
- 公開・開始済みの別の使い捨てroom
- 2 participantで送信後に切断し、viewer 20を同時full replay
- synthetic complete stroke、1 appendあたり6 points
- requested 10,000 events / run、実数9,996 events / run
- 20 events/s / active participant、合計約40 events/s
- 3回、同じroomへ累積29,988 events
- Node WebSocket + MessagePack decode。Browser rasterizeは含まない

| run | roomSeq | ack p95 | replay first p95 | replay complete p50 | replay complete p95 | replay max |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0 → 9,996 | 151.54ms | 2.89s | 9.37s | 10.20s | 10.26s |
| 2 | 9,996 → 19,992 | 103.33ms | 4.74s | 40.29s | 42.44s | 43.38s |
| 3 | 19,992 → 29,988 | 97.53ms | 8.79s | 127.38s | 131.94s | 132.72s |

3 run合計29,988 eventsの通常broadcastは59,976 / 59,976で欠落0。
各runの20 recovery connectionsすべてで最小・最大event件数が`roomSeqAfter`と一致し、
欠落や余分なeventはなかった。送信中のack p95 run medianは103.33msで、
通常描画経路はremote provisional 250ms目標内だった。

一方、同時full replayは明確な性能目標未達である。10k時点からfirst frame p95が
2.89秒、complete p95が10.20秒で、standard first drawing 500ms / recovery 3秒を
満たさない。30kではfirst frame p95 8.79秒、complete p95 131.94秒まで悪化した。
Browser rasterizeを含まないNode測定なので、client描画最適化だけでは解決できない。

event件数は完全一致しておりcorrectness failureではないが、full event logを20接続へ
一斉送出する復帰経路はMVPの性能fallbackとして不十分である。snapshot + bounded tailを
本線に維持し、snapshot unavailable時のfull replayには同時復帰制御、chunk間yield、
backpressure、replay payload共有・encode削減を検討する。次のsnapshot recovery試験では
同じ10k / 20k / 30k、20同時接続条件を対照群として使う。

Worker metrics照合対象は、replay完了を含めて`2026-07-28T17:42:00Z`から
`2026-07-28T18:00:00Z`。19 samples、126 requestsで`errors`合計は0。
内訳は`success` 64、`clientDisconnected` 62だった。最大memory p999は
2,523,148 bytes（約2.41 MiB）で、128 MiB上限の約1.88%に留まり、
30% headroom基準を大幅に下回った。

CPU quantileのAPI生値は全sample中の最大でp50 6,299、p99 6,585。
前回10+10試験の最大p99 10,226を上回らず、resource超過、script exception、
internal errorも0だった。したがって、30k / 20同時replayの約132秒という遅延を
Worker CPUまたはisolate memory上限で説明する証拠はない。現状の主要候補は、
同じDOから20接続へ大量のevent frameを個別送出する際の直列処理、WebSocket
backpressure、encode / copy、ネットワーク転送量である。

## Preview: 20 simultaneous snapshot + bounded tail

生データ:
[`../../reports/performance/2026-07-29-realtime-suite/preview-snapshot-seed-50k.json`](../../reports/performance/2026-07-29-realtime-suite/preview-snapshot-seed-50k.json)
／
[`../../reports/performance/2026-07-29-realtime-suite/preview-20-cold-snapshot.json`](../../reports/performance/2026-07-29-realtime-suite/preview-20-cold-snapshot.json)
／
[`../../reports/performance/2026-07-29-realtime-suite/preview-snapshot-recovery-worker-metrics-summary.json`](../../reports/performance/2026-07-29-realtime-suite/preview-snapshot-recovery-worker-metrics-summary.json)
／
[`../../reports/performance/2026-07-29-realtime-suite/preview-replay-frame-cache-summary.json`](../../reports/performance/2026-07-29-realtime-suite/preview-replay-frame-cache-summary.json)
／
[`../../reports/performance/2026-07-29-realtime-suite/preview-replay-frame-cache-worker-metrics-summary.json`](../../reports/performance/2026-07-29-realtime-suite/preview-replay-frame-cache-worker-metrics-summary.json)

50,010 eventsを10 participant、合計約200 events/sで投入した。ACK p95は222.67ms、
500,100 broadcast deliveriesの欠落は0。直後のsnapshot-required接続ではofferが
まだなくfail-fastした。Worker metricsでは50k到達直後の`00:51:18Z`に
Snapshot Worker `clientDisconnected`が1件、`00:52:16Z`にsuccessが1件ある。
最初のfull snapshotは約1分待ってcommitされた。切り分け用に追加した完全stroke
3 eventsはcommit後のため、trigger原因ではない。commit確認用3 events後のroomSeqは
50,016。

その後、2 participantで9,996 eventsずつ追加し、各run後にviewer 20を
`snapshot-required`で同時復帰させた。60 recovery connectionsすべてでsnapshot
object hash / RGBA hash検証が成功し、full replayへのfallbackは0、tail件数不一致0、
通常broadcast欠落0だった。

| run | roomSeq | snapshot base | tail / connection | offer p95 | fetch+verify p95 | ready p95 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 50,016 → 60,012 | 50,010 | 10,002 | 3.52s | 4.74s | 9.40s |
| 2 | 60,012 → 70,008 | 60,012 | 9,996 | 2.30s | 3.19s | 10.46s |
| 3 | 70,008 → 80,004 | 70,014 | 9,990 | 2.45s | 3.36s | 8.74s |

snapshot + bounded tailは、full replayの20k 42.44秒、30k 131.94秒という累積悪化を
解消し、60kから80kでもready p95を約9〜10.5秒へほぼ一定に保った。snapshot-firstの
採用判断は支持される。ただしstandard recovery 3秒目標は満たさない。

各runのcold recovery開始時点では直前snapshot生成がまだcommitされていないため、
約10k tailが残る。DOの現行`sendReplay`は1接続ごとに最大500 eventsを同期while loopで
読み、encode、`ws.send`する。20 connect requestは同じroom DOで直列に調整されるため、
先行接続への10k tail送出が後続接続のsnapshot offerを遅らせる構造である。
次は機能を変えず、replay chunk間yield、encode済みchunk共有、backpressure計測を
個別に試し、offerとreadyのどちらが改善するか測る。

Realtime / Snapshot Worker metrics照合対象はseed、snapshot生成、3 runsを含め、
`2026-07-29T00:46:00Z`から`2026-07-29T01:09:00Z`。

Realtime Workerは32 samples、222 requests、errors 0。memory p999最大は
2,490,380 bytes（約2.38 MiB、128 MiB上限の約1.86%）、CPU API生値p99最大は
9,785だった。約9〜10.5秒のready時間をRealtime Workerのmemory / CPU上限超過で
説明する証拠はない。

Snapshot Workerは4 invocations、errors 0。最初のfull generation成功時はCPU API
生値24,156,322、memory p999約35.05 MiB（上限の約27.38%）。後続incremental
generation成功時はCPU API生値3,104,652 / 4,135,264、memory p999約21.80 MiBで、
full generationより明確に小さい。全sampleが30% headroom基準約89.60 MiBを満たす。

最初の`clientDisconnected`はerrors 0だが、直後の接続でsnapshot未提示、
58秒後のsuccess後に提示された時系列と一致する。Queue retryまたはinvocation中断から
成功へ収束した可能性が高い。断定にはQueue delivery attemptと構造化job logの相関が
必要であり、今後はsnapshot job ID、attempt、queued / started / committed時刻を
結果へ結合する。

2026-07-29にRealtimeの復帰経路へ、機能を変えない構造化ログを追加した。
snapshot offerの有無とjob ID / base roomSeq、resume位置、ready roomSeq、
replay event / frame / encoded bytesを1接続単位で記録する。
個人識別子、ticket、cookie、token、描画payloadは記録しない。preview Worker
version `fcf777b6-6889-4553-a4e0-cc4d64659ed8`へ配備し、health checkに成功した。
Cloudflare上では`performance.now()`と`Date.now()`がI/O後にしか進まないため、
同期encode / send区間のアプリ内時間計測値は0になり、指標から除外した。CPU / wall
timeはinvocation observabilityで測り、アプリログは仕事量との相関に使う。

計測では1接続あたり9,993 events、40 frames、約2.59 MBを20接続それぞれで
encodeしていた。これを受け、`afterRoomSeq + throughRoomSeq`をkeyとする1-entry、
最大8 MiBのencode済みframe cacheを実装した。上限を超えるfull replayはcacheせず
逐次送信するため、fallbackのmemory使用量を不必要に増やさない。全回帰test通過後、
preview Worker version `43e9d904-3e42-4fa0-bedc-f01a37dab23d`へ配備した。

同じsnapshot base、約10k tail、20同時復帰の単独run比較では、cache導入後に
snapshot offer p95が3.44秒から0.64秒（81.5%短縮）、first frame p95が3.65秒から
0.68秒（81.3%短縮）、ready p95が11.72秒から7.28秒（37.9%短縮）になった。
全20接続でsnapshot hashとtail件数は一致した。frame共有は維持する。

その後にincremental snapshotがbase 80,016でcommitされた。tail 3 eventsでは
ready p95 0.78秒、そこから5,001 eventsを追加した試験ではoffer p95 0.43秒、
first frame p95 0.48秒、ready p95 5.12秒だった。encode共有後はoffer遅延が抑えられ、
残る主因は全接続へのtail配送とクライアント処理である。10k tailの3秒目標は未達で、
5kでも未達のため、snapshot間隔を下げる費用対効果と、実ブラウザ・別ネットワークでの
受信 / decode / rasterize内訳を次に測る。

`01:19Z`から`01:30Z`のRealtime Worker metricsは40 samples、359 requests、
errors 0で、`success` 256、`clientDisconnected` 103だった。WebSocket benchmarkは
復帰完了後にclient側からcloseするため後者が発生するが、Cloudflareのrequest
success分類には`success`と`clientDisconnected`の両方が含まれる。

全時間窓のmemory p999最大は2,691,596 bytes（約2.57 MiB、128 MiB上限の約2.01%）。
約10k tailの配備前後では2,687,372 bytesから2,691,596 bytesで、測定上の差は
4,224 bytes（0.16%）だった。8 MiB cap付きframe cacheによる有意なmemory悪化は
観測されていない。success statusに限定したCPU API生値p99最大は8,753から6,001へ
31.4%低下した。ただしWebSocket lifecycleを含むstatus単位quantileであり、
function単位のencode時間とは扱わない。client latencyの改善と合わせ、encode共有を
維持する根拠とする。5k tail時間窓も61 requests、errors 0、memory p999最大
2,486,284 bytesで、resource上限の兆候はない。

## Browser recovery計測

2026-07-29にChrome DevTools MCPの接続を確認し、previewのトップページで配備前の
基準traceを取得した。network / CPU throttlingなしでLCP 466ms、CLS 0、
TTFB 204ms、LCP render delay 262msだった。これは復帰処理を含まないWeb配信基準で
あり、room recoveryとの比較対象としてのみ扱う。要約は
[`../../reports/performance/2026-07-29-browser-recovery/preview-home-baseline-summary.json`](../../reports/performance/2026-07-29-browser-recovery/preview-home-baseline-summary.json)
に保存した。

実ブラウザのボトルネックを分離するため、Web clientへ
`koge.browser-recovery.v1`を追加した。`window.kogeBrowserRecoveryMetrics`から、
次の内訳を取得できる。

- WebSocket openとsnapshot offer
- snapshot fetch、body read、object hash、decode、RGBA hash
- snapshot pixels適用とcanvas present
- tailの最初の処理、frame / event / encoded bytes、decode / apply
- readyと、その後のdouble `requestAnimationFrame`によるpaint到達
- snapshot fallback理由

同じ境界をUser Timingの`koge-recovery-*` mark / measureにも出す。room slug、
actor、ticket、cookie、token、job ID、描画payloadは保存しない。計測の追加後、
Webのlint、typecheck、40 unit tests、production buildはすべて成功した。既存の
Playwright smokeは旧`/?sync=1&room=...`経路を参照しており、統合後のroom routeと
一致しないため、製品側へ検証bypassを戻さず別途更新する。

preview Web Worker version
`dbfa30fd-cf7d-46d6-b738-6419dfb10dc6`へ配備し、
`https://preview.koge.app`のHTTP 200を確認した。次は新規roomを使ってChrome標準条件を
3回測り、snapshot interval候補とCPU / RTT条件を1要因ずつ比較する。

### Chrome実ブラウザ比較

新規preview roomへ50,002 eventsを投入し、base 50,002の初回snapshot commitを
確認した。最初の40 events/s・pipeline seedは製品rate limiterにより22,996 eventsで
停止したため、bypassせず15 events/sへ下げ、受理済み位置から再開した。試験roomの
最終位置は60,010で、90k上限内に保った。

base 50,002、tail 3 eventsのChrome標準3回では、paint到達median 736.4ms、
max 759.7msだった。snapshot objectは7,564 bytes、展開RGBAは2,457,600 bytesで、
snapshot検証median 359.5ms、canvas適用median 2.6ms、tail適用median 4.7msだった。

5,010 eventsを追加し、base 50,002からtail 5,013 events / 21 frames /
1,226,425 encoded bytesとした比較は次のとおり。

| 条件 | paint median | snapshot検証 median | tail適用 median |
| --- | ---: | ---: | ---: |
| 標準 | 1,915.6ms | 468.2ms | 1,099.9ms |
| CPU 4x slowdown | 5,220.9ms | 397.2ms | 4,415.9ms |
| Slow 4G preset | 7,849.5ms | 734.2ms | 1,316.1ms |

標準では単一ブラウザの3秒目標内だが、CPU 4xではcanvasへのtail適用、Slow 4Gでは
first tailからreadyまでの配送区間（median 6,422.7ms）が支配した。Nodeの20同時
5k tail ready p95 5.12秒との差から、同時fan-outと単一clientの処理を分離できた。

さらに合計60,007 eventsで10k増分snapshotをcommitし、tailを3 eventsへ戻した。
同条件のpaint medianは標準720.0ms、CPU 4x 673.5ms、Slow 4G 1,379.6msとなり、
5k tail条件からそれぞれ62.4%、87.1%、82.4%短縮した。全18 browser runsで
snapshot source、base、tail件数が一致し、timeoutは0だった。

この結果は、現在の10k増分snapshot間隔が標準単一clientには十分でも、低速回線や
低性能端末では5k tailが大きいことを示す。次の候補は5k間隔であり、生成回数・Queue
費用・Worker CPUを同じroom活動量で10k間隔と比較してから変更を決める。生値は
[`../../reports/performance/2026-07-29-browser-recovery/preview-chrome-standard-50k-snapshot.json`](../../reports/performance/2026-07-29-browser-recovery/preview-chrome-standard-50k-snapshot.json)
と
[`../../reports/performance/2026-07-29-browser-recovery/preview-chrome-snapshot-interval-comparison.json`](../../reports/performance/2026-07-29-browser-recovery/preview-chrome-snapshot-interval-comparison.json)
に保存した。

previewだけ`SNAPSHOT_MIN_EVENT_DELTA=5000`へ変更し、Realtime Worker version
`d2d9bf13-55bb-48e7-87fe-faca0370b972`へ配備した。local既定値は10kのままとした。
base 60,007から5,016 events増加した位置でbase 65,023のincremental snapshotが
commitされ、snapshot-required probeはtail 3、件数不一致0、ready 607.8msだった。
Realtime 63 testsとdry-runは成功した。

1 roomが50kから90kまで進む単純モデルでは、10k間隔は初回を含め5 jobs、5k間隔は
9 jobsになる。したがってincremental Queue / Worker invocation / R2 PUTとsource
snapshot readは2倍、全job数は1.8倍になる。現在の実装はcommit済みobjectをroom終了
まで保持するため、R2 object数も5から9へ増える。fixtureの7,564-byte objectなら
差は約30 KiB / roomだが、実データの圧縮率を別途確認する。

5k jobのCloudflare Worker CPU / memory取得には
`CLOUDFLARE_ANALYTICS_API_TOKEN`を同じshellへexportしたうえで、
`02:55:30Z`から`02:57:10Z`の`koge-snapshot-preview`を照会する必要がある。
取得結果は1 invocation、success、errors 0、CPU API生値1,923,344、memory p999
18,327,956 bytes（約17.48 MiB、上限から86.3%余裕）だった。既存10k incremental
2 samplesはCPU 3,104,652 / 4,135,264、memory 22,860,760 bytesであり、5k jobは
CPUが38.0〜53.5%、memoryが19.8%小さい。

同じ10k増分を5k job 2回で処理する単純推定CPUは3,846,688で、10k job 2 samplesの
平均3,619,958より6.3%高い。Worker CPU総量はほぼ同程度、invocation / Queue /
R2 PUTとsource readは約2倍、50kから90kまでの全job数は1.8倍になる。一方、
実ブラウザのpaint medianは標準62.4%、CPU 4x 87.1%、Slow 4G 82.4%短縮した。

判定は**previewで5k intervalを維持**とする。復帰改善に対して暫定resource costは
許容範囲である。ただし5k Worker sampleは1件だけなので、本番既定値にはまだ昇格せず、
異なるroom / 実操作fixtureで最低3 incremental jobsの成功・CPU・memoryを集める。
生metricsは
[`../../reports/performance/2026-07-29-browser-recovery/preview-5k-snapshot-worker-metrics.json`](../../reports/performance/2026-07-29-browser-recovery/preview-5k-snapshot-worker-metrics.json)
に保存した。

### Exact latency測定器

Chrome DevToolsのSlow 4G presetを分解するため、
`tools/browser-recovery-benchmark`を追加した。Chrome CDPの
`Network.emulateNetworkConditionsByRule`と`Network.overrideNetworkState`へ
50 / 200 / 500msを明示し、各条件3回以上のbrowser recoveryを測る。

- viewer roleと正式なguest ticket経路だけを使用
- snapshot source、base、`tail = ready - base`、paint完了をfail-fast検証
- snapshot fetch / verification / apply、tail decode / apply、ready / paintを保存
- DOMContentLoaded、load event、FCP、CLI wall timeを保存
- same-origin GET calibrationを各条件3回保存
- public slugはSHA-256 digestだけを保存し、cookie / ticketは保存しない
- throughputは既定で無制限とし、latencyだけを1要因として変更

CDP値の意味は「request送信からresponse header受信までの最小latency」であり、
物理経路RTTとは断定しない。Chrome起動と50ms rule設定のsmoke、5 unit tests、
root lint、全workspace typecheck、全testが成功した。Realtime test終了時に
Vitest RPC teardown warningが1件出たが、11 files / 63 testsはpassしprocessも
exit 0だった。

新規preview roomへ50,040 eventsを投入してinitial snapshotを生成し、その後
5,010 eventsずつ2回増加させた。最終probeではbase roomSeq 60,066、tail 3、
snapshot object 7,564 bytes、event件数不一致0、ready 621.4msだった。room全体は
60,069 eventsであり、93,000-event soft closeの内側に収めた。

同じroomの最終snapshotに対し、50 / 200 / 500msを各3回測定した。9 runsすべて
snapshot source、base 60,066、tail 3、ready roomSeq 60,069が一致し、timeoutと
tail件数不一致は0だった。

| CDP最小request latency | same-origin校正 median | ready後paint median | ready後paint max | CLI wall median |
| ---: | ---: | ---: | ---: | ---: |
| 50ms | 328.9ms | 697.1ms | 720.9ms | 1,702.6ms |
| 200ms | 228.4ms | 655.1ms | 723.1ms | 1,932.4ms |
| 500ms | 506.7ms | 1,179.1ms | 1,181.2ms | 3,059.4ms |

50msと200msはsame-origin校正自体が逆転しており、公開previewまでの基礎遅延と
3回だけの標本の揺らぎが設定差より大きい。この2条件の約42ms差を改善とは扱わない。
500ms校正は506.0〜508.0msへ収束し、ready後paintも1,170.4〜1,181.2msへ収束した。
したがって、明示的な高遅延下でもsnapshot + 3-event tailは単一Chromeで安定して
描画完了できることは確認できた。一方、50 / 200msの厳密な傾向比較にはruns数を
増やすか、固定したローカルproxy経路を使う必要がある。

browser生値は
[`../../reports/performance/2026-07-29-browser-recovery/room-2-exact-latency.json`](../../reports/performance/2026-07-29-browser-recovery/room-2-exact-latency.json)、
最終snapshot probeは
[`../../reports/performance/2026-07-29-browser-recovery/room-2-final-snapshot-probe.json`](../../reports/performance/2026-07-29-browser-recovery/room-2-final-snapshot-probe.json)
に保存した。slug、cookie、ticketはbrowser reportへ保存していない。

このroomでは5k境界を2回通過し、最終snapshot baseが60,066へ進んだ。Cloudflare
Analyticsでは04:44:57Zと04:46:12Zに独立したincremental invocationがあり、
どちらもsuccess、errors 0、memory 18,327,956 bytesだった。initial 50k jobも
04:42:27Zにsuccess、errors 0、CPU API生値11,092,688、memory 31,173,652 bytes
（Worker上限の23.2%）で完了した。生metricsは
[`../../reports/performance/2026-07-29-browser-recovery/room-2-snapshot-worker-metrics.json`](../../reports/performance/2026-07-29-browser-recovery/room-2-snapshot-worker-metrics.json)
に保存した。

異なる2 roomから得た5k incremental 3 samplesは、すべてsuccess、errors 0だった。

| 5k sample | CPU API生値 | memory |
| --- | ---: | ---: |
| room 1 | 1,923,344 | 18,327,956 bytes |
| room 2 / 1回目 | 1,861,915 | 18,327,956 bytes |
| room 2 / 2回目 | 1,360,536 | 18,327,956 bytes |
| 平均 | 1,715,265 | 18,327,956 bytes |

5k 2回で同じ10k増分を処理するCPU単純推定は3,430,530で、既存10k job 2 samplesの
平均3,619,958より5.2%低い。per-invocation memoryは10kの22,860,760 bytesより
19.8%小さく、Worker上限使用率は13.7%、余裕は86.3%だった。invocation / Queue /
R2 PUT / source read回数が増える欠点は残るが、CPU総量の悪化は観測されず、
実ブラウザではbounded tailによりpaint medianが62.4〜87.1%短縮している。

以上から、`SNAPSHOT_MIN_EVENT_DELTA=5000`を**本番を含む既定値へ昇格**する。
previewはすでに5kで稼働しているため再配備せず、共通設定の既定値を5kへ揃える。
運用ではsnapshot job成功率、Queue滞留、R2 object数、CPU総量を継続監視し、
費用または滞留が許容範囲を超えた場合は10kへ戻せるよう設定値を維持する。

## 境界

製品roomは93,000 drawing eventsでsoft closeする。このfenceを負荷試験のために
解除せず、Realtime製品経路は10k / 50k / 90kを測る。100k / 150k / 250k /
400kはoffline fixture、snapshot Worker、full replay rendererで上限見直し材料を
取得する。

Durable Objectはroom単位のcoordination atomを維持し、Hibernation WebSocket APIを
使用する。20接続はプラットフォーム上限を探る試験ではなく、MVPの製品上限を
検証する試験である。

## 次

1. 5k intervalのsnapshot成功率、Queue滞留、R2 object数、CPU総量を継続監視する。
2. 必要なら50 / 200ms条件のruns数を増やすか、固定local proxyで再測定する。
3. 必要ならfull replay fallbackのchunk間yieldとbackpressure制御を1要因ずつ試す。
4. snapshot jobのattempt / queued / started / committed時刻を結果へ結合する。
5. Safari / Firefoxへbrowser matrixを広げる。

同じroomへ投入する合計は90,000 events以下とし、試験後はhost終了でcleanupする。
