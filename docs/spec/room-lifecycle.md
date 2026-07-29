# Room lifecycle

更新日: 2026-07-29
状態: waiting / active / idle、活動量soft close、closing fence、
通常終了cleanup、証跡生成・期限削除をproductionへ実装・E2E済み

## 状態

MVPの永続状態:

- `waiting`: 作成済み、参加待ち
- `active`: 描画・チャット受付中
- `idle`: 接続者はいるが最終描画・チャットから30分経過
- `closing`: 新規操作停止、stroke終端処理・証跡・cleanup中
- `suspended`: 管理停止または証跡保全失敗

`deleted`は保存状態ではなく、物理削除完了を表す概念上の終端。`draft`と`archived`はMVPで使用しない。

## 状態遷移

```text
create -> waiting -> active <-> idle
                     |  |        |
                     |  +--------+
                     v
                  closing -> deleted
                     |
                     v
                 suspended
                     |
                     +-> closing -> deleted

waiting -> closing
waiting/active/idle -> suspended
```

許可していない遷移はserverで拒否する。状態変更には理由、server時刻、actorまたはsystem reasonを記録する。

管理者suspendは進行中strokeをserver生成endで確定し、room ticket、
snapshot read ticket、期限task、snapshot自動処理を停止してから
`room.updated(suspended)`を配信し、WebSocketを閉じる。通常cleanupは開始せず、
管理確認中のevent、chat、runtime snapshotをDOに保持する。再入室は拒否する。
管理者closeはwaiting / active / idleに加えてsuspendedからもclosingへ進め、
既存の証跡fenceと通常cleanupを再利用する。

`waiting -> active`はhostの明示開始で遷移する。入室、presence、cursorでは
開始しない。waiting中は入室とpresence/cursorを許可する一方、drawing/chatは
`ROOM_NOT_ACTIVE`で拒否する。

## 終了条件

| condition | 初期値 | action |
| --- | ---: | --- |
| host明示終了 | 即時 | closing |
| 全接続退出 | 10分猶予 | closing |
| 作成から最大時間 | 2時間 | closing |
| drawing event | 93,000件 | 新規stroke停止、drain後closing |
| drawing payload | 56MiB | 新規stroke停止、drain後closing |
| 管理者強制終了 | 即時 | suspendedまたはclosing |

時間予告は15分、5分、1分前。活動量予告はsoft limitに対する80%、90%、98%。

最大時間は`createdAt`から測るため、waiting時間も含む。

## idleとHibernation

- idleへの遷移は、接続者が1人以上いる状態で描画・チャットが30分ない場合。
- cursorとpresence更新だけでは活動時刻を更新しない。
- 受理済みdrawing eventとchat messageを活動として扱う。
- stampは未実装。導入時は受理済みstampを活動へ含める。
- 全員退出はidleへ遷移せず、独立した10分タイマーを開始する。
- 再入室で全員退出タイマーを解除する。
- Durable Object WebSocket Hibernationはインフラ状態であり、room状態とは独立。

DOはalarmを1つだけ持つため、`scheduled_tasks`から最も早いdue timeを選んでalarmを設定し、実行後に次を再設定する。

2026-07-28時点で`scheduled_tasks`へ`idle_timeout`、`empty_timeout`、
`max_duration`を実装した。最後の接続が閉じるとidle taskを解除して10分の
empty taskを設定し、再入室で取り消す。最大時間はwaiting時間を含む
`maxEndsAt`を初期化時に登録する。期限到達時は決定的なclose request IDで
既存closing fenceへ進み、D1一覧projectionもclosingへ更新する。
idle中にdrawing/chatが受理された場合はactiveへ戻す。

最大時間の15分、5分、1分前には`room.time`を全clientへ配信する。
通知段階はDO SQLiteの`room_time_limit.warning_stage`へ永続化する。
alarmが遅れて復帰した場合は、現在の残り時間に対応する最新段階だけを通知して
古くなった予告を連続送信しない。再接続clientには最後に到達した段階と、
その時点の残り時間を再送する。各予告時刻は独立したtask行を作らず、
`max_duration`の期限と通知段階から次のalarm時刻を導出する。

## soft close

1. hard limit 100,000 events / 64MiBから、進行中strokeを終端するための
   7,000 events / 8MiBを予約し、soft limitを93,000 events / 56MiBとする。
2. soft limitの80%、90%、98%で全clientへ終了予告と残量を通知。
3. activity counterがsoft limitへ到達。
4. 新しい`stroke.begin`を拒否。
5. 開始済みstrokeのappend/end/cancel/timeoutだけを受理。
6. 未完了strokeが0になったらclosingへ遷移。
7. lifecycle用の独立予約領域からclosing/closed eventを配信。

event予約は20 actor ×（最大4,095追加point ÷ 12 points/appendの切り上げ
＋end）= 6,860 eventsを上回る7,000とする。payload予約は対応するbounded
MessagePack frameを収める8MiBとする。

2026-07-28に`room.activity`、DO SQLite `room_activity_limit`、段階警告、
新規begin停止、進行中strokeのdrain、`activity_limit` closingを実装し、
previewへ配備した。hard limitへ先に達した異常時はserver生成endで即時closingする。
最大時間の15分、5分、1分前通知も2026-07-28に実装した。

