# koge

複数人で同じ固定キャンバスへ描画し、チャットしながら交流できる
お絵描きチャットサービスです。

## 現在の状態

更新日: 2026-07-30

MVPの主要実装、preview検証、production配備と直近の復旧検証まで完了しています。
`https://koge.app`と`https://realtime.koge.app`は稼働し、Google OAuth、
ルーム作成・入室、描画、remote cursor、chat、reload復帰、room終了、
Cloudflare Access配下の管理操作を利用者E2Eで確認済みです。
1000 x 1000 canvasと公開ルームサムネイルはlocal実装・自動試験まで完了し、
preview / productionのresource作成と検証はこれからです。

一般公開完了ではありません。規約、retention、alert、backup/restore試験、
closed betaを含む公開運用gateが残っています。現在の正確な進捗は
[`docs/plans/mvp-implementation-plan.md`](./docs/plans/mvp-implementation-plan.md)と
[`docs/results/README.md`](./docs/results/README.md)
を参照してください。

## 実装済みの主要機能

- Google OAuthとBetter Authによるアカウント・session
- 設定画面での表示名・avatar URL変更と非同期account削除
- public / unlisted room、guest viewer session、single-use room ticket
- ログインユーザーの描画・role横断chat、host / participant / viewer
- server由来の表示名・avatar付き短期chat、presence、remote cursor
- MessagePack stroke protocolとWebSocket Hibernation
- 1000 x 1000の白いCanvas、brush / eraser / eyedropper、pan / zoom
- stroke単位の低opacity描画とWASM canonical renderer
- 短期chat、rate limit、mute、disconnect
- waiting / active / idle / closing / suspendedのroom lifecycle
- snapshot-first recovery、R2、Queue、event-log fallback
- snapshot RGBAを共有する512 x 512公開ルームサムネイル（local実装）
- room終了時のR2 → Durable Object → D1 cleanup
- report、期限付きmoderation evidence、kick、room BAN、service BAN
- 緊急時のroom作成・入室・描画停止
- Cloudflare Accessで保護した管理画面と運用health endpoint

MVPにギャラリー、完成画像保存、undo / redo、筆圧、スタンプは含めません。

## 構成

| path | 役割 |
| --- | --- |
| `apps/web` | vinext / React UI、Better Auth、room API、管理画面 |
| `apps/realtime` | Durable Object、WebSocket、lifecycle、cleanup、moderation |
| `apps/snapshot` | Queue consumer、共通WASMによるruntime snapshot生成 |
| `packages/protocol` | wire protocol、codec、validation、共有上限 |
| `packages/renderer-core` | Browser / Workers共通のRust/WASM renderer |
| `migrations/d1` | Better Authとkoge application schema |
| `tools` | benchmark、smoke、analytics、運用補助 |
| `tests/e2e` | Playwrightによる主要利用経路 |
| `prototypes/v2` | UI検討用mockup。実装仕様の正本ではない |
| `docs` | 設計、仕様、判断、計画、結果、setup、runbook |

実行基盤はCloudflare Workers、Durable Objects SQLite、D1、R2、Queuesです。
local / preview / productionは別resourceへ分離しています。

## 必要環境

- Node.js 22（`.nvmrc`）
- npm 10
- Rust toolchain（`packages/renderer-core`を再buildする場合）
- Wrangler login（remote resourceを操作する場合）

```sh
nvm use
npm install
```

認証を含むlocal環境では、追跡対象外の`apps/web/.env.local`へsecretを設定します。
値やtokenをMarkdown、issue、terminal command argumentへ書かないでください。
詳細は[`docs/setup/external-services.md`](./docs/setup/external-services.md)を参照してください。

## Local development

初回だけlocal D1 migrationを適用します。

```sh
npm exec wrangler -- d1 migrations apply koge-local \
  --local \
  --config apps/realtime/wrangler.jsonc
```

別terminalでWebとRealtimeを起動します。

```sh
npm run dev:realtime
npm run dev:web
```

- Web: `http://localhost:3000`
- Realtime: `http://localhost:8787`

Snapshot Workerや運用補助toolは、該当する結果文書・runbookの手順に従って起動します。

## Validation

通常の変更では次を実行します。

```sh
npm run cf:types:check
npm run check
npm run build
```

利用者経路を変更した場合:

```sh
npm run smoke:e2e
```

