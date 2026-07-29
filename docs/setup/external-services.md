# 外部サービス情報の準備

更新日: 2026-07-29
対象: local / preview / productionの外部サービス設定

previewとproductionのCloudflare resource、Google OAuth、Better Auth、
Cloudflare Accessは設定・配備済み。現在値は`environment-inventory.md`、
productionの実行記録は`production-deployment.md`を正本とする。

## 1. 先に用意する情報

実値をこの文書へ追記せず、以下の「保存場所」へ設定する。

### Cloudflare account

| 情報 | secret | 保存場所 |
| --- | --- | --- |
| Cloudflare account ID | いいえ | `apps/web/wrangler.jsonc`と`apps/realtime/wrangler.jsonc`の`account_id` |
| account名 | いいえ | 運用メモ。configには不要 |
| Cloudflare Workers plan | いいえ | `docs/setup/environment-inventory.md` |
| production domain | いいえ | 両方の`wrangler.jsonc`とDNS |
| preview app origin | いいえ | Web/Realtimeのpreview `vars` |
| production app origin | いいえ | Web/Realtimeのproduction `vars` |
| preview realtime origin | いいえ | Web/Realtimeのpreview `vars` |
| production realtime origin | いいえ | Web/Realtimeのproduction `vars` |
| local developer login | credential | 各開発者が`wrangler login`。repositoryへ保存しない |
| CI API token | はい | GitHub Actions secret `CLOUDFLARE_API_TOKEN` |
| CI account ID | 原則いいえ | GitHub Actions variableまたはsecret `CLOUDFLARE_ACCOUNT_ID` |

CI tokenは必要な環境とresourceだけへ権限を絞る。token文字列を`.env`、Markdown、issue、chatへ貼らない。

WorkerのCPU / memory採用判定には、CI tokenと分離した短命な読取専用tokenを使う。
権限は`Account > Account Analytics > Read`、resourceは対象accountだけに絞る。
値はrepository fileへ保存せず、実行時の
`CLOUDFLARE_ANALYTICS_API_TOKEN`環境変数だけへ入力する。取得後は
`tools/cloudflare-worker-metrics`で測定し、tokenをunsetまたは失効する。

### Cloudflare resources

previewとproductionで別々に用意する。

| Resource | 推奨名 | 記録場所 |
| --- | --- | --- |
| Web Worker | `koge-web-preview` / `koge-web` | Web `wrangler.jsonc` |
| Realtime Worker | `koge-realtime-preview` / `koge-realtime` | Realtime `wrangler.jsonc` |
| D1 | `koge-preview` / `koge-production` | 両方の`d1_databases` |
| R2 runtime snapshot | `koge-runtime-snapshots-preview` / `koge-runtime-snapshots-production` | Realtime `r2_buckets` |
| snapshot Queue | `koge-snapshot-preview` / `koge-snapshot-production` | Realtime `queues.producers` |
| snapshot DLQ | 未使用 | event log fallbackを維持し、consumerはQueue retry後に失敗を記録 |
| cleanup Queue | `koge-room-cleanup-preview` / `koge-room-cleanup-production` | Realtime `queues` |
| cleanup DLQ | `koge-room-cleanup-preview-dlq` / `koge-room-cleanup-production-dlq` | Realtime consumer config |
| Access application | preview / production管理画面用 | Cloudflare Zero Trust。AUDは環境台帳へ記録 |

D1作成後に返る`database_id`はsecretではないためversion管理してよい。R2 bucket名とQueue名も同様である。

Phase 0のremote previewには最低限、Web Worker、Realtime Worker、preview D1、preview R2、preview Queueが必要。snapshotをGate Bで延期しても、bindingとfailure pathを検証するpreview resourceは残せる。

実際の取得・設定順は`initial-cloudflare-setup.md`、非secret値の確定状況は`environment-inventory.md`を正本とする。

## 2. Google OAuth

Phase 0の決定ではGoogle OAuthを1 providerとして使用し、メール認証をMVPに含めない。

Google Cloud ConsoleでWeb application OAuth clientを環境別に作る。少なくともproductionと非productionを分離する。

