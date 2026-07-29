# Snapshot preview benchmark

Cloudflare previewで、実運用のsnapshot経路と同時描画への影響を測る。

- 50k到達時のfull snapshot
- その後10k増分のincremental snapshot
- Queue consumer invocationのCPU / wall time
- snapshot生成前・生成中のWebSocket ack RTT
- broadcast欠落

通常経路は50kで最初のsnapshotを作り、その後10k増分で再生成するため、
previewで100kを毎回full replayする測定は行わない。100k full replayはlocalの
worst-case測定に残す。

`wrangler tail`を先に起動し、JSON出力を保存する。

```sh
npx wrangler tail koge-snapshot-preview --format json \
  > /tmp/koge-snapshot-tail.json
```

別terminalで60k eventsを送る。20接続がrate limit内でpipeline送信し、
1 appendへ12 pointsを含める。

```sh
npm run benchmark:realtime -- \
  --endpoint wss://realtime-preview.koge.app \
  --origin https://preview.koge.app \
  --room snapshot-probe-<16-hex> \
  --events 60000 \
  --connections 20 \
  --rate 20 \
  --points-per-append 12 \
  --pipeline true \
  --ack-timeout-ms 180000 \
  --replay false \
  --output /tmp/koge-realtime-snapshot.json
```

snapshot完了後にtailを停止し、結果を結合する。

```sh
node tools/snapshot-preview-benchmark/cli/analyze.mjs \
  --realtime /tmp/koge-realtime-snapshot.json \
  --tail /tmp/koge-snapshot-tail.json \
  --output reports/performance/2026-07-27-snapshot-preview/result.json
```

CPU / wall timeはWorker内部timerではなく、Cloudflare tail eventの値を正とする。
custom logはjob ID、source / target、event / point / chunk数、object byte数を
correlation用に記録する。
