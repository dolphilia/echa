# Browser recovery latency benchmark

Chrome DevTools Protocolで指定したrequest latency条件ごとに、製品のguest viewer
経路からsnapshot recoveryを3回以上測定する。room slug、guest cookie、ticketは
結果へ保存せず、slugはSHA-256 digestだけを記録する。

```sh
npm run benchmark:browser-recovery -- \
  --web-origin https://preview.koge.app \
  --public-slug <started-public-room-with-committed-snapshot> \
  --latencies-ms 50,200,500 \
  --runs 3 \
  --output reports/performance/YYYY-MM-DD-browser-recovery/preview.json
```

`--latencies-ms`はChrome CDPの「request送信からresponse header受信までの最小
latency」を設定する。物理経路のRTTそのものとは断定せず、各条件でsame-origin GETを
3回実行した`calibrationMs`も保存する。download / upload throughputは既定で無制限。
帯域も固定する場合はbytes/sで指定する。

```sh
--download-bps 1600000 --upload-bps 750000
```

安全条件:

- 公開・開始済みで、snapshotがcommit済みの試験roomだけを使う。
- viewer roleだけで接続し、描画eventを追加しない。
- snapshotが提示されない、tail件数が一致しない、paint完了しない場合は失敗する。
- 各条件3回以上を必須にする。
- 試験終了後はhostがroomを終了する。
