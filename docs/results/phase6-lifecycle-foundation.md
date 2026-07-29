# Phase 6: room lifecycle foundation

実施日: 2026-07-28  
状態: preview deploy・自動テスト・利用者E2E pass

## 実装した範囲

- 新規roomのDO lifecycleを`waiting`で初期化する。
- 既存schema v19 roomはmigration後も`active`を維持する。
- waiting中も入室、presence、cursorを許可する。
- waiting中のdrawing/chatを`ROOM_NOT_ACTIVE`で拒否する。
- room ticketで確定したhost roleだけが`room.start`を送れる。
- host開始を冪等な`waiting -> active`遷移として永続化する。
- `room.updated(waiting|active|idle)`を接続中clientへ配信する。
- accepted drawing/chatだけで`last_activity_at`を更新する。
- DO SQLite `scheduled_tasks`と単一alarmで30分の`idle_timeout`を管理する。
- 最終接続の退出時に10分の`empty_timeout`を設定し、再入室で取り消す。
- room初期化時に作成時刻基準の`max_duration`を設定する。
- empty/max期限を決定的なclose request IDで既存closing fenceへ接続する。
- hostだけが`room.close`を送れるようにし、確認付き終了ボタンを追加する。
- closing開始時にD1一覧projectionをclosingへ更新する。
- 接続者がいるactive roomだけをidleへ遷移する。
- cursor/presenceでは活動時刻とidle状態を変更しない。
- idle中のaccepted drawing/chatでactiveへ戻す。
- active/idle遷移をD1 room一覧projectionへ反映する。
- headerへ「開始待ち」「ひと休み中」を表示し、hostへ開始ボタンを出す。
- `room.closed`をWebSocket切断前に配信する。
- D1へcleanup job IDを記録し、専用Queueへ冪等な削除jobを投入する。
- Queue投入失敗をDO alarmから10秒後に再送する。
- R2 snapshot、DO SQLite、D1 room/member/inviteを順に物理削除する。
- cleanup jobを最大5回再試行し、失敗後は専用DLQへ退避する。
- report/evidenceの最小D1 schemaを追加する。
- 未解決reportのevidenceがcommitされるまでcleanupをfail closedにする。
- runtime snapshot孤児をD1 roomとDO job/manifestに照合してinventory化する。
- 孤児scanを毎日実行し、healthで検出するがR2は自動削除しない。

## protocol / schema

- Client: `room.start { requestId }`
- Server: `room.updated`のwaiting / active / idle variant
- Server: `room.updated(suspended)`
- Server: `room.activity`の80 / 90 / 98 / 100 level
- Server: `room.time`の15 / 5 / 1分前通知
- DO SQLite schema version: 26
- `room_lifecycle.status_changed_at`
- `room_lifecycle.last_activity_at`
- `scheduled_tasks(kind, due_at)`
- `room_activity_limit(warning_level, reached_at)`
- `room_time_limit(warning_stage)`
- `room_cleanup(job_id, close_request_id, snapshot_object_keys, enqueue state)`
- D1 migration `0007_room_cleanup.sql`
- D1 migration `0008_moderation_evidence_fence.sql`
- D1 migration `0009_report_abuse_fence.sql`
- D1 migration `0010_evidence_retention_jobs.sql`
- D1 migration `0011_snapshot_orphan_inventory.sql`
- D1 migration `0012_moderation_action_state.sql`
- D1 migration `0013_room_bans.sql`
- D1 migration `0014_service_controls.sql`
- D1 migration `0015_snapshot_orphan_deletions.sql`

## 自動検証

- Protocol Vitest: 29 tests pass
- Web Workers Vitest: 38 tests pass
- Realtime Workers Vitest: 56 tests pass
- waiting中の非host start拒否: pass
- waiting中のdrawing拒否: pass
- host start: pass
- alarmによるactive -> idle: pass
- idle中のcursorで状態不変: pass
- chatによるidle -> active: pass
- 最終退出によるempty task設定: pass
- 猶予中の再入室によるempty task取消: pass
- 再退出と期限到達によるempty_timeout closing: pass
- 接続中のmax_duration closing: pass
- 自動終了後の再入室410拒否: pass
- participantからのhost close拒否: pass
- host closeと再入室410拒否: pass

## 次の作業

1. closed betaの通常利用後にrate abuse current captureを取得し、暫定閾値を評価する。
2. 公開用の異議申立て窓口と担当者を確定する。
3. Phase 7の負荷・障害・security試験へ進む。

## Temporary service BAN

2026-07-29にservice-level BANの判断を
[`../decisions/0008-temporary-service-bans.md`](../decisions/0008-temporary-service-bans.md)
へ固定し、previewへ実装した。

- 永久BANを採用せず、24時間 / 7日 / 30日（既定7日）の一時措置とした。
- Better Auth user IDまたはguest session IDを対象とし、生IPを保存しない。
- 有効中はuserの新規room作成とuser / guestの全room ticketをD1で拒否する。
- 適用時は稼働中membershipを最大25 roomまで解決し、DO内ticketと未確定strokeを
  失効して全connectionを1008で閉じる。
