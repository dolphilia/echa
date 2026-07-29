# ADR 0010: 描画とチャット送信はログインユーザーに限定する

日付: 2026-07-29  
状態: 採用

## 判断

ルームの閲覧はguestにも許可するが、`participant`の選択と描画、チャット送信は
activeなログインユーザーだけに許可する。ログインユーザーはroom roleが`host`、
`participant`、`viewer`のいずれでもチャットへ参加できる。

チャット送信権限はroleから導出せず、Web serverが発行する短命な接続ticketへ
`canChat`として固定する。チャットに表示する名前とavatar URLも、client入力ではなく
serverがactiveなユーザープロフィールからticketへ設定する。

## 理由

- 閲覧だけの利用者もログインしていれば会話へ参加できる。
- guestの描画・チャット送信を止め、荒らし対策をアカウント単位で適用しやすくする。
- viewerという表示・描画roleと、チャットへの参加可否を混同しない。
- 名前とavatarのなりすましを防ぎ、プロフィール変更後の再接続で表示を更新できる。

## 実装への影響

- 入室UIは未ログイン時に「見る人」だけを提示する。
- serverはguestからの`participant` ticket要求を拒否する。
- ログイン済みviewerのticketには`canChat = true`を設定する。
- guest viewerのticketには`canChat = false`を設定し、受信だけ許可する。
- room DOは接続ごとの`canChat`を検証し、roleだけでは送信を許可しない。
- chat messageにはserver由来の`displayName`と`avatarUrl`を保存・配信する。
- rolling deploy中の旧ticketと旧messageを読めるよう、新fieldはprotocol上optionalとする。
