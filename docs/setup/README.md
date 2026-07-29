# Setup

更新日: 2026-07-29

- [`external-services.md`](./external-services.md) — 利用者側で用意するCloudflare、Google OAuth、Better Auth、domain、CI情報
- [`cloudflare-access-admin.md`](./cloudflare-access-admin.md) — 管理画面を公開する前に必要なCloudflare Access設定
- [`environment-inventory.md`](./environment-inventory.md) — local / preview / productionの非secret値と検証状態
- [`initial-cloudflare-setup.md`](./initial-cloudflare-setup.md) — 完了済みのPhase 0初期構築記録
- [`production-deployment.md`](./production-deployment.md) — productionの配備範囲判定、D1 migration、3 Worker協調配備、smoke、rollbackの実行順

secretはこのディレクトリへ記録しない。文書にはsecretの名前と保存場所だけを残す。
production初回配備と直近のroom provisioning障害・復旧結果は
[`../results/production-initial-deployment-2026-07-29.md`](../results/production-initial-deployment-2026-07-29.md)
および
[`../results/production-room-provisioning-incident-2026-07-29.md`](../results/production-room-provisioning-incident-2026-07-29.md)
を参照する。
