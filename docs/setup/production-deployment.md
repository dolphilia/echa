# koge production初回配備

更新日: 2026-07-29

## 目的

空のproduction D1へmigrationを適用し、Realtime、Snapshot、Webの順に配備する。
preview資源をproductionへ流用せず、Custom Domainを公開する前後で停止点を設ける。

このrunbookは実行順の正本である。secret値、OAuth client secret、cookie、Access JWTは
記録しない。

## 現在の状態

- production D1、R2、5 Queueは作成済み
- 3 Workerの`env.production`とgenerated typesは追加済み
- 3 Workerのproduction dry-runは成功
- production Access AUDは設定済み
- production D1へ`0001`〜`0017`を適用済み
- production Better Auth / Google OAuth secretsは設定済み
- Realtime、Snapshot、Webの初回配備とCustom Domain公開は完了
- 自動smokeと利用者によるOAuth / room / 管理操作E2Eはpass
- 終了後のD1 projectionとcleanup / evidence Queue / DLQ healthは正常
- 初回配備時間窓のRealtime Analyticsはpass、Snapshotは未起動で想定内
- Web AnalyticsはCPU / memory pass、`05:32:19Z`の2 errorsは既知の配備時過渡エラー

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

1. `git diff --check`が成功する。
2. generated Cloudflare typesが最新である。
3. rootのlint、typecheck、test、buildが成功する。
4. `wrangler whoami`のaccount IDが台帳と一致する。
5. production D1 UUIDを`d1 list`と照合する。
6. R2と5 Queueが存在する。
7. Web Workerの3 secretがproductionへ設定済みである。
8. `koge.app`と`realtime.koge.app`に競合DNS recordがない。
9. emergency modeが通常運用の3項目許可状態である。

いずれかが不明ならmigration / deployを開始しない。

## Step 1: D1 migration

空の`koge-production`だけを対象にする。

```sh
npm exec wrangler -- d1 migrations apply koge-production --remote \
  --config apps/realtime/wrangler.jsonc --env production
```

適用後はmigration一覧と主要tableの存在をread-onlyで確認する。preview database名が
出力された場合は直ちに停止する。

## Step 2: Realtime Worker

DO class、Queue producer / consumer、R2、D1、cron、Realtime Custom Domainを作る。

```sh
npm run deploy:production --workspace @koge/realtime
```

確認:

```text
https://realtime.koge.app/health
```

HTTP 200とproduction環境表示を確認するまで次へ進まない。

## Step 3: Snapshot Worker

Snapshot Workerはproduction Realtime WorkerのDO classを参照するため、Realtimeの後に
配備する。

```sh
npm run deploy:production --workspace @koge/snapshot
```

`koge-snapshot-production` Queueにconsumerが1件接続されたことを確認する。

## Step 4: Web Worker

Realtime health、production secrets、Google redirect URIを再確認してから配備する。

```sh
npm run deploy:production --workspace @koge/web
```

Vinext adapter経由でbuildとproduction environment選択を一体で実行する。
生成済み`dist/server/wrangler.json`へ別commandで直接deployしない。

## Step 5: production smoke

最初はOAuthをTestingにし、許可したtest userだけで確認する。

1. `https://koge.app`がHTTP 200。
2. Google login、callback、session、logout、再login。
3. 公開roomを1件作成。
4. 別browserでparticipant / viewerとして入室。
5. 描画、cursor、chat、reload / 短い切断復帰。
6. snapshot + tail復帰。
7. host終了、一覧除外、再入室拒否、D1 / R2 cleanup。
8. `koge.app/admin/*`と`/api/admin/*`がAccessなしでは拒否される。
9. Access認証後に管理停止、復旧、監査記録。
10. Queue / DLQ、Worker errors、CPU / memoryを確認。

試験roomはhost終了し、cleanup完了まで確認する。

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

## 2026-07-29 初回配備結果

正しいD1 UUIDは
`2071beb0-831b-40cf-9c7d-d068496766b3`。利用者から最初に共有された値は末尾の`3`が
欠けていたが、migration前のCloudflare `d1 list`照合で検出・修正した。

| 対象 | version / 結果 |
| --- | --- |
| D1 | `0001`〜`0017`成功、未適用0 |
| Realtime | `476b45bf-73b8-4dad-85cd-054acdc3a63f` |
| Snapshot | `7fb79a67-6c40-4227-a627-3b06d1e7ba07` |
| Web | `011c5f1d-4d25-4dc5-b7c0-3cf9cdca7cf2` |

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
