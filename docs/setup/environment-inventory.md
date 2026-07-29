# koge 環境値台帳

更新日: 2026-07-29

公開可能な値と設定状況だけを記録する。secretの値、API token、OAuth client secret、session情報はこの文書へ書かない。

## 確定済み

| 項目 | local | preview | production |
| --- | --- | --- | --- |
| app名 | `koge` | `koge` | `koge` |
| app origin | `http://localhost:3000` | `https://preview.koge.app` | `https://koge.app` |
| realtime origin | `http://localhost:8787` | `https://realtime-preview.koge.app` | `https://realtime.koge.app` |
| Web Worker | `koge-web`（local config名） | `koge-web-preview` | `koge-web` |
| Realtime Worker | `koge-realtime`（local config名） | `koge-realtime-preview` | `koge-realtime` |
| Snapshot Worker | `koge-snapshot`（local config名） | `koge-snapshot-preview` | `koge-snapshot` |
| D1 database | `koge-local` | `koge-preview` | `koge-production` |
| R2 bucket | `koge-runtime-snapshots-local` | `koge-runtime-snapshots-preview` | `koge-runtime-snapshots-production` |
| snapshot Queue | `koge-snapshot-local` | `koge-snapshot-preview` | `koge-snapshot-production` |
| snapshot DLQ | 未使用 | 未使用 | 未使用 |
| cleanup Queue / DLQ | local用 | `koge-room-cleanup-preview` / `-dlq` | `koge-room-cleanup-production` / `-dlq` |
| evidence Queue / DLQ | local用 | `koge-moderation-evidence-preview` / `-dlq` | `koge-moderation-evidence-production` / `-dlq` |
| Cloudflare Workers plan | Paid | Paid | Paid |

`www.koge.app`から`https://koge.app`へのredirectは一般公開前の確認項目とする。

## 非secret値と設定状況

| 優先度 | 値 | 状態 | 取得元 | 最終設定先 |
| --- | --- | --- | --- | --- |
| 1 | Cloudflare account ID | `add7fa1a3932f0d7e81b8c668f42156f`（`wrangler whoami`で確認・設定済み） | `wrangler whoami`またはDashboard | 両Workerの`wrangler.jsonc` |
| 2 | preview D1 database ID | `59b84520-bef3-456e-90ec-37f4e496e851`（設定済み） | `wrangler d1 create`の出力 | 両Workerのpreview環境 |
| 3 | production D1 database ID | `2071beb0-831b-40cf-9c7d-d068496766b3`（Cloudflare照合・設定済み） | `wrangler d1 create` / `d1 list` | Web / Realtime production環境 |
| 4 | Cloudflare zone ID | 今は不要 | Dashboard | CI/APIを使う段階だけ |
| 5 | Google OAuth preview client ID | 設定済み（値はsecret storeだけ） | Google Cloud Console | Web Worker secret |
| 6 | Google OAuth production client ID | 設定済み（値はsecret storeだけ） | Google Cloud Console | Web Worker secret |
| 7 | Cloudflare Access team domain | `https://dolphilia.cloudflareaccess.com` | Zero Trust Dashboard | Web Worker `CF_ACCESS_ISSUER` |
| 8 | preview admin Access AUD tag | `b7536e7cc03d57d8889760015ad850b72f08ae4a838a741054fc02094377c785` | Access applicationのAdditional settings | Web Worker preview `CF_ACCESS_AUD` |
| 9 | production admin Access AUD tag | `ddfcf25a51f780af02c6cff5073c6ba1fd0a6d42fdd9883a0232076cf5bd29ef`（設定済み） | Access applicationのAdditional settings | Web Worker production `CF_ACCESS_AUD` |

preview / productionのR2 bucket、snapshot Queue、cleanup Queue / DLQ、
moderation evidence Queue / DLQは作成済み。R2 bucket名とQueue名以外のIDの転記は
不要。2026-07-29にWranglerのread-only listでproduction資源の存在を照合した。

## preview配備状況

| 項目 | 状態 | 確認内容 |
| --- | --- | --- |
| D1 migration | 適用済み | `0001`〜`0017` |
| Realtime Worker | 配備・確認済み | `/health`と`/health/room/phase0-smoke`が`200` |
| Realtime Custom Domain | 有効 | `https://realtime-preview.koge.app` |
| Web Worker | 配備済み | `koge-web-preview` |
| Web Custom Domain | 有効 | 公開DNS、TLS、HTTP `200`を確認 |
| Snapshot Worker | 配備・確認済み | 共通WASM、snapshot生成、incremental、recovery、compaction canaryを検証 |

## production配備・検証状況

| 項目 | 状態 | 確認内容 |
| --- | --- | --- |
| D1 | 作成・設定済み | 正しいUUIDをCloudflare `d1 list`と照合 |
| R2 | 作成・設定済み | `koge-runtime-snapshots-production`を照合 |
| Queue / DLQ | 作成・設定済み | 必要な5 Queueを照合し、producer / consumer配備済み |
| 3 Worker config | 実装済み | `env.production`、origin、bindingを追加 |
| generated types | 検証済み | 3 Workerのproduction型を生成しcheck成功 |
| production dry-run | 成功 | Web / Realtime / Snapshotの3 Worker |
| D1 migration | 適用済み | `0001`〜`0017`、未適用0 |
| Realtime Worker | 配備済み | version `476b45bf-73b8-4dad-85cd-054acdc3a63f` |
| Snapshot Worker | 配備済み | version `7fb79a67-6c40-4227-a627-3b06d1e7ba07` |
| Web Worker | 配備済み | version `011c5f1d-4d25-4dc5-b7c0-3cf9cdca7cf2` |
| Custom Domain | 有効 | `koge.app` / `realtime.koge.app` |
| 自動smoke | pass | home / session / rooms / Realtime health / Access redirect |
| 利用者E2E | pass | OAuth、room、別browser、描画/cursor/chat/reload、終了、Access |
| 終了後health | pass | D1 room 0、cleanup/evidence Queue・DLQ backlog 0、orphan inventory 0 |
| Worker Analytics | pass | Realtime error 0、Snapshot未起動。Webの2 errorsは`05:32:19Z`の既知の配備時過渡エラー |

## secretの設定状態

値は書かず、設定済みかどうかだけを記録する。

| secret | local | preview | production |
| --- | --- | --- | --- |
| `BETTER_AUTH_SECRET` | 未設定 | 設定済み | 設定済み |
| `GOOGLE_CLIENT_ID` | 未設定 | 設定済み | 設定済み |
| `GOOGLE_CLIENT_SECRET` | 未設定 | 設定済み | 設定済み |
| `CLOUDFLARE_API_TOKEN`（CI） | 対象外 | 未設定 | 未設定 |
| `CLOUDFLARE_ANALYTICS_API_TOKEN`（一時測定） | 未設定 | 未設定 | 対象外 |

## 記録ルール

- account ID、D1 database ID、resource名、originはGit管理してよい。
- secret値はローカルのgit対象外ファイル、Wrangler secret、GitHub Actions secretのいずれかへ直接入力する。
- チャットで実装担当へ共有してよいのは、account ID、D1 database ID、resource名、origin、OAuth client IDまでとする。
- secretを設定した後は、この台帳の状態だけを`設定済み`へ更新する。
