# Phase 4: room provisioning

実施日: 2026-07-28  
状態: 完了。local自動試験・preview deploy・認証済みE2E pass

## 成立した経路

```text
authenticated browser
  -> POST /api/rooms
  -> D1 rooms: pending
  -> private Service Binding
  -> RoomProvisioningService
  -> DrawingRoom Durable Object: room_metadata
  -> D1 rooms: ready
  -> /rooms/{publicSlug}
```

- ルーム作成はactiveなログインユーザーだけに許可する。
- ブラウザが生成したUUID v4を`Idempotency-Key`として要求する。
- 同じユーザー・同じキー・同じ入力の再送は、同じ内部room IDへ収束する。
- 同じキーを異なる入力へ再利用した場合は`409`で拒否する。
- D1登録後にDO初期化が失敗した場合は`failed`と安定したerror codeを残す。
- 再送時は新しいルームを増やさず、同じDOを冪等に初期化して`ready`へ戻す。
- 1ユーザーの開催中ルームは暫定3件までとし、D1の条件付きINSERTで判定する。
- public slugは128-bit random、内部room IDはUUIDとし、相互に分離する。
- WebからRealtimeへの初期化はpublic HTTPではなく、named Worker
  entrypointへのService Bindingを使う。

Service Bindingの境界では`@koge/protocol`の
`RoomProvisioningRequest` / `RoomProvisioningResult`を両Workerで検証する。
Durable Objectは`getByName(internalRoomId)`で一意に取得し、初回だけ
`room_metadata`を保存する。再初期化時にmetadataが異なる場合は失敗させる。

## D1 migration

`0004_room_provisioning.sql`をlocalとpreviewへ適用した。

- `create_request_id`
- `provisioning_attempts`
- `provisioning_error_code`
- `provisioning_updated_at`
- `(owner_user_id, create_request_id)` unique partial index
- provisioning retry index

## UI

- ログイン済みホームでルーム作成フォームを有効化した。
- 現段階のUIとAPIはpublic roomだけを作成する。
- unlistedはinvite token交換がない状態で作成不能にならないよう、Phase 5まで
  APIでも拒否する。
- 同じ入力の通信再試行では同じ冪等キーを使い、入力変更時は新しいキーへ切り替える。
- 作成成功後はレスポンスの`Location`に従ってルーム画面へ移動する。
- 再ログイン後はsession user IDから開催中の所有ルームを復元し、
  公開一覧へ「あなたのルーム」と表示する。
- unlisted roomのinvite token交換はPhase 5で実装する。

## 検証

- protocol Vitest: 15 tests pass
- realtime Workers Vitest: 23 tests pass
- web Workers Vitest: 17 tests pass
- protocol / realtime / web TypeScript: pass
- Oxlint: pass
- Realtime Worker dry-run build: pass
- Web vinext production build: pass
- 失敗注入:
  - 初回DO初期化失敗でD1が`failed`、attempt 1になる
  - 同じキーの再送で同じroom IDが`ready`、attempt 2になる
- preview migration `0004`: pass
- preview Realtime version:
  `bd158874-5986-44d6-a3e4-84e0eee06bb1`
- preview Web version:
  `3e58ed39-71ca-4537-a113-2f55fdb438eb`
- preview Realtime `/health`: `200`
- preview room list: `200`
- preview guest room creation: `401`

## 利用者E2E

2026-07-28に利用者の既存Google sessionで次を確認し、すべてpassした。

1. public roomを1件作成
2. `/rooms/{publicSlug}`へ移動
3. `/`へ戻り、カードに「あなたのルーム」が表示
4. logout / login後も所有表示を復元

公開一覧へ1件が表示され、参加待ち、人数、所有者表示も正常だった。
これによりPhase 4のpublic room作成とownership復元経路を完了とする。