- Cloudflare Access管理画面から期間を選択して適用し、理由付きで解除できる。
- BANと対応するmoderation actionは有効終了後180日保持し、日次maintenanceで
  削除する。
- guest cookieの再生成は防げないため、自動service BANやIP BANは導入せず、
  rate limit、room BAN、通報、emergency controlを併用する。

自動検証:

- Realtime Workers Vitest: 63 tests pass
- Web Workers Vitest: 40 tests pass
- Snapshot Vitest: 6 tests pass
- Protocol Vitest: 29 tests pass
- root `npm run check`: pass
- Realtime / Web production build: pass

preview:

- D1 migration `0017_service_bans.sql`: applied、pending 0
- Realtime version: `70de8224-4d63-4f95-94f5-b6ca32fdd72d`
- Web version: `ad97f107-eaf6-49aa-8c03-92fc6b0c261d`
- Web `/`: HTTP 200
- Realtime `/health`: HTTP 200
- `/admin/rooms`（未認証）: HTTP 302
- `service_bans`初期件数: 0

利用者E2Eは
[`../setup/cloudflare-access-admin.md`](../setup/cloudflare-access-admin.md)
のservice BAN 8項目を2026-07-29にpreviewで実施し、すべてpassした。

1. 試験用roomへ別browserから非ホストとして入室できる。
2. 管理画面で理由と24時間を選び、service BANを適用できる。
3. 対象connectionが閉じ、再入室不可の案内が表示される。
4. 対象subjectは別の公開roomにも入室できない。
5. ログイン対象者は新規roomを作成できない。
6. 管理画面の一覧に対象、理由、期限が表示される。
7. 理由付きで解除し、解除済みへ遷移する。
8. 解除後、対象subjectが再びroomへ入室できる。

これによりAccess認証済み管理操作、Realtimeでの全room切断、D1のroom作成・
ticket fence、監査一覧、解除、利用者復帰までのpreview製品経路が成立した。
service-level BANのPhase 6利用者E2Eを完了とする。公開前には利用者が到達できる
異議申立て窓口と運用担当者を別途確定する。

## preview

- Realtime version:
  `ac6e645b-c65d-4f4c-90d3-037d0e1b9616`
- Web version:
  `ab86be59-5eea-42a1-a7fa-e2fbe26449cc`
- `https://realtime-preview.koge.app/health`: `200`
- `https://realtime-preview.koge.app/health/cleanup`: `200`
- `https://realtime-preview.koge.app/health/evidence`: `200`
- `https://preview.koge.app/`: `200`
- `POST /api/rooms/{slug}/reports`の不正origin拒否: JSON `403`

## 利用者E2E

2026-07-28にpreviewで新規roomを作成し、次の6点を確認してすべてpassした。

1. 入室直後に「開始待ち」と表示される
2. 別browserも開始前に入室できる
3. hostだけに「ルームを開始」が表示される
4. hostが開始すると両browserが同期状態になる
5. 開始後にdrawing/chatを利用できる
6. reload後もactive状態で復帰できる

これにより、D1のwaiting projection、room ticketによるhost role判定、
DO SQLiteのwaiting -> active遷移、`room.updated` broadcast、client権限制御、
開始後のdrawing/chat受付、再接続時のactive復元までのpreview製品経路が
成立した。

同日、host明示終了についてもpreviewの新規roomで次の6点を確認し、
すべてpassした。

1. hostだけに「ルームを終了」が表示される
2. ボタン操作で確認dialogが表示される
3. cancelするとroomが継続する
4. 確定すると接続が閉じる
5. room一覧から消える
6. 同じURLへ再入室できない

これにより、room ticket由来のhost認可、不可逆操作のclient確認、
`room.close`、DO SQLiteのclosing永続化、`room.updated(closing)`、
WebSocket切断、D1一覧projectionの除外、終了後の410拒否までのpreview製品経路が
成立した。

## 通常終了cleanup preview

2026-07-28に次を作成・適用した。

- Queue: `koge-room-cleanup-preview`
- DLQ: `koge-room-cleanup-preview-dlq`
- D1: `0007_room_cleanup.sql`
- Realtime version: `ad39a7ad-5a98-4679-8aa6-6a1d25e0b5c9`
- Web version: `d3d6cbb8-0654-41ce-b5a5-852ae06339f5`

自動テストでは、`room.closed` codec、切断前通知、object key prefix検証、
R2 -> DO -> D1の削除順、D1行削除後のduplicate ackを確認した。
2026-07-28に配備後の新規roomで利用者preview E2Eを行い、次の4点を
すべてpassした。

1. roomを開始してdrawing/chatを利用できる。
2. hostから終了できる。
3. 終了通知後に接続が閉じ、一覧から消える。
4. 同じURLへ再入室できない。

E2E後にpreview D1をread-onlyで確認し、この新規roomの行が残っていないことを
確認した。残存行は配備前から存在する`cleanup_job_id IS NULL`のclosing room 2件と
waiting room 1件だけであり、新しいcleanup経路によるD1物理削除が成立した。
cleanup QueueはRealtime Workerのproducer/consumer各1件、DLQは独立Queueとして
接続されている。

