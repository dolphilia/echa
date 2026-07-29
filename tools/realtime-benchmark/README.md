# Realtime benchmark

Durable Object WebSocket vertical sliceへ複数actorから完全なstrokeを送り、ackとreplayを測定する。

local Workerを起動してから実行する。

```sh
npm run dev:realtime
npm run benchmark:realtime -- \
  --endpoint ws://localhost:8787 \
  --origin http://localhost:3000 \
  --events 900 \
  --connections 3 \
  --rate 40 \
  --output /tmp/koge-realtime-local.json
```

`--events`は3の倍数へ切り下げられ、各strokeをbegin / append / endの3 eventsとして送る。`--rate`は1接続あたりのevents/sであり、serverの暫定80 events/s・burst 120を通常測定で意図せず踏まない値にする。

高event-rate試験では`--pipeline true`にすると、ack待ちで送信を直列化せず、
rate指定どおりに送信して最後に全ackを待つ。`--points-per-append`は1〜12、
`--room`は固定room ID、`--replay false`は終了後のcold replay省略に使う。
`--ack-timeout-ms`はpipeline送信後に全ackを待つ上限で、既定は120秒である。
出力の`ackTimeline`はsnapshot Workerのtail eventと比較できる1秒bucketである。
`--active-connections`を接続総数より小さくすると、残りはviewer roleで
broadcastだけを受けるobserverになる。`--cold-recovery-connections`は送信完了後、
viewer roleで同時にfull replayする
接続数で、最大20である。

`--recovery-mode snapshot-required`はWebクライアントと同じsnapshot recoveryを要求する。
各接続でsnapshot offer、認可済みobject fetch、object SHA-256、decode、RGBA
SHA-256を検証してからtail / readyを処理する。snapshotが提示されなければ失敗し、
full replayへ暗黙fallbackしない。出力には接続ごとのsnapshot base、tail件数、
期待tail件数、offer / fetch / first tail / ready時間を残す。

previewではendpointとoriginだけを変更する。

```sh
npm run benchmark:realtime -- \
  --endpoint wss://realtime-preview.koge.app \
  --origin https://preview.koge.app \
  --web-origin https://preview.koge.app \
  --public-slug <started-public-room-slug> \
  --events 900 \
  --connections 3 \
  --rate 40
```

previewではactor直指定を使用できない。`--web-origin`と`--public-slug`を組にすると、
各connectionが正式なguest session / room ticket APIを通って接続する。対象roomは
公開、開始済み、試験後に終了してよいものを使う。ticket、guest cookieは出力へ
保存しない。同じroomでsuiteを反復すると`roomSeqBefore`が増えるため、
`roomSeqAfter`とcold recovery event件数を比較する。

出力の`acceptedToArrivalMs`はserverの`acceptedAt`とclient時計の差を含む。remote環境では絶対的な片道遅延ではなく、分布の変化検知に使う。主要な往復指標は`ackRttMs`とする。

Phase 7の反復suite:

```sh
npm run benchmark:realtime-suite -- \
  --endpoint ws://localhost:8787 \
  --origin http://localhost:3000 \
  --events 10000 \
  --scenarios 2-active,10+10,20-active,20-cold \
  --runs 3 \
  --rate 20 \
  --output reports/performance/2026-07-29-realtime-suite/local.json
```

各scenarioを3回以上実行し、run単位の生結果とmedian / p95 / maxを同じJSONへ
保存する。`10+10`は10 participant + 10 viewer、`20-cold`は送信後に20 viewerを
同時full replayする。NodeのWebSocket測定なのでBrowser rasterize、main-thread、
RTT emulationは別のBrowser matrixで扱う。

preview suiteでは同じ2 optionを追加する。

```sh
npm run benchmark:realtime-suite -- \
  --endpoint wss://realtime-preview.koge.app \
  --origin https://preview.koge.app \
  --web-origin https://preview.koge.app \
  --public-slug <started-public-room-slug> \
  --events 10000 \
  --scenarios 10+10 \
  --runs 3 \
  --rate 20 \
  --output reports/performance/YYYY-MM-DD-realtime-suite/preview-10-plus-10.json
```

現在の93,000-event soft limitを越えないよう、同じroomへ投入する全runのevent合計を
90,000以下にする。100k以上のvolume試験はoffline fixture / snapshot生成で行い、
本番相当roomのsoft closeを無効化しない。

snapshot + bounded tailの20同時復帰では、50k snapshotがcommit済みのroomを使う。

```sh
npm run benchmark:realtime-suite -- \
  --endpoint wss://realtime-preview.koge.app \
  --origin https://preview.koge.app \
  --web-origin https://preview.koge.app \
  --public-slug <started-public-room-with-committed-snapshot> \
  --events 10000 \
  --scenarios 20-cold \
  --runs 3 \
  --rate 20 \
  --recovery-mode snapshot-required \
  --output reports/performance/YYYY-MM-DD-realtime-suite/preview-20-cold-snapshot.json
```

同じroomへ10kずつ追加した場合、各runのsnapshot baseはsnapshot生成完了時刻により
変わり得る。判定は接続ごとに
`replayEventCount === roomSeqAfter - snapshotBaseRoomSeq`を使用する。
