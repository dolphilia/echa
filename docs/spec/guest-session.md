# Guest session and room ticket

更新日: 2026-07-29
状態: public / unlisted roomのguest session、room actor、single-use ticketを
productionへ反映済み。guest viewer限定はlocal自動・画面テスト済み、
preview利用者E2E待ち。abuse controlも実装済み

## Identityの分離

| identity | lifetime | purpose |
| --- | --- | --- |
| guest session | 暫定30日 | viewer再入室、abuse control |
| actor ID | room開催中 | presence、stroke、chat |
| user session | auth policy依存 | room作成、ownership、描画、chat送信 |
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

1. room作成clientが256bitの招待tokenを生成する。
2. URL fragmentで受け取る。
3. client JSが明示的なHTTP POSTで交換する。
4. serverはtoken hash、失効、期限、room statusを確認。
5. 短命room ticketを返す。

作成APIは生tokenを保存せず、SHA-256だけをD1へ保存する。tokenをclient側で
先に生成し、同じidempotency keyの再試行では同じtokenを送るため、serverが
生tokenを復元する必要はない。招待tokenはroom終了・失効まで再利用できる
bearer invitationであり、WebSocket用room ticketだけがsingle useである。

fragmentはserver requestとRefererへ自動送信されない。受取clientは
sessionStorageへ一時保存し、history APIでfragmentを除去する。招待リンクの
コピー操作ではsessionStorageのtokenからfragment付きURLを再構築する。

## Room ticket

ticket claims:

- ticket ID / nonce
- room ID
- actor ID
- role
- chat送信可否
- serverで検証した表示名・avatar URL
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

MVPのpublic room経路はopaque one-time token方式を採用する。Web Workerが
認証済みuser sessionまたはHttpOnly guest sessionを検証し、private Service
Binding経由でroom DOへtoken hashとclaimsを登録する。ブラウザへ返す生tokenは
DO SQLiteにもD1にも保存しない。WebSocket upgrade時にDO内transactionで
`consumed_at`を設定し、同じtokenの再利用を拒否する。

`session_binding_hash`はticketを発行した内部subjectとの関連をDO内へ記録する。
WebSocket側へ認証cookieを共有する方式ではないため、現在の防御境界は
同一Originの発行API、60秒TTL、256-bit token、single useである。

## 入室フロー

1. GET room metadata。
2. user sessionまたはguest sessionを検証する。
3. public slugまたはinvite tokenをPOST。
4. auth、room status、capacity、ban、rate limitを検証。
5. room内actor IDとticketを発行。
6. WebSocket upgrade時にticketを消費。
7. DOがconnection attachmentへactor/role/connection ID/chat送信権限/
   server由来プロフィールを保存。
8. welcomeでprotocol version、roomSeq、snapshot metadataを返す。

## 再接続

- clientは指数backoffにjitterを加える。
- HTTPで新ticketを取得。
- `lastRoomSeq`、cached snapshot metadata、last ack clientSeqを送る。
- room終了・suspended・room banは再接続しない。kick通知時もその接続では
  自動再接続せず、利用者が明示的に再入室した場合だけ新ticketを発行する。
- 同じsessionの再入室は同じroom actorとして扱う。
- 同じactorの同時connectionは1つとし、新しいticket接続を優先して旧接続を
  `connection replaced`で閉じる。再接続競合と複数tabは同じ規則にする。
- activeなログインユーザーはpublic roomでparticipant / viewerを入室時に選ぶ。
  選択はtab sessionへ保存し、reload時の新ticketにも使う。
- guestはviewerだけを選択でき、participant ticket要求はserverで拒否する。
- 非owner userは新ticket発行時にparticipant / viewerを変更できる。ownerは
  requested roleにかかわらず常にhostとして解決する。
- activeなログインユーザーは全roleでchatを送信でき、guest viewerは受信だけ
  許可する。

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

drawing / chatはroom actor単位の違反を合算し、短時間mute後も反復した場合は
connectionを切断する。room BANと期限付きservice BANはserver側でticket発行と
稼働中connectionの両方へ適用し、管理画面から監査・解除できる。

1〜3は2026-07-28に実装した。drawing/chatのrate超過をroom actor単位で合算し、
10秒内3回で5秒mute、8回でdisconnectする。状態はDO SQLiteへ保存するため、
guest/userのどちらもconnection IDの交換だけでは回避できない。room banは
管理者判断とする。service-level temporary banも管理者判断だけで適用し、
24時間、7日、30日の期限付きで同じguest / user subjectの全room ticketを拒否する。
guestはcookie削除でsubjectを更新できるため、IPを長期BAN identityとして保存せず、
rate limit、room BAN、通報、emergency controlを組み合わせる。

管理者kickは現在のactorの全connectionを直ちに閉じるが、D1の入室権限は
変更しない。room banは現在のconnectionを閉じ、対象roomの終了時刻まで
同じuser / guest subjectへのticket発行を拒否する。ホストはkick / room banの
対象外とし、問題のあるホストを止める場合はroom suspend / closeを使う。
service BANはホストにも適用でき、現在connectionを閉じて以後のroom作成・入室を
拒否する。

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

実装済み:

- Better Auth + D1 adapter
- Google OAuth
- account statusを含むsession検証

email認証はMVPの必須経路に含めない。
