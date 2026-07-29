# 実装計画

更新日: 2026-07-30

このディレクトリには、設計判断、現行仕様、技術検証を実装順序と完了条件へ
落とし込んだ計画書を置く。

MVP計画はPhase 0〜6、Phase 7の主要性能検証、production初回配備まで進んでいる。
機械的smoke、利用者E2E、終了後health、初回Worker Analyticsはpassした。
現在は規約、retention、alert、backup/restore試験、closed betaを含む
Release Gateを進める段階である。1000 x 1000 canvasと公開roomサムネイルは
独立した計画書で進める。

## 現在の計画

- [`mvp-implementation-plan.md`](./mvp-implementation-plan.md) — お絵描きチャットMVP実装計画
- [`square-canvas-room-thumbnail-plan.md`](./square-canvas-room-thumbnail-plan.md) —
  1000 x 1000キャンバス、snapshot由来サムネイル、開始5分後の初回生成計画
- [`phase-0-execution.md`](./phase-0-execution.md) — Phase 0の決定、基盤、検証結果、残作業

関連:

- [`../decisions/README.md`](../decisions/README.md) — Phase 0以降の判断記録
- [`../setup/external-services.md`](../setup/external-services.md) — 外部サービスの準備と設定場所
- [`../results/production-initial-deployment-2026-07-29.md`](../results/production-initial-deployment-2026-07-29.md) — production初回配備と検証

## 文書の位置づけ

- 設計判断を変更する場合は、先に`docs/notes/drawing-chat-service-design-foundation.md`と該当仕様を更新する。
- 暫定値は、spike・fixture・負荷試験の結果をdecision recordへ残してから変更する。
- 計画のphase完了は、コードの存在ではなく各exit criteriaを満たしたことで判断する。
- CloudflareのAPI、制限、料金、compatibility dateと依存packageの安全性は、実装開始時に公式情報を再確認する。