R2 objectとDO SQLiteの非残存は、jobが保持していたroom ID/object keyを終了後に
外部から参照できないため、このE2Eだけでは個別にread-backしていない。

後述の最小schemaと削除防止fenceに加え、report受付とevidence bundle生成を
実装した。未解決reportの証跡が未確定のまま通常cleanupされない。

このversionより前に既に`closing`だったpreview roomにはcleanup jobを
backfillしていない。今回の実resource確認には、deploy後に作成した新規roomを使う。
旧preview test roomのorphan scan/backfillは後続の運用toolで扱う。

## Cleanup failure injectionと監視

2026-07-28に次を自動試験へ追加し、すべてpassした。

- R2 delete失敗時にDO/D1を変更しない。
- DO delete失敗時にD1 fenceを残す。
- D1 delete失敗後に同じjobを再実行できる。
- cleanup job IDがD1 fenceと異なる場合は削除しない。
- D1 delete後に行が残る異常を検出する。

さらにCloudflare Workersの隔離環境へ実D1 migrationを適用し、unlisted room、
membership、invite、DO snapshot job、R2 staging objectを作成してからcleanupを
実行する統合fixtureを追加した。処理後にR2 object、DO SQLiteの全table、
D1 room/member/inviteがすべて存在しないことをread-backして確認した。

同fixtureへ未解決reportも追加した。evidence未確定時はR2/D1/DOを変更せず
cleanupが失敗し、実R2へevidence objectを置いてmanifestを`committed`にすると
通常snapshotだけを削除してroom cleanupが完了することを確認した。room削除後も
report行とevidence objectは残る。fixtureの保持期限は試験値であり、製品の
retention決定ではない。

`GET /health/cleanup`を追加し、main Queue、DLQ、D1の5分超過projectionを
read-onlyで監視できるようにした。preview実測はHTTP 200で、
main Queue / DLQ backlog、stuck projectionはいずれも0だった。

DLQの検知、調査、再送、禁止事項は
[`../runbooks/room-cleanup-dlq.md`](../runbooks/room-cleanup-dlq.md)へ記録した。

## Moderation evidence削除防止fence

2026-07-28にD1 migration `0008_moderation_evidence_fence.sql`を追加した。
`reports`はroom削除にcascadeせず、`evidence_manifests.expires_at`を必須にする。
`open`、`evidence_pending`、`under_review`のreportについて、manifestが存在し
`committed`であることをcleanup開始前に確認する。条件を満たさない場合は
R2/DO/D1のいずれも削除しない。

report受付API、利用者dialog、専用Queue/DLQ、固定時点のsnapshot + tail event、
chat/metadata/membership、component hashとmanifestのR2保存を実装した。
同一subject・roomの未解決reportは1件に制限する。証跡commit後はclosing roomの
cleanup Queueを再起動する。期限到達時のevidence削除は後述のとおり実装済みで、
管理画面は未実装。
保持期間は暫定30日で、公開前の決定事項として残している。

同日にpreview D1へmigrationを適用し、migration記録と`reports`、
`evidence_manifests`、`moderation_actions`の3 tableをread-only queryで確認した。
配備後の`/health`、`/health/cleanup`、`/health/evidence`はいずれもHTTP 200で、
Queue/DLQ backlogとstuck projectionは0だった。専用Queueはproducer/consumerが
各1件、DLQはproducer 1件・consumer 0件であることをCloudflareから確認した。
`0009_report_abuse_fence.sql`の適用記録と
`reports_one_unresolved_per_subject_room_idx`の定義もread-onlyで確認した。

自動検証ではProtocol 23、Web 25、Realtime Workers 44 testsがpassした。
実D1 migration、DO SQLite、R2を使い、member reportの受付、duplicate抑止、
非member拒否、2 drawing eventsとchatの固定bundle生成、R2 manifest/component、
D1 `committed` / `under_review`、duplicate jobの冪等完了をread-backした。

## Moderation evidence retention

2026-07-28にD1 migration `0010_evidence_retention_jobs.sql`を適用し、
`deletion_job_id`と`deletion_requested_at`による削除claimを追加した。
Realtime Workerは毎日03:17 UTC（12:17 JST）に期限切れの`committed` evidenceを
最大100件scanし、既存のmoderation evidence Queueへ削除jobを投入する。

consumerは`moderation-evidence/{evidenceId}/`だけを最大1,000 objectずつ列挙し、
R2を先に削除してからD1を`deleted`へ更新する。期限・job ID・statusを更新直前にも
照合し、期限延長やstale jobでは削除しない。enqueue失敗時はclaimを解放し、
5分以上停止したclaimは次回scanで再投入できる。

実D1/R2統合fixtureでmanifestとevent componentの2 object削除、D1 metadataの
消去、duplicate jobの`already_deleted`完了を確認した。preview deployでは
cron triggerとmigration適用を確認した。管理画面は未実装である。

