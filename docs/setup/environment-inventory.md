# koge 環境値台帳

更新日: 2026-07-30

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
| thumbnail R2 bucket | `koge-room-thumbnails-local` | `koge-room-thumbnails-preview`（作成済み） | `koge-room-thumbnails-production`（作成済み） |
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
この記録はruntime snapshot bucketを指す。thumbnail専用の2 bucketは
2026-07-30にCloudflare上へ作成し、public accessへ接続していない。

## preview配備状況

1000 x 1000 canvas / room thumbnail変更は2026-07-30に次まで完了した。

- D1 migration `0018`〜`0020`適用、未適用0
- Realtime `b254ae6e-30e9-45b7-a1d9-a3f4a2ad7f59`
- Snapshot `9077fe4c-9fbc-4ba6-ba9e-7e0e22184184`
- Web `7e3e3278-bfc7-40e1-8c2f-a6df1e19c754`
- 専用R2 / D1 / Queue / DO binding接続
- 1000 x 1000 snapshot復元と512 x 512 thumbnail配信

5分one-shot、50,001 / 5,001-event負荷、終了cleanup、Chromium / Firefox /
WebKitの機能検証を完了した。Snapshot Worker AnalyticsはP999 memory 54.9 MiB、
headroom 57.1%、errors 0でPreview gateをpassした。

| 項目 | 状態 | 確認内容 |
| --- | --- | --- |
| D1 migration | 適用済み | `0001`〜`0020`、未適用0 |
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
| D1 migration | 適用済み | `0001`〜`0020`、未適用0。thumbnail列3本を確認 |
| Realtime Worker | cleanup修正版配備済み | version `5ffcaa7d-822f-4fbc-8701-4495b7d40603` |
| Snapshot Worker | 協調配備済み | version `c92f426b-1aed-4733-9ae9-ffe92a3b57e7` |
| Web Worker | 協調配備済み | version `b9b356af-ee42-410e-b445-2c7dfee72ed1` |
| Custom Domain | 有効 | `koge.app` / `realtime.koge.app` |
| 自動smoke | pass | home / session / rooms / Realtime health / UI・API両方のAccess redirect |
| 緊急制御 | 復旧済み | revision 4、room作成・入室・描画がすべて有効 |
| 1000 x 1000 / thumbnail本番E2E | pass | 実Safari、download、同期、復帰、public thumbnail、unlisted拒否、終了cleanupを確認 |
| 利用者E2E | pass | OAuth、room、別browser、描画/cursor/chat/reload、終了、Access。provisioning復旧後のroom作成・入室・描画もpass |
| 終了後health | pass | D1 room 0、cleanup/evidence Queue・DLQ backlog 0、orphan inventory 0 |
| Worker Analytics | pass | 最新smokeは3 Workerともerror 0。P999 memoryはRealtime 2.4 MiB、Snapshot 18.2 MiB、Web 12.9 MiB |

## secretの設定状態

値は書かず、設定済みかどうかだけを記録する。

| secret | local | preview | production |
| --- | --- | --- | --- |
| `BETTER_AUTH_SECRET` | 未設定 | 設定済み | 設定済み |
| `GOOGLE_CLIENT_ID` | 未設定 | 設定済み | 設定済み |
| `GOOGLE_CLIENT_SECRET` | 未設定 | 設定済み | 設定済み |
| `CLOUDFLARE_API_TOKEN`（CI） | 対象外 | 未設定 | 未設定 |
| `CLOUDFLARE_ANALYTICS_API_TOKEN`（一時測定） | 未設定 | 測定完了、shellから解除 | 測定完了（repositoryへ非保存） |

## 記録ルール

- account ID、D1 database ID、resource名、originはGit管理してよい。
- secret値はローカルのgit対象外ファイル、Wrangler secret、GitHub Actions secretのいずれかへ直接入力する。
- チャットで実装担当へ共有してよいのは、account ID、D1 database ID、resource名、origin、OAuth client IDまでとする。
- secretを設定した後は、この台帳の状態だけを`設定済み`へ更新する。
