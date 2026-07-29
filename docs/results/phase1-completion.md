# Phase 1 completion

日付: 2026-07-27  
状態: 完了

## 実装

- `@koge/protocol`にprotocol v1の型、runtime validator、codec、fixture変換を追加した。
- `StrokeOutbox`に50ms / 12 points batching、単調`clientSeq`、未送信・未ack buffer、ack処理を追加した。
- binary codecにMessagePackと数値wire opcodeを採用し、JSON debug codecを残した。
- 960 x 640固定論理Canvasへbrush / eraser / eyedropper / scrub zoom / wheel zoom / Space panを実装した。
- stroke専用provisional Canvasを100%濃度で再描画し、確定時だけ指定opacityでbase Canvasへ合成した。

## 自動検証

- canonical renderer fixtureの全eventをJSON / MessagePackでround tripした。
- 10分fixtureの実`dt`から4,112 eventsを再現した。
- invalid field、偽装server field、12 points超過、64KiB超過、不正binaryを拒否した。
- numeric wire opcodeをdecode後に同じlogical eventへ戻した。
- outboxのbatch、flush-before-end、未送信、retry、ackを検証した。
- repository全体のCloudflare型生成、lint、typecheck、17 tests、buildが成功した。

## ブラウザsmoke

local vinext appで次を操作確認した。

- brushの単点と連続stroke
- 35% opacityの高速strokeに継ぎ目の濃い縁が出ない
- sliderの連続入力
- eyedropperでbase Canvasのpixel色を取得しbrushへ戻る
- scrub zoomで100%から154%へ変化する
- ドット背景上のwheel zoomで倍率表示が出る
- Canvas表示は960 x 640のままviewport内でclipされる
- browser console errorなし

Space panはwindowのSpace key stateとworkspace pointer captureで実装し、Canvas外のドット背景を同じpointer handlerの対象にした。

## Gate

codec Gateは[`../decisions/0006-protocol-codec.md`](../decisions/0006-protocol-codec.md)で閉じた。測定値は[`phase1-codec-benchmark.md`](./phase1-codec-benchmark.md)を参照する。