## Moderation evidence preview E2E

2026-07-28に利用者がpreviewの新規roomで描画・chat後に通報を1件送信し、
受付完了messageが表示されることを確認した。続けてCloudflare上の保存結果を
read-onlyで照合し、次を確認した。

- reportは`under_review`、evidenceは`committed`
- 受付から約7秒でevidence commit
- 保持期限は受付から30日後
- manifest schemaは`koge.moderation-evidence.v1`
- 固定時点はroom sequence 90、chat 2件、membership 2件
- event componentはsequence 1–50と51–90の2 object
- 50件＋40件の計90 eventに欠落なし
- 両componentのR2実サイズとSHA-256がmanifest記録値に一致
- evidence Queue / DLQ backlog、pending、stuck、deletion claimはすべて0
- `/health/evidence`はHTTP 200

これにより、利用者dialog、Web report API、認証済みmembership確認、D1 projection、
Queue consumer、DO固定時点取得、R2 bundle、D1 commit、監視までのpreview製品経路が
成立した。

## Moderation evidence Queue / DLQ preview recovery

2026-07-28に実Cloudflare QueueでduplicateとDLQ復旧を確認した。

最初に、直前の利用者E2Eで`committed`になったevidence jobをmain Queueへ再送した。
Realtime logで`already_committed`、`componentCount = 0`を確認し、D1のstatus、
commit時刻、object size、hashが不変であることをread-onlyで確認した。

次に、製品dataを参照しない`moderation.evidence.delete` probeをmain Queueへ送った。
D1 projectionが存在しないため想定どおり失敗し、30秒遅延・5回retry後にDLQ
backlogが1以上となり、`/health/evidence`がHTTP 503へ変化した。

同じbodyが安全に成功できる`status = deleted`の一時D1 fixtureを作成し、短命な
DLQ consumerでbodyを変更せずmain Queueへ戻した。Realtime logで
`already_deleted`を確認した。cron境界で複数のprobeが生成されたが、すべて同じ
結果で冪等にackされた。

検証後は短命DLQ consumer、probe Worker、一時D1 fixtureを削除した。最終状態は
main Queue / DLQ backlog 0、DLQ consumer 0、pending / stuck / deletion claim 0、
`/health/evidence` HTTP 200である。利用者E2Eのcommitted evidenceはstatus、
object size、hashが不変であることを確認した。

再現用の限定toolは
[`../../tools/cloudflare-queue-recovery-probe/README.md`](../../tools/cloudflare-queue-recovery-probe/README.md)
へ記録した。

## Runtime snapshot orphan inventory

2026-07-28にD1 migration `0011_snapshot_orphan_inventory.sql`をpreviewへ適用し、
Realtime version `33326a99-ba7b-452c-864a-d4d1abbeae87`を配備した。

scanは`rooms/{roomId}/snapshots/staging/{jobId}.kgs`だけを対象とし、uploadから
1時間未満を除外する。D1 roomが存在しないobjectを`room_missing`、roomはあるが
DOのsnapshot job/manifestから参照されないobjectを`unreferenced`とする。
最大10,000 object / 500 room、DO応答1,000 keyでfail closedに停止する。
完了scanだけがD1 inventoryを置き換え、R2 objectは自動削除しない。

毎日03:17 UTCのscheduled scan、`GET /health/orphan-snapshots`、
remote service bindingを使うlocalhost限定の手動scan toolを追加した。
初回scanは2026-07-28T08:10:13.460Zに完了し、次を確認した。

- mature runtime snapshot: 10 object / 66,207 bytes
- `room_missing`: 10 object / 66,207 bytes
- `unreferenced`: 0
- upload範囲:
  2026-07-27T08:11:16.594Z–2026-07-27T14:34:37.745Z
- R2自動削除: 0
- `/health/orphan-snapshots`: HTTP 503（inventory検出の期待値）

検出objectは旧preview試験roomの候補として保持している。連続scan、D1/DO再確認、
個別keyの人手承認なしに削除しない。手順は
[`../runbooks/snapshot-orphan-inventory.md`](../runbooks/snapshot-orphan-inventory.md)
へ記録した。

## Activity limit soft close

2026-07-28に活動量上限を既存のclosing/cleanup経路へ接続した。

- hard limit: 100,000 drawing events / 64MiB
- completion reserve: 7,000 events / 8MiB
- soft limit: 93,000 events / 56MiB
- warning: soft limitの80%、90%、98%
- 100%: 新規`stroke.begin`を停止
- drain: 受理済みstrokeのappend / end / cancel / 2秒timeoutを継続
- 未完了stroke 0件: `activity_limit`理由でclosing
- hard limit到達: server生成endで即時closing

DO SQLite schema v23へ`room_activity_limit(warning_level, reached_at)`を追加し、
Hibernation・再接続後もwarningと新規stroke停止を復元する。
`room.activity`はevent / payloadの現在値、soft limit、warning level、
`acceptingNewStrokes`を全clientへ配信する。Web UIは残量pillと通知を表示し、
100%では新しい線の開始を無効化する。進行中pointer strokeのend送信は維持する。

