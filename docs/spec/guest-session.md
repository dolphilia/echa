# Guest session and room ticket

更新日: 2026-07-27
状態: 実装前初稿

## Identityの分離

| identity | lifetime | purpose |
| --- | --- | --- |
| guest session | 暫定30日 | nickname/color再利用、abuse control |
| actor ID | room開催中 | presence、stroke、chat |
| user session | auth policy依存 | room作成、ownership |
| room ticket | 暫定60秒・1回 | WebSocket接続 |
| invite token | revokeまで | unlisted roomへの参加権 |

同じguest sessionでもroomごとに別actor IDを発行する。外部responseへservice横断guest IDを出さない。

## Guest cookie

推奨属性:

- HttpOnly
- Secure
- SameSite=Lax
- Path=/
- opaque random ID
- server-side session
- rotation可能

nicknameと参加色はserver-side sessionに関連づける。CSRFが必要な変更requestではSameSiteだけに依存せずtokenまたはOrigin検証を行う。

MVPではguestからaccountへ昇格しても、過去roomのactorや描画eventをuserへ移管しない。

## Public room

public slugは一覧・URL用識別子で、host権限を与えない。参加操作時にHTTP APIで短命room ticketへ交換する。

## Unlisted room

1. 招待tokenは192bit以上のrandom。
2. URL fragmentで受け取る。
3. client JSが明示的なHTTP POSTで交換する。
4. serverはtoken hash、失効、期限、room statusを確認。
5. 短命room ticketを返す。

fragmentはserver requestとRefererへ自動送信されない。交換後はhistory APIでfragmentを除去する。

## Room ticket

ticket claims:

- ticket ID / nonce
- room ID
- actor ID
- role
- guestまたはuser session IDへのbinding
- issued / expires
- protocol permission

rule:

- 暫定60秒
- 1 WebSocket接続だけ
- server-side nonce消費でreplay防止
- 再接続ごとに再発行
- 別session、別room、期限切れは拒否
- host roleはURL tokenではなくuser session + room ownershipから解決

署名方式は実装時に決める。opaque one-time tokenをD1/DOで消費する方式と、署名token + nonce storeを比較する。

## 入室フロー

1. GET room metadata。
2. guest nickname/colorを設定または再利用。
3. public slugまたはinvite tokenをPOST。
4. auth、room status、capacity、ban、rate limitを検証。
5. room内actor IDとticketを発行。
6. WebSocket upgrade時にticketを消費。
7. DOがconnection attachmentへactor/role/connection IDを保存。
8. welcomeでprotocol version、roomSeq、snapshot metadataを返す。

## 再接続

- clientは指数backoffにjitterを加える。
- HTTPで新ticketを取得。
- `lastRoomSeq`、cached snapshot metadata、last ack clientSeqを送る。
- room終了・suspended・banは再接続しない。
- 同じsessionの再入室は同じroom actorとして扱うが、同時connection policyは未決定。

## Abuse control

識別子を用途別に分ける。

- guest session: participant-level rate
- actor ID: room-level rate
- short-lived salted IP/UA-derived key: bot/ban補助
- user ID: logged-in enforcement

IPアドレスそのものを長期identityにしない。salt rotation、保持期間、利用目的を公開前に決める。

段階:

1. message reject
2. short mute
3. disconnect
4. room ban
5. service-level temporary ban

## Logging

記録しない:

- 生invite token
- room ticket
- auth cookie
- URL fragment
- IPアドレスの無期限保存

記録する:

- hashed/opaque IDs
- ticket reject reason
- rate limit bucket
- room ID内部参照
- request ID

## Account

MVPで必要:

- login/logout
- session
- room creation
- ownership/host復元

未決定:

- OAuth provider
- email認証
- Better Auth D1 adapter

これらは`docs/spikes/auth-d1.md`で成立性を確認する。
