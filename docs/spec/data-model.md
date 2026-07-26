# Data model

更新日: 2026-07-27
状態: 論理schema初稿。migrationではない

## 原則

- D1: 検索・認証・運用に必要な通常データ
- 1 room = 1 SQLite-backed Durable Object
- DO SQLite: roomのauthoritative runtime stateと短期event
- R2: 採用時のsnapshot、期限付きmoderation evidence
- client: UI設定と短期送信・復帰buffer
- gallery用テーブルと完成画像はMVPに作らない

## ID

| name | scope | exposure |
| --- | --- | --- |
| `userId` | service | 原則内部 |
| `guestSessionId` | browser | cookieのみ |
| `roomId` | service / DO routing | URLへ出さない |
| `roomSlug` | public URL | 128bit以上random |
| invite token | unlisted URL fragment | 192bit以上、serverはhash |
| `roomTicket` | 1 WebSocket接続 | 60秒、single use |
| `actorId` | room | roomごとに発行 |
| `strokeId` | room | client生成128bit以上 |

## D1

### `users`

- `id` primary key
- Better Authが必要とするidentity fields
- MVP表示名の最小属性
- `created_at`, `updated_at`

詳細プロフィールは別機能導入時に`user_profiles`を追加する。

### `rooms`

- `id`
- `public_slug` unique
- `owner_user_id`
- `name`, `theme`, `visibility`
- `status`
- participant/viewer limits
- viewer chat/stamp settings
- `created_at`, `starts_at`, `max_ends_at`
- DO routingに必要な参照

statusと人数は一覧用projectionであり、runtimeの正はroom DOとする。終了時に物理削除し、復旧backup対象にしない。

### `room_memberships`

- `room_id`
- `actor_id`
- nullable `user_id`
- role
- joined/last seen

guestのservice横断IDを公開しない。終了時削除。

### `room_invites`

- `id`, `room_id`
- token hash
- created/expires/revoked
- created by

生tokenを保存しない。

### `reports`

- `id`
- NOT NULLだがforeign key constraintを持たない`source_room_id`
- reporter内部identity
- target actor/message/stroke参照
- reason/status
- room metadataの最小copy
- evidence manifest ID
- created/resolved/retention expiry

room削除でcascadeしない。

### `moderation_actions`

- `id`
- source room ID
- admin ID
- action type
- target internal identity
- reason
- created_at

### `bans`

- scope
- user / guest session hash / short-lived network abuse key
- starts/expires
- reasonとaction ID

保持期間は公開前に決める。

## DO SQLite

概念DDL:

```sql
CREATE TABLE room_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  room_id TEXT NOT NULL,
  status TEXT NOT NULL,
  room_seq INTEGER NOT NULL,
  canvas_generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  max_ends_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  total_drawing_events INTEGER NOT NULL,
  total_drawing_payload_bytes INTEGER NOT NULL,
  snapshot_mode TEXT NOT NULL,
  close_request_id TEXT
);

CREATE TABLE drawing_events (
  room_seq INTEGER PRIMARY KEY,
  actor_id TEXT NOT NULL,
  stroke_id TEXT NOT NULL,
  op INTEGER NOT NULL,
  payload BLOB NOT NULL,
  payload_bytes INTEGER NOT NULL,
  accepted_at INTEGER NOT NULL
);

CREATE INDEX drawing_events_stroke
  ON drawing_events(stroke_id, room_seq);

CREATE TABLE unfinished_strokes (
  stroke_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  begin_room_seq INTEGER NOT NULL,
  last_append_at INTEGER NOT NULL,
  point_count INTEGER NOT NULL,
  terminal_state TEXT
);

CREATE TABLE chat_messages (
  message_id TEXT PRIMARY KEY,
  room_seq INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  accepted_at INTEGER NOT NULL
);

CREATE TABLE snapshot_manifests (
  generation INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  base_room_seq INTEGER NOT NULL,
  renderer_version TEXT NOT NULL,
  object_key TEXT,
  object_bytes INTEGER,
  object_byte_hash TEXT,
  rgba_hash TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE scheduled_tasks (
  task_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL
);

CREATE TABLE processed_commands (
  dedupe_key TEXT PRIMARY KEY,
  result_room_seq INTEGER,
  expires_at INTEGER NOT NULL
);
```

実migrationでは`_sql_schema_migrations`を持つ。schema初期化以外で`blockConcurrencyWhile`を使わない。関連するSQL writeは外部I/Oを挟まずまとめる。

## WebSocket attachment

Hibernation復帰用に16KiB以内の最小情報だけをattachmentへ保存する。

- connection ID
- room actor ID
- role
- session reference
- last ack clientSeq

大きい権限・runtime stateはDO SQLiteから復元する。attachmentだけをauthoritativeにしない。

## Snapshot job

Queue messageにはevent本体を入れない。

- job ID
- room routing ID
- target baseRoomSeq
- renderer version
- manifest generation

consumerはDO RPCでchunk取得する。job stateはDO SQLiteに永続化し、at-least-once deliveryを重複排除する。

## R2 key

```text
runtime-snapshots/{room-hash}/{generation}/{object-hash}.png
runtime-snapshots-tmp/{job-id}
moderation-evidence/{evidence-id}/{object-hash}
```

- bucketは非公開
- object keyへroom slug、user名、tokenを入れない
- runtime snapshotはroom終了時cleanup
- evidenceは別prefix、別認可、期限付き

## Client storage

Local Storage:

- UI preferences
- palette
- last nickname / color

IndexedDB:

- 未送信stroke buffer
- last applied roomSeq
- cached snapshot metadata
- recovery中の短期event buffer

room token、room ticket、auth cookieをLocal Storageへ保存しない。

## Retention

| data | retention |
| --- | --- |
| active room row / membership | room終了まで |
| drawing event / runtime snapshot | room終了まで |
| presence / cursor | connection中 |
| chat | latest Nまたは短TTL、値未決定 |
| guest session | 暫定30日 |
| room ticket nonce | 期限 + replay検出猶予 |
| report evidence | 未決定、期限必須 |
| moderation action / ban | 公開前に決定 |

## 未決定

- Better Auth adapterが要求する正確なD1 schema
- D1 foreign keyと削除jobの実装方法
- chat N / TTL
- report evidence retention
- codec確定後のpayload BLOB schema
- D1とDO間のroom作成・削除補償処理