自動試験では80 -> 90 -> 98 -> 100の順次通知、100%後の新規begin拒否、
進行中append/end受付、active stroke 0件でのclosing、close reason、
server確定stroke 0件を確認した。全体検査はProtocol 24、Realtime 47、
Web 25 testsを含めてpassした。

preview:

- Realtime version:
  `b2c48dd1-c2b1-4aec-93de-d4303eec5dec`
- Web version:
  `3a5bd3c2-7929-40b1-af3d-2f38d5ec45f5`
- Realtime `/health`: HTTP 200
- Cleanup `/health/cleanup`: HTTP 200
- Evidence `/health/evidence`: HTTP 200
- Web `/`: HTTP 200

## Admin suspend / close private foundation

2026-07-28に、公開管理routeを作らず、Web Workerからprivate Service Bindingでだけ
呼べるadmin suspend / close基盤を実装した。

- `room.moderation.v1` request / resultとstrict validatorを追加。
- `moderation_actions`へpending / applied / failed、applied time、
  bounded error code、lifecycle結果を追加。
- 操作IDと全入力が一致する再送は保存結果を返し、異なる入力のID再利用は409。
- 同時INSERT競合でも既存操作を再読込して同じ冪等規則へ収束。
- suspend時はactive strokeをserver生成endで確定。
- room / snapshot read ticket、scheduled task、snapshot automationを停止。
- `room.updated(suspended)`を配信し、WebSocketをpolicy violationで閉じる。
- suspended roomへの再入室を410で拒否。
- suspendedからadmin closeで既存evidence / cleanup fenceへ遷移可能。
- Web clientは「管理停止中」と表示し、自動再接続を停止。

D1 migration `0012_moderation_action_state.sql`をpreviewへ適用した。自動試験では
private serviceによるsuspend、D1 projection、監査結果、同一操作再送、
異なる入力の競合拒否、suspendedからのadmin close、active stroke確定、
ticket/alarm停止を確認した。全体検査はProtocol 27、Realtime 50、
Web 25 testsを含めてpassした。

preview:

- Realtime version:
  `ac6e645b-c65d-4f4c-90d3-037d0e1b9616`
- Web version:
  `e2659da3-6f5f-4ec3-a1bf-4a206abf010c`
- D1 migrations: pending 0
- Realtime `/health`: HTTP 200
- Cleanup `/health/cleanup`: HTTP 200
- Evidence `/health/evidence`: HTTP 200
- Web `/`: HTTP 200

同日にCloudflare Access applicationのissuerとAUDを設定し、
`/admin/rooms`、`/api/admin/rooms`、`/api/admin/moderation`をpreviewへ配備した。
Workerは`Cf-Access-Jwt-Assertion`をRS256署名、issuer、audience、期限まで検証し、
検証済み`sub`をSHA-256内部IDへ変換してから監査処理へ渡す。same-origin POST、
2KiB body上限、500文字理由、UUID idempotency keyも必須とした。

自動試験では正しいtoken、欠落token、誤AUD、期限切れ、設定不備、
room一覧、入力正規化、private Service Bindingへのidentity引き渡し、
404 / 409変換を確認した。未認証の画面とAPIはCloudflare Access loginへ
HTTP 302となり、通常top pageはHTTP 200を維持した。

preview:

- Web version:
  `ab86be59-5eea-42a1-a7fa-e2fbe26449cc`
- Web Workers Vitest: 32 tests pass
- `/admin/rooms`（未認証）: HTTP 302
- `/api/admin/rooms`（未認証）: HTTP 302
- `/`: HTTP 200

利用者確認手順は
[`../setup/cloudflare-access-admin.md`](../setup/cloudflare-access-admin.md)
に記録した。

同日、Accessの許可対象identityを使った利用者E2Eで次の6点を確認し、
すべてpassした。

1. previewで試験用roomを作成できる。
2. Access認証後に管理画面を開ける。
3. 管理対象roomが一覧へ表示される。
4. 理由付き管理停止が適用される。
5. roomの接続終了、管理停止表示、再入室拒否が成立する。
6. suspended roomを強制終了すると管理一覧から消える。

これにより、Cloudflare Access policy、Worker内JWT再検証、D1 room projection、
公開管理API、private Service Binding、DO suspend、WebSocket切断、
suspended再入室拒否、admin close、cleanup開始までのpreview製品経路が成立した。

## Maximum duration warnings

2026-07-28に作成時刻基準の最大時間について、15分、5分、1分前通知を
既存の単一alarmへ統合した。

- `room.time { warningMinutes, endsAt, remainingMs }`をProtocolへ追加。
- DO SQLite schema v24へ`room_time_limit(warning_stage)`を追加。
- 通知段階は0=未通知、1=15分、2=5分、3=1分として永続化。
- `max_duration`の期限と通知段階から次のalarm時刻を導出し、
  通知ごとのtask行は作らない。
