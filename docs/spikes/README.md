# 実装前spike実行票

更新日: 2026-07-27

現時点では本番アプリのpackage、wrangler設定、Cloudflare resourceがないため、spike本体ではなく「開始条件・最小実装・測定・終了条件」を定義する。

## 優先順

1. `two-client-sync.md`
2. `snapshot-vertical-slice.md`
3. `websocket-hibernation.md`
4. `room-close-cleanup.md`
5. `auth-d1.md`

snapshotはMVP必須ではないが優先トラック。2 clientでstroke schemaとDO永続化が成立したら、認証UIより前でもsnapshot vertical sliceへ進められる。

## 共通ルール

- spike用コードも本番候補schemaとfixtureを使う。
- 成功だけでなく、失敗時のfallbackを試す。
- 結果はcommit SHA、環境、raw metrics、判断を残す。
- Cloudflare API・limit・compatibility dateは実施日に公式docsを再確認する。
- resource作成やdeployはspike計画の承認後に行う。

