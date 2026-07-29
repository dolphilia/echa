# koge 初回Cloudflareセットアップ

更新日: 2026-07-29  
状態: 完了済みのPhase 0構築記録  
目的: remote previewをproductionや認証設定と分離して構築した手順を保存する。

現在はpreviewに加えてproductionも配備済みである。新規環境の構築手順として
再利用する場合は、現在値を`environment-inventory.md`、production手順を
`production-deployment.md`で確認する。

## 先に理解しておくこと

この手順を実施した時点では、Cloudflare account IDとpreview用resourceから開始し、
Google OAuth、Better Auth secret、production resource、CI tokenを後段へ分離した。

secretの値はリポジトリ、Markdown、issue、チャットへ貼らない。非secret値は`environment-inventory.md`へ記録する。

## Step 1: `koge.app`のCloudflare zoneを確認する

Cloudflare Dashboardで次を確認する。

- `koge.app`が今回使用するCloudflare accountに追加されている。
- zone statusが`Active`である。
- `preview.koge.app`、`realtime-preview.koge.app`に既存のA、AAAA、CNAME recordがない。

preview WorkerにはCloudflare WorkersのCustom Domainを使う。Custom Domain追加時にCloudflareがDNS recordとcertificateを作成するため、対象hostnameのDNS recordを先に手作業で追加しない。

ここで取得・共有する値はない。

## Step 2: Wranglerで対象accountへログインする

リポジトリrootで実行する。

```sh
node --version
npm install
npm exec wrangler -- login
npm exec wrangler -- whoami
```

Node.jsは22系を使う。`whoami`で、Step 1の`koge.app`を管理しているaccountが選ばれていることを確認する。

### このStepで取得する値

- Cloudflare account ID

account IDはsecretではない。`environment-inventory.md`へ記録し、実装担当へ共有してよい。API tokenやlogin情報は共有しない。

## Step 3: preview用D1を作る

同じaccountで実行する。

```sh
npm exec wrangler -- d1 create koge-preview --location apac
```

作成結果に表示される次の値を記録する。

- database name: `koge-preview`
- database ID: Wranglerが返したUUID

database IDはsecretではない。`environment-inventory.md`へ記録し、実装担当へ共有してよい。このIDが分かれば、両Workerのpreview bindingを正しく設定できる。

## Step 4: preview用R2 bucketとQueueを作る

```sh
npm exec wrangler -- r2 bucket create koge-runtime-snapshots-preview
npm exec wrangler -- queues create koge-snapshot-preview
```

Phase 0ではbindingと失敗経路を検証するために作成した。当時はsnapshot本実装が
後になる場合でも、production resourceをこの段階では作らない方針とした。

このStepでは新しいsecretやUUIDの転記は不要。DashboardまたはWranglerで、指定名のresourceが作成されたことだけを確認し、台帳の状態を更新する。

DLQはsnapshot consumerを実装するPhase 3で作成する。

## Step 5: いったん実装担当へ渡す

状態: 2026-07-27に完了。

ここまで完了したら、次の2値だけを共有する。

```text
Cloudflare account ID:
koge-preview D1 database ID:
```

R2 bucketとQueueについては、作成成功・失敗だけを伝える。実装担当が次を行う。

1. `apps/web/wrangler.jsonc`と`apps/realtime/wrangler.jsonc`へaccount IDを設定する。（完了）
2. `preview`環境、origin、D1 ID、R2、Queue bindingを追加する。（完了）
3. generated binding types、test、buildを検証する。（完了）

この区切りを設けることで、誤ったaccountやdatabase IDのままmigrationを実行する事故を避ける。

## Step 6: preview D1 migrationとWorker配備

状態: 2026-07-27にremote migration、Realtime Worker、Web Workerの配備まで完了。

Step 5のconfig反映とreviewが終わった後に実施する。実行前に対象database名が`koge-preview`であることを再確認する。

```sh
npm exec wrangler -- d1 migrations apply koge-preview --remote --config apps/realtime/wrangler.jsonc --env preview
npm exec wrangler -- deploy --config apps/realtime/wrangler.jsonc --env preview
```

Web Workerは`apps/web`で`npm run deploy:preview`を使う。このコマンドが
Vinext buildと`--env preview`を一体で実行し、既存の`koge-web-preview`と
登録済みSecretを選択する。生成後の`dist/server/wrangler.json`へ直接
`wrangler deploy --env preview`を実行すると、redirected configのtop-level
Workerを対象にするため使用しない。現時点でproductionへdeployしない。

## Step 7: preview Custom Domainsを追加する

状態: 2026-07-27に両Custom Domainの公開DNS、TLS、HTTP応答を確認済み。

Workerの配備確認後、次をCustom Domainとして割り当てる。

| Worker | Custom Domain |
| --- | --- |
| `koge-web-preview` | `preview.koge.app` |
| `koge-realtime-preview` | `realtime-preview.koge.app` |

Dashboardから追加するか、review済みの`wrangler.jsonc`へ`custom_domain: true`のrouteを設定する。既存DNS recordとの競合がないことを確認する。

確認項目:

- `https://preview.koge.app`へHTTPSで到達できる。
- `https://realtime-preview.koge.app/health`が`200`を返す。
- certificateが有効である。
- 当時はproductionの`koge.app`、`realtime.koge.app`へまだ割り当てていなかった。

## Step 8: 認証情報はPhase 4で設定する

preview originが実際に到達可能になってから、次の順で設定する。

1. local、preview、productionごとに別の`BETTER_AUTH_SECRET`を生成する。
2. Google Cloud projectの表示名を`koge`にする。
3. 非production用OAuth clientにlocalとpreviewのorigin/redirect URIを登録する。
4. production用OAuth clientは別に作り、`koge.app`だけを登録する。
5. secret値はWranglerの対話promptへ直接入力する。

preview用redirect URI:

```text
http://localhost:3000/api/auth/callback/google
https://preview.koge.app/api/auth/callback/google
```

production用redirect URI:

```text
https://koge.app/api/auth/callback/google
```

redirect URIはscheme、host、path、末尾slashまで完全一致させる。

## Step 9: productionとCI（当時の後続作業）

次のproduction項目はPhase 0完了後へ延期し、2026-07-29に作成・配備を完了した。
CI API tokenと自動deployは引き続き未設定である。

- `koge-production` D1
- `koge-runtime-snapshots-production` R2 bucket
- `koge-snapshot-production` Queue
- `koge.app`と`realtime.koge.app`のCustom Domain
- production用Better Auth / Google OAuth secret
- GitHub Actions用の最小権限Cloudflare API token
- `www.koge.app`から`https://koge.app`へのredirect

previewでmigration、WebSocket、認証、rollback手順を確認した後にproductionを作成した。

## 最初の作業の完了条件

- `koge.app`のzoneが正しいaccountでActiveになっている。
- Wranglerで正しいaccountへログインできた。
- account IDを取得した。
- `koge-preview` D1とdatabase IDを取得した。
- preview R2 bucketとQueueを作成した。
- secretをGit管理ファイルやチャットへ貼っていない。

この時点で一度停止し、config反映へ進む。

## 公式リファレンス

- [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/)
- [D1: Get started](https://developers.cloudflare.com/d1/get-started/)
- [R2: Create buckets](https://developers.cloudflare.com/r2/buckets/create-buckets/)
- [Queues: Get started](https://developers.cloudflare.com/queues/get-started/)
- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Google OAuth 2.0 for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Better Auth installation](https://www.better-auth.com/docs/installation)