- v23からv24へのmigration直後は、既存alarmが残っていても次回時刻を再計算。
- alarmが遅れて複数境界を越えた場合は、現在時刻に合う最新段階だけを配信。
- Hibernation・再接続後は最後の段階と最新の残り時間を再送。
- Web UIは通知文と「終了までN分以内」pillを表示。
- 時間通知はdrawing event、roomSeq、idle activityへ含めない。

自動試験ではv23相当状態からのalarm再設定、15 -> 5 -> 1分の順次通知、
warning stage 3の永続化、別接続での1分段階復帰、
期限到達時の既存`max_duration` closingを確認した。
全体検査はProtocol 25、Realtime 48、Web 25 testsを含めてpassした。

preview:

- Realtime version:
  `70b12b38-b82f-4359-891b-e9e2fd22bfc7`
- Web version:
  `81f501f5-a49c-40f5-9675-45cf1a2d3175`
- Realtime `/health`: HTTP 200
- Realtime `/health/room/main`: HTTP 200、schema version 24
- Cleanup `/health/cleanup`: HTTP 200
- Evidence `/health/evidence`: HTTP 200
- Web `/`: HTTP 200

## Admin kick and room BAN

2026-07-28にCloudflare Accessで保護済みの管理画面へ、接続中member一覧、
kick、room BANを追加した。

- DO Hibernation APIのWebSocket attachmentから接続中actorとroleを列挙する。
- 操作対象はroom内で安定したactor IDとし、ホストはD1とDOの両方で保護する。
- kick / room BAN前に対象actorのactive strokeをserver生成endで確定する。
- 対象actorに`room.removed`を送信し、同actorの全connectionをclose code 1008で
  閉じる。他actorの接続は維持する。
- kick後はclientの自動再接続だけを止め、明示的な再入室を許可する。
- room BANはD1 `bans`で同じuser / guest subjectへの新ticketを拒否し、
  DO SQLite schema v25 `room_bans`でも既存ticketと直接再接続を拒否する。
- ban期限はroomの`max_ends_at`で、room cleanup時にD1 rowも削除する。
- moderation actionはtarget actor、切断数、ban期限を含めて冪等に記録する。

D1 migration `0013_room_bans.sql`をpreviewへ適用した。全体検査はProtocol 28、
Realtime 52、Web 35、Snapshot 6 testsに加え、rendererと測定toolのtestを含めて
passした。

preview:

- Realtime version:
  `a4a48d12-8ab1-4e11-9e5a-68355c9e6357`
- Web version:
  `29a3ee33-a25c-4764-b3fc-197aaae8153d`
- D1 migrations: pending 0
- Realtime `/health`: HTTP 200
- Realtime `/health/room/main`: HTTP 200、schema version 25
- Web `/`: HTTP 200
- `/admin/rooms`（未認証）: HTTP 302
- `/api/admin/members`（未認証）: HTTP 302

利用者E2E手順は
[`../setup/cloudflare-access-admin.md`](../setup/cloudflare-access-admin.md)
に追記した。service-level BANは、保持期間、異議申立て、運用権限を決めるまで
未実装とする。

同日、Access認証済み管理画面と別ブラウザを使った利用者E2Eで次の6点を確認し、
すべてpassした。

1. 非ホストとして試験用roomへ入室できる。
2. 管理画面の参加者管理に接続中memberが表示される。
3. kickにより対象memberだけが切断される。
4. kickされたmemberは明示的に再入室できる。
5. 再入室したmemberへroom BANを適用できる。
6. BAN対象だけが再入室を拒否され、ホストと他memberの接続は維持される。

これにより、Access認証、active member取得、対象操作、対象stroke確定、
WebSocket切断、kick後の手動再入室、D1 / DO二重fenceによるroom BAN、
非対象connection維持までのpreview製品経路が成立した。

## Service emergency controls

2026-07-28に、サービス全体の新規room作成、新規入室、描画受付を独立して
停止・復旧できる緊急制御を実装した。

- D1 `service_controls`をauthoritativeなsingletonとし、revisionを単調増加する。
- `service_control_actions`へ管理者内部ID、指定値、理由、時刻、適用revisionを
  冪等に監査記録する。
- 管理画面はCloudflare Access保護下に置き、理由、確認、UUID idempotency keyを
  必須とする。
- 新しいroom作成とroom ticket発行はD1を毎回確認する。
- room DOの描画判定だけは最大5秒cacheし、Hibernation後に再読込する。
- 描画停止を検出したらactive strokeをserver生成endで確定する。
- 停止中のframeは`clientSeq`を進めて拒否し、再開後の遅延再送を防ぐ。
- 既存接続、閲覧、チャット、管理操作は継続する。

全体検査はRealtime 55、Snapshot 6、Web 38、Protocol 29 testsに加え、
rendererと測定toolを含めてpassした。D1 migration
`0014_service_controls.sql`をpreviewへ適用し、初期状態はrevision 0、
3項目すべてenabledであることをread-only queryで確認した。

preview:

- Realtime version:
  `e0af7604-dab9-4cab-9a7c-5b69ad3bf712`