Cloudflareへ配備するコマンドは外部状態を変更します。preview / productionを取り違えず、
production作業は必ず
[`docs/setup/production-deployment.md`](./docs/setup/production-deployment.md)
のpreflight、順序、rollback条件に従ってください。

## Production deployment

本番は`koge.app`（Web）と`realtime.koge.app`（Realtime）で稼働しています。
作業前に意図した変更だけが含まれていること、production用resourceとsecretが設定済み
であることを確認します。Wranglerの認証が切れている場合は
`npm exec wrangler -- login`で再認証してください。

```sh
nvm use
npm ci

npm exec wrangler -- whoami
git status --short
git diff --check

npm run cf:types:check
npm run check
npm run build
```

`whoami`のaccount IDは
[`docs/setup/environment-inventory.md`](./docs/setup/environment-inventory.md)
のproduction台帳と照合します。いずれかの検証が失敗した場合は配備しません。

### 配備範囲を判定する

Webだけを配備できるのは、変更が`apps/web`内のUIまたはWeb APIに閉じ、
次のどれにも触れていない場合だけです。

- `migrations/d1`
- `apps/realtime`、`apps/snapshot`
- `packages/protocol`、`packages/renderer-core`
- Worker間のService Binding、Queue、R2、D1、Durable Object設定
- room provisioning、ticket、WebSocket、snapshotのrequest / response

上記に該当する、または判断できない場合はWeb単独配備にせず、D1 → Realtime →
Snapshot → Webの全体手順を使います。特に`packages/protocol`を変更した配備を
Webだけで行ってはいけません。

### Webだけを更新する場合

配備前後のWeb versionを記録し、dry-run後に配備します。

```sh
npm exec wrangler -- deployments status \
  --config apps/web/wrangler.jsonc --env production
npm run dry-run:production --workspace @koge/web
npm run deploy:production --workspace @koge/web
npm exec wrangler -- deployments status \
  --config apps/web/wrangler.jsonc --env production
```

WebはVinext adapterのscriptを通して配備します。生成された
`dist/server/wrangler.json`へ別commandで直接deployしないでください。

### D1 / Realtime / Snapshot / 共有protocolを含む場合

全体配備は次の順序を変えず、各段階の確認に成功してから先へ進みます。

1. 3 Workerの現行versionとD1の未適用migrationを記録する。
2. 変更が要求するprivate R2 bucketなどのresourceとbindingを先に照合する。
3. production D1へ未適用migrationを適用し、未適用0件を確認する。
4. Realtimeをdry-run、配備し、versionと`/health`を確認する。
5. Snapshotをdry-run、配備し、versionとQueue consumerを確認する。
6. Webをdry-run、配備し、versionを確認する。
7. HTTP healthに加え、ログイン済み利用者が実際にroomを作成し、自動開始・入室・
   描画・chat・復帰できることを確認する。
8. 対象変更にthumbnailが含まれる場合は、public表示、unlisted拒否、終了cleanupを
   確認する。
9. provisioning失敗、Worker error、Queue / DLQ backlogが増えていないことを確認する。

共有protocolはconsumer側を旧・新payloadの両方に対応させて先に配備し、その後に
producerを切り替えるexpand / contractを基本とします。必須fieldを削除しながら
protocol versionを据え置き、producerだけを先に配備してはいけません。

具体的なcommand、resource照合、停止条件、rollbackは
[`docs/setup/production-deployment.md`](./docs/setup/production-deployment.md)
を正本とします。D1 migrationは逆実行せず、R2 bucketやQueueの削除・purgeを
rollbackとして行いません。

### 配備後の最小確認

```sh
curl -fsS -o /dev/null https://koge.app/
curl -fsS https://koge.app/api/rooms
curl -fsS https://realtime.koge.app/health
```

HTTP healthはbindingの存在確認であり、Web → Realtime Service Bindingのpayload互換性
までは検証しません。必ず認証済みの実room作成を行い、異常時は新しい配備を重ねず、
room作成を停止してCloudflare Workersの直前の正常versionへrollbackします。

## Documentation

文書の入口は[`docs/README.md`](./docs/README.md)です。

- [MVP実装計画](./docs/plans/mvp-implementation-plan.md)
- [現行仕様](./docs/spec/README.md)
- [Decision records](./docs/decisions/README.md)
- [検証・配備結果](./docs/results/README.md)
- [環境値台帳](./docs/setup/environment-inventory.md)
- [運用runbook](./docs/runbooks/README.md)

仕様と実装が変わる場合は、コード、test、関連仕様、runbookを同じ変更で更新します。
