# koge production配備runbook

更新日: 2026-07-29

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
- production D1へ`0001`〜`0019`を適用済み、未適用0
- production Better Auth / Google OAuth secretsは設定済み
- Realtime、Snapshot、Webの初回配備とCustom Domain公開は完了
- 自動smokeと利用者によるOAuth / room / 管理操作E2Eはpass
- 終了後のD1 projectionとcleanup / evidence Queue / DLQ healthは正常
- 初回配備時間窓のRealtime Analyticsはpass、Snapshotは未起動で想定内
- Web AnalyticsはCPU / memory pass、`05:32:19Z`の2 errorsは既知の配備時過渡エラー
- 2026-07-29のroom provisioning不整合を復旧し、実roomの作成・入室・描画を再確認

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
7. R2と5 Queueが存在する。
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
10. `koge.app/admin/*`と`/api/admin/*`がAccessなしでは拒否される。
11. Access認証後に管理停止、復旧、監査記録。
12. Queue / DLQ、Worker errors、CPU / memoryを確認。

試験roomはhost終了し、cleanup完了まで確認する。

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

## 2026-07-29 現在の配備結果

正しいD1 UUIDは
`2071beb0-831b-40cf-9c7d-d068496766b3`。利用者から最初に共有された値は末尾の`3`が
欠けていたが、migration前のCloudflare `d1 list`照合で検出・修正した。

| 対象 | version / 結果 |
| --- | --- |
| D1 | `0001`〜`0019`成功、未適用0 |
| Realtime | `75f49cef-cd8b-4114-b5f1-7bbb14335693` |
| Snapshot | `00da91cf-5665-416f-b9df-3da5c0ef6868` |
| Web | `0eb82710-790d-4bcf-92b4-5c5a3a5e1c0f` |

D1の`service_controls`はroom作成・新規入室・描画がすべて`1`。APAC / NRT primaryの
read-only queryで確認した。productionのsnapshot、cleanup、moderation evidence
Queueは主要Queueがproducer 1 / consumer 1、DLQがproducer 1 / consumer 0。

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