- Web version:
  `9df865e9-25fc-419a-8c42-ea028641d614`
- D1 migrations: pending 0
- Realtime `/health`: HTTP 200
- Realtime `/health/room/main`: HTTP 200、schema version 25
- Web `/`: HTTP 200
- `/admin/rooms`（未認証）: HTTP 302

停止・確認・復旧手順は
[`../runbooks/emergency-mode.md`](../runbooks/emergency-mode.md)
へ記録した。利用者E2Eでは必ず最後に3項目をすべてenabledへ戻す。

初回利用者E2Eではroom作成と新規入室の停止・復旧がpassした一方、描画は
緊急制御の状態によらずgeneric rejectとなった。D1の描画制御をcold cacheから
読む外部I/O中に、同じWebSocketの`begin / append / end` handlerがinterleaveし、
後続frameが先にstroke lifecycleへ到達し得ることが原因だった。

同日、接続単位のin-memory Promise queueでWebSocket frame処理を直列化した。
これはHibernationで失われてもよい処理中だけのcoordination stateであり、
永続的な順序の正は引き続きDO SQLiteの`last_client_seq`とする。停止中の
3-frame burstと、許可中cold-cacheの`begin -> append -> end` burstを回帰試験へ
追加した。修正版配備後はRealtime `/health`と`/health/room/main`がHTTP 200、
D1はrevision 6、3項目すべてenabledであることをread-only確認した。
修正版のpreviewで利用者再E2Eを行い、次の3点がすべてpassした。

1. 通常状態で描画できる。
2. 描画受付停止中は「現在、緊急対応のため描画を一時停止しています。」と
   表示され、停止中の線が残らない。
3. 描画受付再開後に新しいstrokeを描ける。

先にpassしていたroom作成・新規入室の停止復旧と合わせ、3つの緊急制御すべてで
停止、利用者への安全な通知、影響範囲の分離、通常運用への復旧がpreview製品経路で
成立した。emergency modeのPhase 6利用者E2Eを完了とする。

## Actor rate abuse escalation

2026-07-28に、room内actor単位で描画とチャットのrate超過を合算し、
単発拒否、短時間mute、自動disconnectへ段階的に移行する制御を実装した。

- 10秒の判定窓内で3回超過すると5秒muteする。
- mute中の送信も違反へ数え、mute期限を延長する。
- 同じ判定窓で8回超過するとclose code 1008で対象接続だけを切断する。
- cursorのbest-effort dropは判定へ含めない。
- actor状態をDO SQLite schema v26へ保存し、Hibernation、再接続、
  connection ID変更でも判定を継続する。
- rate拒否した描画frameはclient sequenceを消費し、active strokeを
  server生成endで確定する。clientも対応するprovisional eventを破棄する。
- 自動room BANとservice-level BANは適用しない。
- `rate_limited`、`short_mute`、`abuse_disconnect`を累積し、
  mute / disconnect遷移だけを個人情報を含まない構造化warn logへ出す。

描画とチャットの既存token bucket、接続数上限20、frame / point / event上限は
維持した。全体検査はRealtime 56、Snapshot 6、Web 38、Protocol 29 testsに加え、
rendererと測定toolを含めてpassした。回帰試験ではchatとdrawingを組み合わせ、
短時間mute、追加違反による1008切断、再接続後の状態継続、判定窓終了後の復帰、
rate拒否した描画のackとoutbox破棄を確認した。

preview:

- Realtime version:
  `823dc684-5f4d-4e84-a36b-92ce11f7bcba`
- Web version:
  `fce1518a-0baf-4723-94c3-125f22184559`
- Realtime `/health`: HTTP 200
- Realtime `/health/room/main`: HTTP 200、schema version 26
- Web `/`: HTTP 200

設計、観測、閾値変更、preview利用者E2E手順は
[`../runbooks/rate-abuse-control.md`](../runbooks/rate-abuse-control.md)
へ記録した。この機能のために新しいCloudflare resource、binding、Secretは
追加していない。

同日、previewの試験用roomで利用者E2Eを行い、次の5点がすべてpassした。

1. 通常の描画とチャットが成功する。
2. 同じ参加者の短時間の連続チャットにrate超過表示が出る。
3. 連続超過後に短時間muteが成立する。
4. 6秒以上操作を止めると、新しいチャットと描画が成功する。
5. 別参加者の描画、チャット、接続には影響しない。

これにより、通常操作、rate超過通知、actor単位mute、時間経過による復帰、
他actorからの影響分離までのpreview製品経路が成立した。自動試験で確認済みの
1008 disconnect境界と合わせ、rate abuse controlのPhase 6利用者E2Eを完了とする。

## Runtime snapshot orphan deletion operator

2026-07-28に、inventoryから実削除へ進むためのlocalhost限定operatorを実装した。

- 通常Webが使う`RoomProvisioningService`と、削除権限を持つ
  `SnapshotOrphanOperatorService`を別entrypointへ分離した。
