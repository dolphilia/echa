# ADR 0009: roomはhostの準備完了後に自動開始する

日付: 2026-07-29  
状態: 採用  
supersedes: [ADR 0001](./0001-room-start.md)

## 判断

`waiting -> active`は、hostがroomへ接続し、event logまたはsnapshotからの復元と
client rendererの準備が完了した時点で自動的に遷移させる。利用者が開始ボタンを
押す操作は設けない。

participantまたはviewerの入室だけでは開始しない。既存のhost専用
`room.start` commandと、server側の`status = 'waiting'`を条件にした冪等な更新は
維持する。

## 理由

- room作成直後にhost自身が追加の開始操作をする必要がなくなる。
- 描画復元とrenderer準備の前に開始せず、描ける状態とactiveへの遷移を揃えられる。
- participantが先に入室してroomを開始させる荒らし経路を作らない。
- 既存のserver-side role検証と冪等な状態遷移を再利用できる。

## 実装への影響

- Web clientはhost、WebSocket接続済み、復元済み、renderer準備済み、
  lifecycleがwaitingという条件をすべて満たした場合に一度だけstart commandを送る。
- room作成直後は作成者の描画参加希望をclient sessionへ記録してからroomへ遷移し、
  参加方法の再選択を挟まずhost ticketを取得する。
- start command送信後に切断した場合は、再接続と復元の完了後に再試行できる。
- waiting中のdrawing/chat拒否、最大終了時刻、全員退出猶予は従来どおり維持する。
- host向けの手動開始ボタンは表示しない。