必要な情報:

- Google Cloud project
- OAuth consent screenのapp名
- support email
- developer contact email
- authorized domain
- privacy policy URL
- terms URL
- homepage URL
- OAuth client ID
- OAuth client secret
- authorized JavaScript origins
- authorized redirect URIs

redirect URI候補:

```text
http://localhost:3000/api/auth/callback/google
https://preview.koge.app/api/auth/callback/google
https://koge.app/api/auth/callback/google
```

scheme、host、path、末尾slashは完全一致が必要。production値はPhase 4でBetter Auth handlerを動かして確認してから登録する。

保存場所:

| 値 | local | preview / production |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | `apps/web/.env.local` | Web Worker secret |
| `GOOGLE_CLIENT_SECRET` | `apps/web/.env.local` | Web Worker secret |

client secret JSONをrepository内へ置かない。

## 3. Better Auth

Better Authは外部SaaS accountやAPI keyを必要としない。libraryとしてWorker内で動かし、D1へ保存する。

利用者側で必要なのは環境ごとのsecretとURLである。

| 値 | 説明 | 保存場所 |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | 32文字以上の高entropy。環境ごとに別 | localは`apps/web/.env.local`、remoteはWeb Worker secret |
| `BETTER_AUTH_URL` | applicationの固定origin | `apps/web/wrangler.jsonc`の環境別`vars` |
| `BETTER_AUTH_TRUSTED_ORIGINS` | 許可originの明示list | 同上 |

secret生成例:

```sh
openssl rand -base64 32
```

生成結果をterminal history、issue、Markdownへ転記しない。rotationを導入するときはBetter Authのversioned secretsを使用し、旧keyを即時削除しない。

Better Auth `1.6.25`から正確なD1 migrationを生成・reviewし、
`migrations/d1/0002_better_auth.sql`としてlocal / preview / productionへ適用済み。

## 4. Room ticket

Better Auth secretをWebSocket room ticketへ流用しない。
Phase 5で256-bit opaque one-time token方式を採用した。生tokenはブラウザへ
1回だけ返し、room DOにはSHA-256とclaimsを保存するため、署名用の
`ROOM_TICKET_SECRET`は取得・設定しない。

## 5. Local fileの作り方

```sh
cp apps/web/.env.example apps/web/.env.local
```

コピー後のファイルは`.gitignore`対象。値を埋めたファイルをcommitしない。

## 6. Remote secretの設定先

実resourceとenvironment configを追加した後、各環境へ対話的に登録する。

```sh
npm exec wrangler -- secret put BETTER_AUTH_SECRET --config apps/web/wrangler.jsonc --env preview
npm exec wrangler -- secret put GOOGLE_CLIENT_ID --config apps/web/wrangler.jsonc --env preview
npm exec wrangler -- secret put GOOGLE_CLIENT_SECRET --config apps/web/wrangler.jsonc --env preview
```

productionでは`--env production`へ変える。secretをcommand argumentや`echo`で渡さず、Wranglerの対話promptへ入力する。

## 7. 利用者から共有してもらう値

次の非secret値は、実装担当がconfigへ反映するため共有してよい。

1. Cloudflare account ID
2. preview / productionのapp origin
3. preview / productionのrealtime origin
4. D1 database名とID
5. R2 bucket名
6. Queue / DLQ名
7. Google OAuth client ID
8. Google consent screenで使用するapp名とsupport contact

共有しない値:

- Cloudflare API token
- Google OAuth client secret
- Better Auth secret
- Room ticket secret
- login cookieやsession token

secretは利用者自身がCloudflareまたはGitHubのsecret storeへ入力する。

## 8. Phase 0 remote完了チェック

- `wrangler whoami`で対象accountを確認した。
- preview/prod resource名が衝突していない。
- preview D1 migrationを適用した。
- Web/Realtimeをpreviewへdeployできた。
- Web health pageとRealtime `/health`を確認した。
- production dataへlocal/previewから接続できない。
- generated binding typesとconfigが一致している。
- secretがGitのtracked fileとlogへ含まれていない。