- 連続する2回以上の完了scanに残る候補だけを、1計画最大100件まで選ぶ。
- 計画はenvironment、source scan、key、room、reason、size、upload時刻、etagを
  固定し、SHA-256 plan hashと30分の期限を持つ。
- mode 0600のrepository外ファイルへ保存し、既存ファイルは上書きしない。
- 適用には`DELETE <plan-hash> <object-count>`の完全一致を要求する。
- 適用直前に再scanし、D1 / DO参照関係とR2 metadataを全件再検証する。
- 完全一致したkeyだけを削除し、R2 `head()`で非残存を確認する。
- D1監査表にはplan hashと集計、object keyのSHA-256 hashだけを保存し、
  生keyを複製しない。
- 計画改変、confirmation違い、期限切れ、環境違い、metadata変化は削除前に
  fail closedとなる。

D1 migration `0015_snapshot_orphan_deletions.sql`をpreviewへ適用し、
Realtime version `91653217-072c-40de-93b9-9150a91ec078`を配備した。
全体検査はRealtime 58、Snapshot 6、Web 38、Protocol 29 testsに加え、
rendererと測定toolを含めてpassした。

配備後の手動再scan:

- scan ID: `orphan_scan_c3edeaf7bb624ff6aace00c666387153`
- mature runtime snapshot: 10 object / 66,207 bytes
- `room_missing`: 10 object / 66,207 bytes
- `unreferenced`: 0
- 連続scan条件を満たす候補: 10
- deletion audit run: 0
- Realtime `/health`: HTTP 200
- Realtime `/health/room/main`: HTTP 200
- D1 migrations: pending 0

初回scanと同じ10件が2回目にも残り、旧preview試験roomの削除計画へ進める条件を
満たした。実削除は不可逆なので、R2削除は行わず利用者の明示承認を待つ。

同日、専用operatorで10件・66,207 bytesの承認用planをrepository外のmode 0600
ファイルへ生成した。plan作成時にもscanとR2 metadata確認がpassした。
全object keyの利用者確認後、plan hash、件数を含むconfirmationの完全一致で
明示承認された。

承認済みplanの適用結果:

- run ID: `orphan_delete_164b0f76fbbe4c3cbe5062fbab4151e6`
- verification scan ID: `orphan_scan_f14cb2f025e24d7eadd17ca239c31196`
- 計画対象: 10 object / 66,207 bytes
- 削除成功: 10 object / 66,207 bytes
- 既消失・skip: 0
- 適用後inventory: 0 object / 0 bytes
- `/health/orphan-snapshots`: HTTP 200
- Realtime `/health`: HTTP 200
- D1 audit: completed 1 run / deleted 10 item
- itemのobject key表現: 64文字SHA-256 hashのみ

適用時の再scan、D1 / DO参照関係、R2 size / upload時刻 / etagの照合、
削除後`head()`、最終scanがすべてpassした。承認用planファイルと専用一時directoryは
適用後に削除した。R2 objectは物理削除済みであり復元できない。これにより、
旧preview runtime snapshot孤児の検出、二重確認、承認、限定削除、監査、
正常health復帰までの運用経路が成立した。

## Rate abuse metrics baseline

2026-07-29に、closed betaの通常利用で暫定rate閾値を評価するための観測経路を
実装した。

- room cleanupのDO削除前に最終counterをD1へ冪等保存する。
- 生room IDではなくSHA-256 digestだけを30日保持する。
- actor、user、guest、chat本文、stroke payload、IPを保存しない。
- cleanup retryでは`cleanup_job_id`により同じ結果を再加算しない。
- scheduled maintenanceで30日超の終了counterを削除する。
- 専用`RateAbuseMetricsService`を通常Webから分離し、localhost operatorだけで
  稼働中roomと終了roomのcounterを取得する。
- baseline比較は継続、新規、期間中終了roomを重複なく合算する。
- 終了結果の欠落、counter後退、30日以上の比較は不完全として拒否する。

D1 migration `0016_rate_abuse_outcomes.sql`、capture / compare CLI、
cleanup failure / retry試験、digest非露出試験、30日retention試験を追加した。
観測値はrate閾値の自動変更には使わず、通常利用者の誤検知報告とfixture再現を
合わせて判断する。

preview:

- Realtime version:
  `8ef3cd36-440d-4efb-9742-9858f80833e6`
- D1 migrations: pending 0
- Realtime `/health`: HTTP 200
- 全体検査: Realtime 61、Snapshot 6、Web 38、Protocol 29 tests pass
- comparison unit tests: 2 pass

2026-07-29 00:16 JSTに最初のprivate baselineを取得した。

- live room: 2
- completed outcome: 0
- accepted drawing event累積: 4,026
- reject累積: 64
- rate limited / short mute / disconnect累積: 0 / 0 / 0
- 同一capture比較: `complete = true`

baselineはgitignoreした`reports/private/rate-abuse/`へmode 0600で保存した。
この時点ではrate abuseの通常利用signalが0であり、閾値変更の根拠はない。
現在値を維持し、30日以内のclosed beta通常利用後にcurrent captureを取得して
差分と利用者報告を評価する。
