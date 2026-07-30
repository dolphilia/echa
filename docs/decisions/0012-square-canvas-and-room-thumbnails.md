# 0012: 1000 x 1000 canvasと一時的な公開ルームサムネイルを採用する

更新日: 2026-07-30

状態: 採用、preview検証前

## 背景

従来の論理canvasは960 x 640だったが、制作画面と公開ルームカードを正方形へ統一する
要望がある。ルーム一覧の共通placeholderだけでは、開催中の描画内容を判別できない。
一方、一覧requestごとのevent replayや常時最新化はSnapshot Worker、R2、D1へ不要な
負荷を加える。

## 判断

- 新しく開始するroomの論理canvasを1000 x 1000、不透明な白、sRGBへ固定する。
- drawing event wire schemaは変わらないためprotocol versionは1を維持する。
- canvas互換性境界として`canvasGeneration`を1から2へ上げる。
- WebSocket接続時にgeneration 2を必須とし、旧clientを明示的に拒否する。
- generation 1のsnapshotをgeneration 2へ暗黙変換しない。
- サムネイルはcanonical WASM rendererがsnapshot用に生成したRGBAから512 x 512へ
  一度だけ縮小し、追加のevent replayを行わない。
- Workersで安定して使える決定的なPNG encoderを採用する。WebPは負荷と実装の
  採用条件を満たした場合の将来変更とする。
- サムネイルはpublicかつactive / idleのroomだけに生成し、専用のprivate R2 bucketへ
  保存する。
- 一覧へはD1 projectionのversionだけを返し、同一origin Worker endpointが現在の
  objectだけを配信する。R2 keyとruntime snapshotは公開しない。
- room開始5分後に初回one-shotを評価する。描画がなければpollせず、最初の確定stroke
  まで待つ。
- snapshot commit後のサムネイル失敗は、同じSnapshot Queueへthumbnail retry jobを
  送り、commit済み`.kgs`から画像処理だけを再試行する。
- room終了cleanupとorphan inventoryはruntime snapshotとthumbnailの両bucketを扱う。

## 結果

公開一覧requestはD1 readとR2 image配信だけで完結し、event replayを行わない。
サムネイル障害時も描画とsnapshot recoveryは継続し、UIはplaceholderへ戻せる。

1000 x 1000 RGBAは4,000,000 bytesとなるため、production配備前にpreviewでfull /
incremental snapshot、5分trigger、thumbnail encodeのCPU・memory・wall timeを再測定
する。旧960 x 640 roomが存在する状態で部分配備せず、D1 → Realtime → Snapshot →
Webの協調配備を行う。
