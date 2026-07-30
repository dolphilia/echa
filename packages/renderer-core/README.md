# @koge/renderer-core

BrowserとCloudflare Workersで共有するcanonical rasterizer。

- coordinateとbrush sizeは符号付きQ24.8 fixed-pointへ変換する。
- 白・sRGB・1000 x 1000 RGBAを基準とする。
- round cap / round joinのpolylineを整数演算でrasterizeする。
- edge antialiasはpixel centerから半pixel幅のcoverageで決める。
- 低opacity strokeはstroke内coverageを最大値で統合し、stroke終了時に1回だけ合成する。
- eraserはMVPの白背景へ白を合成する。
- cancelled strokeは描画しない。
- renderer wire formatは`KGR1`、renderer versionは1。

```sh
npm run build:wasm --workspace @koge/renderer-core
npm test --workspace @koge/renderer-core
```

WASM境界は`wasm-bindgen`へ依存せず、事前コンパイルした同一binaryをBrowser / Workersの双方でinstantiateする。
