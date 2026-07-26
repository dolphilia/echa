# Room lifecycle

更新日: 2026-07-27
状態: 実装前初稿

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

`waiting -> active`をhostの明示開始にするか、最初のparticipant入室にするかは未決定。MVP UIと合わせて実装計画前に決める。

## 終了条件

| condition | 初期値 | action |
| --- | ---: | --- |
| host明示終了 | 即時 | closing |
| 全接続退出 | 10分猶予 | closing |
| 作成から最大時間 | 2時間 | closing |
| drawing event | 100,000件 | soft close経由 |
| drawing payload | 64MiB | soft close経由 |
| 管理者強制終了 | 即時 | suspendedまたはclosing |

時間予告は15分、5分、1分前。活動量予告は80%、90%、98%。

最大時間は`createdAt`から測るため、waiting時間も含む。

## idleとHibernation

- idleへの遷移は、接続者が1人以上いる状態で描画・チャットが30分ない場合。
- cursorとpresence更新だけでは活動時刻を更新しない。
- chat messageとstampを活動として扱うかは初期実装で統一し、推奨は両方を活動に含める。
- 全員退出はidleへ遷移せず、独立した10分タイマーを開始する。
- 再入室で全員退出タイマーを解除する。
- Durable Object WebSocket Hibernationはインフラ状態であり、room状態とは独立。

DOはalarmを1つだけ持つため、`scheduled_tasks`から最も早いdue timeを選んでalarmを設定し、実行後に次を再設定する。

## soft close

1. activity counterがsoft thresholdへ到達。
2. 全clientへ終了予告、hostへ残量を通知。
3. 新しい`stroke.begin`を拒否。
4. 開始済みstrokeのend/cancel/timeoutだけを受理。
5. 未完了strokeが0になったらclosingへ遷移。
6. lifecycle用の独立予約領域からclosing/closed eventを配信。

予約量は、最大同時描画actor数、points/stroke、frame上限から計算し、固定の推測値にしない。

## closing順序

1. room stateをclosingへ永続化。
2. `room.updated(status: closing)`を配信。
3. 新規入室、begin、chat、stampを拒否。
4. 開始済みstrokeを確定または破棄。
5. reportまたは管理指定があれば証跡bundleを作成。
6. `room.closed`を配信してWebSocketを閉じる。
7. 一覧から除外。
8. R2 snapshot keyをcleanup taskへ登録。
9. DO SQLiteのevent、chat、snapshot manifest、runtime stateを削除。
10. D1のrooms、memberships、invitesを削除。
11. R2 snapshot削除を冪等に再試行。

終了後は再入室、閲覧専用化、再開をしない。

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

- waitingからactiveへ移る条件
- idleでstampを活動に含める最終判断
- report証跡の保持期間
- cleanup retry上限とDLQ運用
- room closed時のWebSocket close code
