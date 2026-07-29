# Phase 5: room ticket and unlisted invite foundation

実施日: 2026-07-28  
状態: 基盤完了。presence/cursor/chat preview自動スモークpass、
Phase 5全体は継続中

## 成立した経路

```text
browser
  -> POST /api/rooms/{publicSlug}/tickets
  -> Better Auth user session または HttpOnly guest session
  -> D1 room_memberships（room別の安定actor）
  -> private Service Binding
  -> DrawingRoom DO room_tickets（token hashのみ）
  -> wss://realtime-preview.koge.app/rooms/{publicSlug}/connect?ticket=...
  -> transactionでsingle-use消費
  -> role付きWebSocket attachment
```

## 実装した境界

- guest cookieは256-bit random、HttpOnly、Secure、SameSite=Lax、暫定30日。
- D1にはcookie tokenのSHA-256だけを保存する。
- user/guestのサービス内部identityとroom actorを分離する。
- ownerはserver-side ownershipからhost、その他はparticipant/viewerで解決する。
- room ticketは256-bit opaque token、暫定60秒、1接続だけに使用できる。
- 生ticketはD1/DOへ保存せず、DO SQLiteへhashとclaimsだけを登録する。
- previewの公開Realtime routeはraw actor/connection queryを拒否する。
- viewerからのdrawing frameは`ROLE_FORBIDDEN`で拒否する。
- room入室時にparticipant / viewerを選択し、割り当て済みroleをheaderへ表示する。
- viewerはbrush / eraser / size / opacity / colorをclient側でも無効化し、
  pan / zoom / eyedropperは利用できる。
- guest participant / viewerは同じroom actorを維持したまま切り替えられる。
- role選択はsessionStorageへ保存し、reload時に新ticketで自動復帰する。
- ownerはclientのrequested roleにかかわらずhostへ補正する。
- 同一actorは1接続とし、新ticket接続で旧接続を置換する。
- room終了時に未使用・使用済みticketを削除する。
- Originをticket発行APIとWebSocket upgradeの両方で検証する。
- unlisted room作成時にbrowserで256-bit invite tokenを生成し、D1には
  SHA-256だけを保存する。
- roomとinvite hashはD1 batch transactionで同時に作成する。
- 生invite tokenはURL fragmentで渡し、sessionStorageへ退避後に
  history APIでaddress barから除去する。
- ownerは招待token不要、その他のsubjectは有効・未失効tokenが必要。
- invite tokenはroom終了・失効までリンク共有に再利用でき、交換後の
  room ticketだけが60秒・single useである。
- presenceは接続中WebSocket attachmentから再構成し、event logへ保存しない。
- participant / viewerのremote cursorを最大20Hzで表示する。
- cursorはdrawingと独立した20/s・burst 30のtoken bucketで制限し、超過時も
  drawing経路を止めずbest effortで破棄する。
- cursor座標はevent log、snapshot、idle activityへ含めない。

local環境だけは既存の同期試験と開発用にraw actor/connection経路を残した。

## D1 / DO schema

- D1 migration `0005_guest_room_access.sql`
  - `guest_sessions`
  - `room_memberships`
- D1 migration `0006_room_invites.sql`
  - `room_invites`
- DrawingRoom schema version 19
  - `room_tickets`
  - `connections.role`
  - `connections.session_binding_hash`
  - `connections.cursor_rate_tokens`
  - `connections.cursor_rate_updated_at`
  - `chat_messages`
  - `connections.chat_rate_tokens`
  - `connections.chat_rate_updated_at`

## 検証

