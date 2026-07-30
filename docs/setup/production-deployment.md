# koge production配備runbook

更新日: 2026-07-30

## 目的

productionの初回配備と継続配備を、D1、Realtime、Snapshot、Webの依存順に実施する。
preview資源をproductionへ流用せず、各段階に停止点を設ける。

このrunbookは実行順の正本である。secret値、OAuth client secret、cookie、Access JWTは
記録しない。

## 現在の状態

- production D1、R2、5 Queueは作成済み
- 3 Workerの`env.production`とgenerated typesは追加済み
- 3 Workerのproduction dry-runは成功
- production Access AUDは設定済み
- production D1へ`0001`〜`0020`を適用済み、未適用0
- production Better Auth / Google OAuth secretsは設定済み
- Realtime、Snapshot、Webの初回配備とCustom Domain公開は完了
- 自動smokeと利用者によるOAuth / room / 管理操作E2Eはpass
- 終了後のD1 projectionとcleanup / evidence Queue / DLQ healthは正常
- 初回配備時間窓のRealtime Analyticsはpass、Snapshotは未起動で想定内
- Web AnalyticsはCPU / memory pass、`05:32:19Z`の2 errorsは既知の配備時過渡エラー
- 2026-07-29のroom provisioning不整合を復旧し、実roomの作成・入室・描画を再確認
- 1000 x 1000 canvas / room thumbnailの`0020`と専用R2 bindingは実装済み
- preview / productionのthumbnail R2 resourceは作成済み
- previewは`0020`適用と3 Worker協調配備、機能・負荷検証まで完了
- Preview Snapshot Worker AnalyticsはP999 memory 54.9 MiB、headroom 57.1%、
  errors 0でresource gateをpass
- productionの`0020`は適用済み、未適用migration 0、nullableなthumbnail列3本を確認
- production 3 Worker協調配備は2026-07-30に完了
- production 3 Workerの現行sourceによるdry-runは成功
- productionは未適用migration 0。協調配備中はroom作成だけを停止し、配備後に再開
- productionの現行Web / Realtime health、公開API、UI・API両方のAccess gateは正常
- production実room smoke、実Safari、public / unlisted、終了cleanupを確認済み
- 配備後Analyticsは3 Workerともerrors 0、30% memory headroom基準をpass

## 配備範囲gate

Web単独配備を選べるのは、変更が`apps/web`内のUIまたはWeb APIに閉じ、次のどれにも
触れていない場合だけである。

- `migrations/d1`
- `apps/realtime`、`apps/snapshot`
- `packages/protocol`、`packages/renderer-core`
- Service Binding、Queue、R2、D1、Durable Objectの設定
- room provisioning、ticket、WebSocket、snapshotのrequest / response

該当する、または判断できない場合はStep 1〜5をすべて実施する。
`packages/protocol`を変更した配備をWeb単独で行わない。

共有payloadの変更はconsumerを旧・新形式の両方に対応させて先に配備し、producerを
後から切り替えるexpand / contractを基本とする。必須fieldを削除しながらprotocol
versionを据え置き、producerだけを先に配備してはならない。後方互換にできない場合は
protocol versionを上げる。

## 設定済みの利用者入力

production専用の次の3 secretを、Web Workerのsecret storeへ入力する。
2026-07-29に登録とGoogle OAuth利用者E2Eを完了した。以下は再構築・rotation時の
手順として保持する。

- `BETTER_AUTH_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

値をshell history、Markdown、issue、chatへ貼らない。`env.production`は追加済みなので、
次の対話commandを利用できる。

```sh
npm exec wrangler -- secret put BETTER_AUTH_SECRET \
  --config apps/web/wrangler.jsonc --env production
npm exec wrangler -- secret put GOOGLE_CLIENT_ID \
  --config apps/web/wrangler.jsonc --env production
npm exec wrangler -- secret put GOOGLE_CLIENT_SECRET \
  --config apps/web/wrangler.jsonc --env production
```

production Google OAuth clientには次だけを登録する。

```text
Authorized JavaScript origin:
https://koge.app

