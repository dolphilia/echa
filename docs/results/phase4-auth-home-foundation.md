# Phase 4: auth / unified home foundation

実施日: 2026-07-28
状態: 完了。local / preview auth、Google OAuth、public room作成、
ownership復元E2E pass

## 採用version

- Better Auth: `1.6.25`（stable固定）
- 1.7 RCは採用しない
- database: Cloudflare D1 native binding
- framework route: vinext App Router `/api/auth/:all+`

## 実装

- requestごとにCloudflare `env`からauth instanceを作る。
- Google OAuth 1 providerだけを有効にする。
- email/passwordを無効にする。
- Better Authの即時user deletion endpointを無効にする。
  account削除はADR 0004のcleanup job経路で後続実装する。
- userへ`active | suspended | deleting`状態を追加する。
- cookieをHttpOnly / SameSite=Laxとし、previewではSecureを強制する。
- `BETTER_AUTH_URL`をtrusted originsへ必須包含させる。
- 32文字未満のsecret、空provider credential、不正origin設定は起動時に拒否する。
- auth rate limitをD1に保存する。
- secretは`wrangler.jsonc`の`secrets.required`に名前だけを宣言し、
  generated `Env`へ反映する。

## Migration

| migration | local | preview |
| --- | --- | --- |
| `0001_phase0_metadata.sql` | applied | applied |
| `0002_better_auth.sql` | applied | applied |
| `0003_room_projection.sql` | applied | applied |
| `0004_room_provisioning.sql` | applied | applied |

Better Auth schemaは採用versionの`getMigrations(...).compileMigrations()`から生成し、
user / session / account / verification / rateLimitの5 tableと3 indexをreviewした。

`0003`ではuser lifecycle statusと公開room一覧projectionを追加した。終了処理中、
suspended、unlisted、DO未準備のroomは公開listへ返さない。

## Unified home

- `/`: session状態と公開room一覧を共有する統合ホーム
- `/rooms`: `/`へredirect
- `/rooms/:slug`: 既存の描画画面
- `/api/rooms`: public + ready + waiting/active/idleだけを返す
- 非ログイン時も一覧を取得できる
- Google loginを同一origin auth routeへ接続
- ログイン済みuserのroom作成buttonを有効化
- D1 `pending -> ready`とDO初期化をprivate Service Bindingで接続
- 同じ入力の再試行を冪等にし、DO失敗時はD1へ`failed`を記録
- session user IDから開催中の所有roomを復元

## 検証

- Web Workers Vitest: 3 files / 16 tests pass
- Web TypeScript: pass
- Web Oxlint: pass
- vinext production build: pass
- routes:
  - `/api/auth/:all+`: API
  - `/api/rooms`: API
  - `/rooms/:slug`: dynamic
- `npm audit --omit=dev`: 0 vulnerabilities
- local / preview D1 migration: pass
- preview Worker secret名3件: 登録確認（値は取得・記録していない）
- preview未ログインsession: `200`、body `null`
- Google OAuth開始: `200`、Google認可URL生成
- Google redirect URI:
  `https://preview.koge.app/api/auth/callback/google`
- Google認可画面: `accounts.google.com`のsign-in画面へ到達し、
  `invalid_client` / `redirect_uri_mismatch`なし
- 利用者対話E2E: login、callback、session、logout、session revoke、
  再loginがすべてpass
- preview D1集計: active user 1、Google account 1、active session 1
  （個人情報・credential・tokenは未取得）
- preview deployment:
  `c8bc4f22-1189-4f34-8814-357a1fa259e7`

vinextはホームの`headers()`利用をstatic analysisで`Unknown`と表示するが、
auth routeとrooms APIはAPI routeとして分類できている。vinextの暫定採用は維持し、
preview OAuth callbackまで確認して最終判断する。

## 次の実装

1. Phase 5でpublic slug / invite tokenから短命room ticketを発行する。
2. unlisted roomとfragment tokenの1回限り交換を実装する。

room provisioningの詳細と検証結果は
[`phase4-room-provisioning.md`](phase4-room-provisioning.md)を参照。

## 利用者設定

preview Web Workerへ次の3 secretを2026-07-28に登録済み。

- `BETTER_AUTH_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

Google OAuth clientには次を登録する。

- JavaScript origin: `http://localhost:3000`
- JavaScript origin: `https://preview.koge.app`
- redirect URI: `http://localhost:3000/api/auth/callback/google`
- redirect URI: `https://preview.koge.app/api/auth/callback/google`

secret値はrepositoryやこの文書へ記録しない。
