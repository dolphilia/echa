# Phase 0 completion

日付: 2026-07-27  
状態: 完了

## Exit criteria

| 条件 | 結果 |
| --- | --- |
| clean checkoutからlocal build/test | CI定義、local `npm run check` / `npm run build`成功 |
| preview Web / Worker health | `https://preview.koge.app`とRealtime healthがHTTP `200` |
| D1/DO/R2/Queueの環境分離 | local / previewを別名・別bindingで設定 |
| secret非混入 | configと台帳には非secret値だけを記録 |
| decision record | room開始、認証、環境、削除、toolingを記録 |

## Remote preview

- Web: `koge-web-preview`
- Realtime: `koge-realtime-preview`
- D1: `koge-preview`
- R2: `koge-runtime-snapshots-preview`
- Queue: `koge-snapshot-preview`
- app origin: `https://preview.koge.app`
- realtime origin: `https://realtime-preview.koge.app`

D1へ`0001_phase0_metadata.sql`を適用し、Realtime `/health`とSQLite-backed Durable Objectの`/health/room/phase0-smoke`を確認した。