Authorized redirect URI:
https://koge.app/api/auth/callback/google
```

## 配備前gate

1. 配備元commitを確定し、`git status --short`に意図しない変更がない。
2. `git diff --check`が成功する。
3. generated Cloudflare typesが最新である。
4. rootのlint、typecheck、test、buildが成功する。
5. `wrangler whoami`のaccount IDが台帳と一致する。
6. production D1 UUIDを`d1 list`と照合する。
7. runtime snapshot / thumbnail / evidenceのR2と5 Queueが存在する。
8. Web Workerの3 secretがproductionへ設定済みである。
9. `koge.app`と`realtime.koge.app`に競合DNS recordがない。
10. emergency modeが通常運用の3項目許可状態である。
11. 3 Workerの配備前active versionを記録する。

いずれかが不明ならmigration / deployを開始しない。

```sh
npm exec wrangler -- deployments status \
  --config apps/realtime/wrangler.jsonc --env production
npm exec wrangler -- deployments status \
  --config apps/snapshot/wrangler.jsonc --env production
npm exec wrangler -- deployments status \
  --config apps/web/wrangler.jsonc --env production
```

## Step 1: D1 migration

1000 x 1000 / thumbnail配備では、migrationより先にprivate R2 bucketを作成する。

```sh
npm exec wrangler -- r2 bucket create koge-room-thumbnails-preview
npm exec wrangler -- r2 bucket create koge-room-thumbnails-production
```

既に存在する場合は再作成せず、`r2 bucket list`で名前とaccountを照合する。bucketを
public accessへ接続しない。Web Workerは同一origin endpointからbinding経由で読む。

まず未適用migrationとdatabase UUIDを読み取る。出力がpreview databaseを示した場合は
直ちに停止する。

```sh
npm exec wrangler -- d1 migrations list koge-production --remote \
  --config apps/realtime/wrangler.jsonc --env production

npm exec wrangler -- d1 migrations apply koge-production --remote \
  --config apps/realtime/wrangler.jsonc --env production

npm exec wrangler -- d1 migrations list koge-production --remote \
  --config apps/realtime/wrangler.jsonc --env production
```

適用後は未適用0件と、追加・変更したtable、column、indexをread-onlyで確認する。
migrationは後戻りさせず、旧codeが追加schemaを無視できる前方向互換にする。

`0020_room_thumbnails.sql`では次を確認する。

```sh
npm exec wrangler -- d1 execute koge-production --remote \
  --config apps/realtime/wrangler.jsonc --env production \
  --command "SELECT name FROM pragma_table_info('rooms') WHERE name LIKE 'thumbnail_%' ORDER BY name"
```

## Step 1.5: 新規room作成を停止する

`https://koge.app/admin/rooms`へCloudflare Access認証で入り、「サービス緊急制御」で
room作成だけを停止する。
新規入室と描画は、開催中roomがある場合に終了を妨げないよう有効のままにする。
管理APIを迂回するD1直接更新は監査記録が欠けるため使わない。

反映後はread-only queryで確認する。

```sh
npm exec wrangler -- d1 execute koge-production --remote \
  --config apps/realtime/wrangler.jsonc --env production \
  --command "SELECT revision, room_creation_enabled, room_entry_enabled, drawing_enabled FROM service_controls WHERE singleton = 1"

npm exec wrangler -- d1 execute koge-production --remote \
  --config apps/realtime/wrangler.jsonc --env production \
  --command "SELECT status, COUNT(*) AS count FROM rooms GROUP BY status ORDER BY status"
```

`room_creation_enabled = 0`、他2項目が`1`であることを確認する。開催中roomがある場合は
host終了または自然終了とcleanupを待ち、room projectionが0になるまで協調配備を
開始しない。

## Step 2: Realtime Worker

Realtimeをdry-runしてから配備する。DO class、Queue producer / consumer、R2、D1、
cron、Service Binding entrypointの変更をここで先行反映する。

```sh
npm run dry-run:production --workspace @koge/realtime
npm run deploy:production --workspace @koge/realtime
npm exec wrangler -- deployments status \
  --config apps/realtime/wrangler.jsonc --env production
```

確認:

```text
https://realtime.koge.app/health
```

HTTP 200、environment `production`、必要なbindingがすべてtrueであることを確認するまで
次へ進まない。ただし、このhealthだけではService Binding payloadの互換性を証明しない。

## Step 3: Snapshot Worker

Snapshot Workerはproduction Realtime WorkerのDO classを参照するため、Realtimeの後に
配備する。

