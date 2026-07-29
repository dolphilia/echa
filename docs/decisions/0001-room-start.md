# ADR 0001: roomはhostが明示的に開始する

日付: 2026-07-27  
状態: 採用

## 判断

`waiting -> active`はhostの明示的な開始操作で遷移する。最初のparticipant入室では開始しない。

## 理由

- 作成から2時間の上限にwaiting時間も含めるため、意図しない自動開始を避けたい。
- hostが参加条件、viewer権限、themeを確認してから開始できる。
- 招待URLを先に共有し、参加者が揃うのを待てる。
- 荒らしが先に入室してroomを開始させる経路を作らない。

## 実装への影響

- waiting中は参加・presenceを許可するが、drawing/chat/stampの受付は開始設定に従って拒否する。
- hostだけがidempotentなstart commandを送れる。
- 最大終了時刻は既存仕様どおり`createdAt`を基準にする。
- hostが開始しなくても、全員退出猶予と最大時間でroomを終了できる。
