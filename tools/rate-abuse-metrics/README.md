# Rate abuse metrics operator

preview Realtime Workerの専用Service Entrypointへlocalhostから接続し、closed betaの
rate abuse counterを個人情報なしで取得する。公開endpointは作らない。

```sh
npm run rate-abuse:operator
```

別terminalでbaselineをrepository外へ保存する。

```sh
capture_dir="$(mktemp -d /private/tmp/koge-rate-abuse.XXXXXX)"
npm run rate-abuse:capture -- --out "$capture_dir/baseline.json"
```

観測期間の終了時にcurrentを取得し、比較する。

```sh
npm run rate-abuse:capture -- --out "$capture_dir/current.json"
npm run rate-abuse:compare -- \
  --baseline "$capture_dir/baseline.json" \
  --current "$capture_dir/current.json"
```

captureにはroom ID、actor、chat本文、IPを含めず、room / cleanup jobのSHA-256
digestと累積counterだけを含む。終了roomのcounterはD1へ30日保持するため、
比較間隔は30日未満にする。`complete = false`なら終了結果の欠落またはcounterの
不整合があり、閾値判断には使わない。