## closing順序

1. room stateをclosingへ永続化。
2. `room.updated(status: closing)`を配信。
3. 新規入室、begin、chat、stampを拒否。
4. 開始済みstrokeを確定または破棄。
5. reportまたは管理指定があれば証跡bundleを作成。
6. `room.closed`を配信してWebSocketを閉じる。
7. 一覧から除外。
8. D1へcleanup job IDを記録し、R2 snapshot keyを専用Queueへ登録。
9. R2 snapshotを削除する。
10. DO SQLiteのevent、chat、snapshot manifest、runtime stateを`deleteAll()`する。
11. 最後にD1のrooms、memberships、invitesを削除する。

D1 room行を最後までcoordination fenceとして残す。Queueが重複配信された場合、
D1行がなければ完了済みとしてackする。DO削除後・D1削除前に停止した場合は、
同じjob IDを確認して再生成された空DOも再削除し、D1削除まで進める。

終了後は再入室、閲覧専用化、再開をしない。

### 現行の終了フェンスと通常cleanup

2026-07-28時点で、DO SQLiteへの`closing`永続化、active strokeのserver確定、
queued snapshot jobのsupersede、snapshot read ticket失効、compaction停止、
`room.updated(closing)`通知、WebSocket切断、新規接続の410拒否を実装した。
全員退出10分と作成から2時間のalarmもこのfenceへ接続し、closing開始時に
D1一覧projectionを除外状態へ更新する。
hostはroom ticketで確定したhost roleから`room.close`を送信できる。
participant/viewerからの同commandは`ROLE_FORBIDDEN`で拒否し、client UIでは
不可逆操作の確認後にだけ送信する。
snapshot Workerはjob開始時とmanifest commit時に終了フェンスを確認する。

同日に非公開Service Binding経由のadmin suspend / close、D1監査記録、
操作IDによる冪等化を実装した。2026-07-28に公開管理APIと管理画面をpreviewへ
配備し、Cloudflare Access JWTをWorkerでもRS256署名、issuer、audience、
exp / nbfまで検証する。JWTの生emailと生`sub`はD1へ保存しない。

close結果はcommit済みmanifestと全jobから導出したstaging object keyをcleanup候補
として返す。2026-07-28に`room.closed`、cleanup Queue、D1 job fence、
R2削除、DO `deleteAll()`、D1 cascade削除を実装した。Queue投入失敗はDO alarmで
10秒後に再送し、consumer失敗は30秒遅延・最大5回の後にDLQへ送る。
通常終了ではroom/event/chat/runtime snapshotを保存しない。詳細は
[`../results/phase3-room-close-snapshot-fence.md`](../results/phase3-room-close-snapshot-fence.md)。

2026-07-28に`reports`、`evidence_manifests`、`moderation_actions`の最小D1
schemaと削除防止fenceを追加した。未解決reportに紐づくevidence manifestが
`committed`でない場合、cleanup consumerは元dataを削除せず再試行する。
同日にreport受付、専用Queue/DLQ、DOで固定したsnapshot + tail event、
chat/metadata/membershipをR2 componentとmanifestへ保存する処理を追加した。
commit後はclosing roomのcleanup Queueを再起動する。期限到達時の削除は
日次scan、同じ専用Queue、evidence固有R2 prefix、D1 job fenceで冪等に行う。

## 証跡保全

通常終了では何も長期保存しない。次の場合だけ期限付き証跡を作る。

- room終了前に未解決reportがある。
- 管理者が保全を指定した。
- suspended理由がmoderationである。

証跡候補:

- 必要範囲のdrawing eventsとsnapshot
- report対象前後のchat
- room metadataの最小copy
- room内actor IDと対応する内部session参照
- moderation action
- hash、作成時刻、保持期限

証跡保存に失敗した場合、roomをsuspendedまたはclosingのまま操作不能にし、Alarm/Queueで再試行する。元eventとsnapshotは成功まで削除しない。例外削除には管理者権限と監査記録が必要。

MVPの暫定保持期間は30日とし、Web Workerの非secret設定で変更可能にする。
これは公開時の最終決定ではない。

## snapshot mode

roomごとに次を持つ。

- `event_log_only`
- `shadow`
- `snapshot_compacted`

遷移は前方向だけ。`snapshot_compacted`は全logがないため、global feature flagを切ってもroom終了まではsnapshot + tailで動かす。

## 次のroom

時間・活動量終了時、削除前に次をclientへ返す。

- room name
- visibility
- viewer chat/stamp settings

hostはログインsessionで新しいroomを作る。旧room IDやeventは引き継がず、canvasは白紙。

## 冪等性

- close requestには`closeRequestId`を付ける。
- closing以降の重複closeは同じ結果を返す。
- evidence job、snapshot cleanup、D1 cleanupはjob IDで重複排除する。
- 外部I/O中にDO requestを長時間blockしない。

## 未決定

- report証跡の保持期間
- room closed時のWebSocket close code
- DLQ alert、再投入、破棄の運用手順
