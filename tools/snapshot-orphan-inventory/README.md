# Snapshot orphan operator

preview Realtime Workerの専用Service Entrypointへlocalhostから接続し、runtime
snapshot孤児のscan、削除計画作成、承認済み計画の適用を行う。Workerはdeployせず、
公開HTTP endpointも作らない。

## 起動

```sh
npm run orphan-snapshots:operator
```

別terminalから操作する。

## 読み取りscan

```sh
npm run orphan-snapshots:scan
```

scanはR2 objectを削除せず、D1 inventoryだけを更新する。

## 削除計画

計画ファイルはobject keyを含むため、repository外へmode `0600`で作る。
既存ファイルは上書きしない。

```sh
plan_dir="$(mktemp -d /private/tmp/koge-orphan-plan.XXXXXX)"
plan_file="$plan_dir/plan.json"
npm run orphan-snapshots:plan -- --out "$plan_file"
```

出力されたファイルの全objectを人が確認する。計画は30分で失効する。

## 適用

計画作成者とは別の確認者が対象と件数を確認し、出力されたconfirmationを
そのまま指定する。

```sh
npm run orphan-snapshots:apply -- \
  --plan "$plan_file" \
  --confirm 'DELETE <plan-hash> <object-count>'
```

適用時に新しいscanを実行し、現在も孤児であること、key、room、reason、size、
upload時刻、etagが計画と一致することを再検証する。不一致、期限切れ、環境違い、
confirmation違いは削除前にfail closedとなる。

終了後はlocal Workerを`Ctrl-C`で止め、計画ファイルと専用一時directoryを削除する。
計画ファイル、object key、room IDを公開log、issue、chatへ貼らない。
