# Spike: Common WASM renderer and snapshot vertical slice

## Priority

MVP blockerではないが、2 client sync直後の優先トラック。rendererだけで止めず、snapshot + tail recoveryまで通す。

## Goal

同じrenderer coreをBrowser / Workersで動かし、DO event logからlossless snapshotを生成してR2へ保存し、clientがsnapshot + tailで復帰できるか判断する。

## Stages

状態: 2026-07-28完了。Stage A-E、preview CPU/memory/live性能、
70,020-event compaction canaryが成立し、Gate Bをpass。snapshot-firstを採用。

### A. Renderer

- Rust renderer core
- 960 x 640、白背景、sRGB
- brush / eraser / opacity / dot / cancel
- fixed-point coordinate and compositing rules
- Browser / Workers WASM build
- `tools/renderer-fixtures/v1/`でRGBA hash比較

### B. Browser integration

- Canvas 2D provisional
- stroke end時にBrowser WASM canonical resultへ置換
- Browser WASM event-log cold replay
- 入力latencyと置換時の視覚差を測定

### C. Worker generation

- DO RPCでtarget baseRoomSeqまでevent chunk取得
- Queue messageはjob metadataだけ
- consumerでdecode / rasterize / lossless encode
- temporary R2 keyへPUT
- object byte hash / RGBA hash
- DO manifest commit

結果: [`../results/phase3-snapshot-worker-generation.md`](../results/phase3-snapshot-worker-generation.md)

### D. Recovery

- manifest取得
- private object取得
- hash/version検証
- snapshot適用
- tail replay
- live catch-up

結果: [`../results/phase3-snapshot-client-recovery.md`](../results/phase3-snapshot-client-recovery.md)

### E. Shadow and compaction

- shadowではeventを削除しない
- Browser WASM full replayとsnapshot hash比較
- commit失敗を注入
- pass後だけcompaction
- previous snapshot fallback
- current snapshotを固定sourceとして読み込み、tailだけで次世代を生成

incremental generation結果:
[`../results/phase3-snapshot-incremental-generation.md`](../results/phase3-snapshot-incremental-generation.md)

compaction結果:
[`../results/phase3-snapshot-compaction.md`](../results/phase3-snapshot-compaction.md)

room close競合結果:
[`../results/phase3-room-close-snapshot-fence.md`](../results/phase3-room-close-snapshot-fence.md)

自動化結果:
[`../results/phase3-snapshot-automation.md`](../results/phase3-snapshot-automation.md)

## Failure injection

- duplicate Queue delivery
- consumer crash before/after R2 PUT
- manifest commit timeout
- corrupt object
- unsupported renderer version
- R2 GET timeout
- client decode failure
- room closes during generation

## Adoption gate

判定: 2026-07-28 pass。ADR 0007を参照。

`docs/spec/event-log-recovery.md`の全条件を満たすこと。特に:

- hash 100%一致
- event loss 0
- full replayより明確に速い
- Worker limitへ30%以上の余裕を目標
- broadcastを阻害しない
- cleanupとDLQを運用可能

## Defer

次ならMVPはevent_log_only。

- 外部containerが必須
- canonical一致を得られない
- snapshotが速くない
- compactionの安全性を証明できない
- 主要実装を大きく遅延

compaction済みroomは途中でevent_log_onlyへ戻さない。

## Deliverables

- renderer crate/package
- Browser / Workers builds
- golden RGBA hash
- snapshot Queue consumer
- R2/manifest integration
- recovery E2E
- shadow report
- adopt/defer decision record

## Sources

- https://developers.cloudflare.com/workers/runtime-apis/webassembly/
- https://developers.cloudflare.com/queues/configuration/batching-retries/
- https://developers.cloudflare.com/queues/configuration/dead-letter-queues/
- https://developers.cloudflare.com/r2/
