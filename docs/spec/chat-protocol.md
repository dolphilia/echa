# Chat protocol

更新日: 2026-07-29  
状態: production製品経路を実装し、別browser利用者E2E済み

## 境界

- chatはWebSocketのJSON text frameを使う。
- drawingのMessagePack frame、drawing `roomSeq`、event log、snapshotから分離する。
- 本文やactor IDを通常logへ出さない。
- chat本文はHTMLとして解釈せず、clientではtext nodeとして表示する。

## Client message

```ts
{
  v: 1;
  type: "chat.send";
  id: string;
  text: string;
}
```

- `id`: client生成、`[A-Za-z0-9_-]{8,128}`、room内でunique
- `text`: trim後1〜500 Unicode code points（暫定）
- 同じ`id`の再送は`DUPLICATE`で拒否する。

## Server message

接続中の追加メッセージ:

```ts
{
  type: "chat.message";
  message: {
    id: string;
    seq: number;
    actor: string;
    role: "host" | "participant" | "viewer";
    text: string;
    createdAt: number;
  };
}
```

接続復帰時は、有効な履歴が1件以上ある場合だけ`chat.history`を`ready`より前に
送信する。`messages`は`seq`昇順、最大100件とする。

## 権限

| role | receive | send |
| --- | --- | --- |
| host | allow | allow |
| participant | allow | allow |
| viewer | allow | `viewer_chat_enabled = true`の場合だけallow |

権限はclient表示だけに依存せず、room DOの`room_metadata`で検証する。
無効なviewer送信は`ROLE_FORBIDDEN`を返す。

## 保持

- room DO SQLiteの`chat_messages`へ保存する。
- 暫定で最新100件か24時間の早い方だけを復帰・配信対象にする。
- 新規送信時と接続時に期限切れを削除する。
- room終了時はroom runtime dataとともに削除し、再入室・長期閲覧へ残さない。
- chatはsnapshotへ含めない。

## Rate limit

- 1 connectionにつき暫定2件/秒、burst 5
- drawing/cursorと別の永続token bucket
- 超過時は黙って破棄せず`RATE_LIMITED`を返す。
- Hibernation後もSQLiteのtoken stateから継続する。
- drawing/chatのrate超過はroom actor単位の段階制御へ合算する。
- 10秒内3回で5秒mute、8回でconnectionを1008切断する。
- mute中のchatは保存・配信せず、自動room BANは行わない。

## Activity

受理されたchatはroom lifecycleの`last_activity_at`を更新し、idle中なら
activeへ戻す。presenceとcursorは活動へ含めない。waiting中のchatは
`ROOM_NOT_ACTIVE`で拒否する。

## 暫定値の見直し

500文字、2件/秒・burst 5、100件、24時間はMVP初期値である。preview利用者E2E、
負荷試験、荒らし対策の観測結果で変更する。定数は`PROTOCOL_LIMITS`に集約する。
