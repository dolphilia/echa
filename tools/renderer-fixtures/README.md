# Renderer fixtures

共通WASM renderer、Browser fallback、snapshot生成の結果を同じ入力で比較するためのfixtureです。

## v1

`v1/canonical-strokes.json`は既存の`echa.raw-strokes.v1`形式を使い、次を含みます。

- 単点
- 通常brush
- 低濃度brush
- 高速stroke
- eraser
- canvas端のclip
- cancel

strokeは配列順に適用します。背景は1000 x 1000の不透明な白、色空間はsRGBです。cancelled strokeは最終RGBAへ影響してはいけません。

## Golden hash

現時点ではcanonical WASM rendererが未実装なので、期待RGBA hashを固定していません。renderer初回実装時に次を行います。

1. renderer versionを決める。
2. Browser / WorkersでRGBA byte列が一致することを確認する。
3. `v1/manifest.json`の`rgbaHash`とsnapshot object hashを埋める。
4. hash変更を伴うrenderer変更ではversionとfixture世代を上げる。

Canvas 2Dの見た目だけをgoldenの正としません。

## Validation

```sh
npm --prefix tools/renderer-fixtures test
```

この検証はfixtureのschemaとcase IDを確認します。画像hash検証はWASM renderer spikeで追加します。