```sh
npm run dry-run:production --workspace @koge/snapshot
npm run deploy:production --workspace @koge/snapshot
npm exec wrangler -- deployments status \
  --config apps/snapshot/wrangler.jsonc --env production
```

`koge-snapshot-production` Queueにconsumerが1件接続されたことを確認する。

## Step 4: Web Worker

Realtime health、production secrets、Google redirect URIを再確認してから配備する。

```sh
npm run dry-run:production --workspace @koge/web
npm run deploy:production --workspace @koge/web
npm exec wrangler -- deployments status \
  --config apps/web/wrangler.jsonc --env production
```

Vinext adapter経由でbuildとproduction environment選択を一体で実行する。
生成済み`dist/server/wrangler.json`へ別commandで直接deployしない。

## Step 5: production smoke

最初はOAuthをTestingにし、許可したtest userだけで確認する。

1. `https://koge.app`がHTTP 200。
2. Google login、callback、session、logout、再login。
3. ログインユーザーで公開roomを1件作成し、自動開始を確認。
4. 作成直後にD1の`provisioning_status = 'ready'`を確認。
5. 別browserでparticipant / viewerとして入室。
6. 描画、cursor、chat、reload / 短い切断復帰。
7. Web配備後に新しい`REALTIME_INIT_FAILED`が0件であることを確認。
8. snapshot + tail復帰。
9. host終了、一覧除外、再入室拒否、D1 / R2 cleanup。
10. 描画のあるpublic roomで通常snapshotまたは5分one-shot後に正方形thumbnailを確認。
11. unlisted roomにthumbnail URLが作られず、終了後にthumbnail R2 objectが残らない。
12. `koge.app/admin/*`と`/api/admin/*`がAccessなしでは拒否される。
13. Access認証後に管理停止、復旧、監査記録。
14. Queue / DLQ、Worker errors、CPU / memoryを確認。
15. `https://koge.app/admin/rooms`でroom作成を再開し、D1で3項目が`1`、
    `service_control_actions`に停止・再開の監査記録があることを確認。

試験roomはhost終了し、cleanup完了まで確認する。

Access gateでは、`/admin/rooms`だけでなく`/api/admin/emergency`への未認証requestも
Access loginへ302されることを確認する。APIがWorkerまで届いてJSON 403を返す場合は、
Access applicationに`koge.app/api/admin/*`が含まれていない。同じproduction
applicationへ2つ目のPublic hostnameとして追加し、別AUDのapplicationを新設しない。

healthが正常でも実room作成に失敗した場合は完了としない。新しい配備を重ねず、
room作成を停止し、D1の`provisioning_error_code`、Web / Realtime logs、
Service Bindingのproducer / consumer payload、配備version差を確認する。

配備後のprovisioning状態はread-onlyで確認する。

```sh
npm exec wrangler -- d1 execute koge-production --remote \
  --config apps/realtime/wrangler.jsonc --env production \
  --command "SELECT provisioning_status, provisioning_error_code, COUNT(*) AS count FROM rooms GROUP BY provisioning_status, provisioning_error_code"
```

## Rollback

### Web / Snapshot

Cloudflare Worker version rollbackで直前の正常versionへ戻す。新しいmigrationへ依存する
codeを戻す場合も、D1 migration fileを逆実行しない。追加column / tableは残し、
旧codeが読まない前方向互換にする。

### Realtime Durable Object

DO migration tagを削除・再利用しない。重大障害時は次の順で影響を限定する。

1. emergency modeでroom作成を停止。
2. 必要に応じて新規入室、描画を停止。
3. Realtime Workerを直前の正常versionへrollback。
4. Queue / DLQとcleanup fenceを確認。
5. 安全確認後に受付を段階的に戻す。

D1を空に戻す、R2 bucketを削除する、Queueをpurgeする操作はrollbackとして行わない。

## 完了条件

- 3 Workerがproduction環境とproduction資源だけを参照する。
- OAuth / Accessを含むproduction smokeがpassする。
- snapshot / event / cleanupの不一致が0。
- Worker errorsとDLQが0。
- rollback対象versionと停止手順が記録されている。
- 一般公開まではOAuth test userとAccess管理者だけで限定運用する。

