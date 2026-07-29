# Phase 3 Stage A: common WASM renderer

日付: 2026-07-27  
状態: Stage A成立、Stage B着手可能  
Cloudflare Workers plan: Paid

## 実装

- `packages/renderer-core`: Rust canonical rasterizer
- `apps/snapshot`: Cloudflare Workers上のWASM実行spike
- renderer version: 1
- renderer wire format: `KGR1`
- target: `wasm32-unknown-unknown`
- WASM byte size: 26,197 bytes（Stage B増分session API追加後）
- snapshot Worker upload: 33.66 KiB、gzip 13.91 KiB
- snapshot Worker startup time: 4ms

Cloudflare WorkersはWASM moduleをtop-levelで一度instantiateする。requestごとのcompile / instantiateは行わない。

## Canonical規則

- 960 x 640、白背景、sRGB RGBA
- coordinate / brush sizeはQ24.8 fixed-point
- round cap / round joinのpolyline
- pixel centerを基準に半pixel幅でedge coverageを求める
- stroke内のcoverageは最大値で統合する
- opacityはstroke終了時に1回だけ合成する
- eraserはMVPの白背景へ白を合成する
- cancelled strokeは合成しない

stroke単位のcoverage maskにより、同じ低opacity strokeのsegmentやstampが重なっても、継ぎ目だけが濃くならない。

## Golden artifact

fixture:
[`tools/renderer-fixtures/v1/canonical-strokes.json`](../../tools/renderer-fixtures/v1/canonical-strokes.json)

- renderer version: 1
- fixture: 7 strokes / 34 points
- RGBA bytes: 2,457,600
- RGBA SHA-256: `3a4e5e43f7371312ba0f4512f84a297aeb8e9a7012c67eff4512bc1f302537cb`
- WASM SHA-256: `7bab6445ddb282e655f6d0c3b950b50eb965ea498ae8250c476a0aac4184037b`（Stage B増分session API追加後。描画semanticsとRGBA hashは不変）

## Cross-runtime一致

| Runtime | 結果 | RGBA hash |
| --- | --- | --- |
| Node WebAssembly | 一致 | `3a4e5e…537cb` |
| system Chrome headless | 一致 | `3a4e5e…537cb` |
| local Workers runtime / Vitest | 一致 | `3a4e5e…537cb` |
| Cloudflare remote preview | 一致 | `3a4e5e…537cb` |

snapshot preview Worker version:
`a6c5bf3d-d913-49e9-a4fe-dbbd758aa2dd`

このCloudflare accountでは`workers.dev`公開経路が無効だったため、不要なcustom domainは作らず、Wrangler remote previewからHTTP 200とhash一致を確認した。snapshot consumerは最終的にQueueから起動するため、公開HTTP endpointを前提にしない。

## 初期性能

Node v23.2.0、canonical fixture、warm-up後50回:

| metric | wall time |
| --- | ---: |
| min | 26.54ms |
| p50 | 26.87ms |
| p95 | 27.70ms |
| max | 31.40ms |
| average | 27.04ms |

system Chromeの単回smokeは46.9msだった。端末条件を固定した正式なBrowser benchmarkはStage Bで行う。

remote Workerが返した内部`renderWallMs`は0msだった。Cloudflareへ配備されたWorkerでは、CPU処理の途中にI/Oがなければ`Date.now()`と`performance.now()`が進まないため、この値をCPU時間として扱わない。Worker CPUはCloudflare observability、local workerd profile、Queue consumer invocation metricを組み合わせてStage Cで測る。

## 自動試験

- Rust native:
  - cancelled strokeは白Canvasを変更しない。
  - 同じstroke内の自己重複は1回描画と同じ結果になる。
- Node:
  - buildしたWASMがmanifestのversion / RGBA hashと一致する。
- Chrome:
  - HTTP配信した同じWASM binaryがmanifestのRGBA hashと一致する。
- Workers:
  - Wrangler/Vitest runtimeでNodeと同じRGBA hashになる。
- repository:
  - 全workspaceのlint、型検査、20件超の既存試験、dry-run buildが成功する。

## 判断

同一WASM rendererをBrowserとCloudflare Workersで共有する方式は有力候補として成立した。少なくとも、外部containerやruntime別rendererは現時点では不要。

Stage Bでは次を行う。

- accepted event logをrenderer wireへ変換する。
- BrowserのCanvas 2D provisionalをstroke end時にWASM canonicalへ置換する。
- 置換前後のpixel差と視覚差を測る。
- 実fixtureと10k / 50k / 100k eventsでwall time、memory、main-thread sliceを測る。
- polyline samplingで不足する場合だけ、renderer versionを上げて決定的なcurve flattening規則を追加する。
