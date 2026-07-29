# Spike archive

更新日: 2026-07-29

このディレクトリは実装前に作成した「開始条件・最小実装・測定・終了条件」を
保存するarchiveである。現在はapp、Wrangler config、Cloudflare resource、
production配備が存在する。各spikeの実施結果は`docs/results/`、採用判断は
`docs/decisions/`、現行仕様は`docs/spec/`を正本とする。

## 優先順

1. `two-client-sync.md`
2. `snapshot-vertical-slice.md`
3. `websocket-hibernation.md`
4. `room-close-cleanup.md`
5. `auth-d1.md`

この優先順に沿った検証は完了した。共通WASM rendererとsnapshot-first recoveryは
Gate Bをpassして採用済み。productionのsnapshot modeは安全側の`shadow`で開始している。

## 共通ルール

- spike用コードも本番候補schemaとfixtureを使う。
- 成功だけでなく、失敗時のfallbackを試す。
- 結果はcommit SHA、環境、raw metrics、判断を残す。
- Cloudflare API・limit・compatibility dateは実施日に公式docsを再確認する。
- 新しいresource作成やdeployは、現在のsetup/runbookと変更計画を確認してから行う。