- Protocol TypeScript / Realtime TypeScript / Web TypeScript: pass
- Oxlint: pass
- Protocol Vitest: 20 tests pass
- Realtime Workers Vitest: 27 tests pass
- Web Workers Vitest: 22 tests pass
- Web production build: pass
- preview D1 migration `0005`: pass
- preview D1 migration `0006`: pass
- preview Realtime `/health`: `200`
- preview Web `/`: `200`
- preview smoke:
  - guest viewer ticket発行: pass
  - WebSocket upgrade: `101`
  - 同じticketの再利用: `401`
  - guest cookieで新ticket発行: pass
  - 短時間切断後の新ticket接続: `101`
  - 復帰前後のactor ID一致: pass
  - 復帰時のconnection ID更新: pass
  - guest viewer接続: brush disabled、`同期中`
  - viewerからguest participantへのrole切替: brush enabled、`同期中`
  - reload: role pickerを再表示せず同じparticipant roleで復帰
  - browser console error: 0
  - 2 guest presence: pass
  - viewer cursor broadcast: pass
  - guest退出後のpresence更新: pass
  - participant chat broadcast: pass
  - viewer chat receive: pass
  - viewer chat send reject: pass
  - chat reconnect history: pass
- preview browser:
  - viewer chat履歴表示: pass
  - viewer chat入力無効表示: pass
  - browser console error: 0

## 利用者E2E

2026-07-28に所有者アカウントで次を確認し、すべてpassした。

1. 所有ルームへ入室
2. 「描く人として参加」を選択
3. headerに「ホスト」と表示
4. 描画が正常に同期
5. reload後もhostとして正常に復帰

これによりhost、guest participant、viewerの3 roleについて、server-side
role判定、client権限制御、preview実接続を確認できた。

同日、unlisted roomについても次を確認し、すべてpassした。

1. 「招待リンク限定」でroomを作成
2. 公開room一覧へ掲載されない
3. コピーした招待リンクを別browser sessionで開き、正常に入室
4. reload後も同じroomへ正常に復帰

これにより、256-bit invite tokenのbrowser生成、D1へのhash保存、URL
fragment受取、短命room ticket交換、guest sessionに紐づくactor復元までの
preview製品経路が成立した。

同日、presenceとremote cursorについても別browser sessionを使って次を確認し、
すべてpassした。

1. 同じroomへ2接続するとheaderの接続人数が更新される
2. participantのremote cursorが相手側へ表示される
3. viewerのremote cursorも相手側へ表示される
4. 一方が退出すると接続人数が減る

これにより、非永続presence、viewerを含むbest-effort cursor配信、
clientのremote cursor描画、退出時のpresence再構成までのpreview製品経路が
成立した。

同日、chatについても別browser sessionを使って次を確認し、すべてpassした。

1. participantからchatを送信する
2. 別browser側に同じchatが表示される

これにより、実browser間のchat送信、DO SQLiteへの受理、WebSocket broadcast、
client表示までのpreview製品経路が成立した。

preview version:

- Realtime: `3da2c188-3de9-45fe-9095-8f38da7c4d75`
- Web: `16dac5d5-55b6-4423-95b3-0f8a01fc4270`
- Web（unlisted invite反映後）: `6b33000d-2870-4e16-9a43-340ce6af10db`
- Realtime（presence/cursor反映後）:
  `3c384069-e2af-4efc-8e4d-1aa9a31d94da`
- Web（presence/cursor反映後）:
  `7efd5094-5b59-4f3a-a601-cea725fbe794`
- Realtime（chat反映後）:
  `660a7b7c-47b8-4f33-9c62-bdd83de94bc7`
- Web（chat反映後）:
  `37cf8f9c-40ff-4f18-a77f-b23742ccb773`

## スモークツール

```bash
npm run smoke:room-ticket -- \
  --app-origin https://preview.koge.app \
  --realtime-origin https://realtime-preview.koge.app \
  --room <32-character-public-slug>
```

token、cookie、内部guest IDは出力しない。

```bash
npm run smoke:presence-cursor -- \
  --app-origin https://preview.koge.app \
  --realtime-origin https://realtime-preview.koge.app \
  --room <32-character-public-slug>
```

chat反映後:

```bash
npm run smoke:chat -- \
  --app-origin https://preview.koge.app \
  --realtime-origin https://realtime-preview.koge.app \
  --room <32-character-public-slug>
```

## 次の作業

- 失効・rotation UIとrate limitをPhase 6のabuse controlへ接続する。
- lifecycleのhost開始とactive / idleをpreview利用者E2Eで確認する。
- presenceへ表示名・参加カラーを追加する前に公開範囲を確定する。