## 2026-07-30 現在の配備結果

正しいD1 UUIDは
`2071beb0-831b-40cf-9c7d-d068496766b3`。利用者から最初に共有された値は末尾の`3`が
欠けていたが、migration前のCloudflare `d1 list`照合で検出・修正した。

| 対象 | version / 結果 |
| --- | --- |
| D1 | `0001`〜`0020`成功、未適用0 |
| Realtime | `5ffcaa7d-822f-4fbc-8701-4495b7d40603` |
| Snapshot | `c92f426b-1aed-4733-9ae9-ffe92a3b57e7` |
| Web | `b9b356af-ee42-410e-b445-2c7dfee72ed1` |

初回配備後、D1の`service_controls`はroom作成・新規入室・描画がすべて`1`であることを
APAC / NRT primaryのread-only queryで確認した。1000 x 1000 canvas / room thumbnail
協調配備中はroom作成だけを`0`へ変更し、他2項目は`1`を維持した。productionの
snapshot Queueはproducer 2 / consumer 1、cleanupとmoderation evidenceの主要Queueは
producer 1 / consumer 1、DLQはproducer 1 / consumer 0。

1000 x 1000 canvas / room thumbnailの協調配備では、Access保護された管理APIから
room作成だけを停止し、room 0件を確認してから、D1 `0020` → Realtime → Snapshot →
Webの順に反映した。
配備直後の機械的smokeではhome、session、rooms、Realtime healthがHTTP 200で、
`/admin/rooms`と`/api/admin/emergency`はいずれも同じAccess applicationへ302した。
配備直後の自動smoke通過後にroom作成を再開した。D1はrevision 2で3制御がすべて`1`、
`service_control_actions`には停止・再開の監査記録が2件ある。

Custom Domainの初回伝播直後、Realtime healthにCloudflare 1104、Web home / sessionに
一時500が各1回出た。どちらも再試行後に収束し、Worker例外は再現しなかった。
安定確認では次がpassした。

- `https://koge.app/`: 3回連続HTTP 200、HTML title `koge`
- `/api/auth/get-session`: HTTP 200、未ログイン`null`
- `/api/rooms`: HTTP 200、空配列
- `https://realtime.koge.app/health`: HTTP 200、production、全binding true
- `/admin/rooms`: Access loginへHTTP 302

これは機械的smokeの完了時点の記録である。その後、OAuth test userによる
loginからcleanupまでと、Access管理操作の利用者E2Eを実施した。

同日の利用者E2EでOAuth、room作成、別browser入室、描画/cursor/chat/reload、
host終了、Access管理画面の6項目をpassした。終了後はD1 room 0、cleanup /
evidence main QueueとDLQ backlog 0、stuck projection 0、orphan inventory 0を
read-only確認した。Realtime Worker Analyticsはerror 0、memory headroomをpassし、
Snapshotは今回未起動だった。Webの2 errorsは`05:32:19Z`の同一sampleに限られ、
初回Custom Domain伝播直後のhome / session一時500と時刻・件数が一致する。
`05:33Z`以降はsuccessで再現せず、CPU / memoryも基準内のため、
初回Worker Analytics gateをpassとする。

## 2026-07-29 room provisioning障害と復旧

新しいWebはroom provisioning payloadから`theme`を削除していたが、旧Realtimeは
同じprotocol versionのまま`theme: string | null`を必須としていた。Webだけが先に
配備されたため、Realtime healthは正常でもService Bindingがrequestを400で拒否し、
7件のroomが`REALTIME_INIT_FAILED`になった。

復旧はproduction D1 migration `0018`、`0019` → Realtime → Snapshot → Webの順で行い、
各version、Realtime health、Queue binding、実roomの作成・入室・描画を確認した。
利用者確認後、障害中の7件はID、status、error codeを固定して削除した。削除前の関連
invite、membership、BAN、report、evidence、moderation actionはすべて0件で、削除後は
対象残存0、`REALTIME_INIT_FAILED`残存0、正常なready room 1件を確認した。

詳細は
[`../results/production-room-provisioning-incident-2026-07-29.md`](../results/production-room-provisioning-incident-2026-07-29.md)
と
[`../decisions/0011-coordinated-production-deployment.md`](../decisions/0011-coordinated-production-deployment.md)
を参照する。
