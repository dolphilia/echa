# Phase 3 Stage B: Browser integration

日付: 2026-07-27  
状態: 成立、Worker generationへ進行可能

## 実装

- `packages/renderer-core`へ増分描画用`RendererSession`を追加した。
- Browserは同じWASM binaryを静的assetとして読み込む。
- pointer移動中はCanvas 2Dで即時のprovisional表示を続ける。
- serverに受理されたstroke end時にWASM canonical resultへ置換する。
- cold replayは受信frame内の完了strokeをまとめてWASMへ適用する。
- local-only modeでもstroke end時にcanonicalへ置換する。
- 計測sampleは最新512件に制限し、長時間roomで増え続けないようにした。

WASM binary SHA-256:
`7bab6445ddb282e655f6d0c3b950b50eb965ea498ae8250c476a0aac4184037b`

増分sessionとfull renderは同じfixtureで同一RGBAを生成する。Stage Aから描画semanticsとgolden RGBA hashは変わらない。

preview:

- URL: `https://preview.koge.app`
- Web Worker version: `fb1806c7-98ba-47cb-bc0b-20bd32db3ce6`
- 配信WASM: 26,197 bytes
- 配信WASM SHA-256: build artifactと一致
- deployed pageでWASM読み込みとrealtime接続後の「同期中」表示を確認

## 実測

ローカルsystem Chrome、960 x 640 canvas、opacity 35%の1 stroke:

| metric | result |
| --- | ---: |
| provisional redraw p95 | 約0.1ms |
| accepted end後のWASM canonical適用 | 7.4ms |
| stroke影響pixel | 2,830 |
| provisional/canonical差分pixel | 511 |
| 差分率（影響pixel内） | 18.06% |
| channel平均絶対差 | 1.71 / 255 |
| channel最大差 | 63 / 255 |

差分は主にCanvas 2Dとfixed-point canonical rendererのedge coverage差である。平均差は小さく、確定時の置換は1 frame内に収まった。端末・stroke形状を増やした正式な分布測定はWorker generationと並行して継続する。

## 自動試験

- Rust:
  - 増分sessionとfull renderが一致する。
  - 低opacity stroke内の自己重複で濃い継ぎ目が生じない。
- Browser E2E:
  - local provisionalはpointer入力中に表示される。
  - accepted end後にWASM canonicalへ置換される。
  - 2 clientのbase canvas SHA-256が一致する。
  - reload後のcold replayも同じSHA-256になる。
  - provisional p95 32ms以下、canonical適用p95 250ms以下。
- 目視:
  - WASM読み込み後に同期状態へ遷移する。
  - 白canvasとツール配置に崩れがない。

## 判断

Browser integrationは成立した。Canvas 2D provisionalとWASM canonicalの二層構成を維持し、次はWorker generationを実装する。

次段階では、10k / 50k / 100k event fixtureのcold replay、main-thread slice、memoryを測定すると同時に、DO chunk RPC、Queue、R2 temporary object、manifest commitを結ぶ。snapshot採否はまだ決定しない。
