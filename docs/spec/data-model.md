# Data model

更新日: 2026-07-30
状態: migration `0001`〜`0020`はproduction反映済み。`0021`はlocal実装済み、
preview / production適用前。

## 原則

- D1: 検索・認証・運用に必要な通常データ
- 1 room = 1 SQLite-backed Durable Object
- DO SQLite: roomのauthoritative runtime stateと短期event
- R2: runtime snapshot、公開中だけのthumbnail、期限付きmoderation evidence
- client: UI設定と短期送信・復帰buffer
- gallery用テーブルと完成画像はMVPに作らない

## ID

| name | scope | exposure |
| --- | --- | --- |
| `userId` | service | 原則内部 |
| `guestSessionId` | browser | cookieのみ |
| `roomId` | service / DO routing | URLへ出さない |
| `roomSlug` | public URL | 128bit以上random |
| invite token | unlisted URL fragment | 256bit、serverはSHA-256のみ |
| `roomTicket` | 1 WebSocket接続 | 60秒、single use |
| `actorId` | room | roomごとに発行 |
| `strokeId` | room | client生成128bit以上 |

## D1

### `users`

- `id` primary key
- Better Authが必要とするidentity fields
- `status`: `active | suspended | deleting`
- nullable `deletionRequestedAt`
- MVP表示名の最小属性
- `created_at`, `updated_at`

詳細プロフィールは別機能導入時に`user_profiles`を追加する。
表示名とHTTPS avatar URLはBetter Authの`name`、`image`を利用する。
account削除request後は`deleting`へ遷移して全sessionとprovider accountを
失効し、所有roomのcleanup完了後にuserを物理削除する。通報・BANなど
保持根拠がある参照は`deleted_<digest>`へ匿名化し、通常accountとの対応を
切り離す。`0018_account_deletion.sql`は削除再試行scan用indexを追加する。

### `rooms`

- `id`
- `public_slug` unique
- `owner_user_id`
- `name`, `visibility`
- `status`
- participant/viewer limits
- viewer chat/stamp settings
- `created_at`, `starts_at`, `max_ends_at`
- `provisioning_status`: `pending | ready | failed`
- nullable `create_request_id`: owner内のroom作成冪等キー
- `provisioning_attempts`
- nullable `provisioning_error_code`
- nullable `provisioning_updated_at`
- nullable `thumbnail_object_key`
- nullable `thumbnail_base_room_seq`
- nullable `thumbnail_updated_at`
- DO routingに必要な参照

statusと人数は一覧用projectionであり、runtimeの正はroom DOとする。
`(owner_user_id, create_request_id)`をuniqueにし、同じ作成操作の再送で
別roomを増やさない。D1登録後にDO初期化が失敗した場合は`failed`を保存し、
同じ入力の再送で同じDOを再初期化する。DO側の`room_metadata`も初期化を
冪等にし、同じroom IDへ異なるmetadataを上書きしない。
1ユーザーが同時に所有できる未終了roomは1件とする。`waiting | active | idle |
suspended`かつprovisioningが`pending | ready`のroomを条件付きINSERT内で数え、
同時requestでも2件目を作らない。`closing`へ遷移したroomは物理削除前でも上限から
外し、次のroomを作成できる。失敗projectionの再試行も、別の未終了roomがある場合は
拒否する。
サイト全体の同時開催room数は`service_capacity_limits.live_room_limit`を上限とし、
同じ条件付きINSERT内で数える。作成時点の`participant_limit`と`viewer_limit`を
同テーブルからroom rowへ固定保存する。新しいroomでは両者の合計を20以下とし、
設定変更を既存roomへ遡及しない。
公開一覧は`visibility = public`、`provisioning_status = ready`、
`status IN (waiting, active, idle)`だけを返す。終了時に物理削除し、
復旧backup対象にしない。

### `service_capacity_limits`

- singleton row
- `live_room_limit`: 1〜20、初期値20
- `participant_limit`: 1〜20、初期値10
- `viewer_limit`: 0〜19、初期値10
- participantとviewerの合計は20以下
- `public_rooms_only`: 新規roomを公開だけに制限する。初期値false
- `revision`, `updated_at`, `actor_admin_id`, `reason`

`service_capacity_limit_actions`へ変更者、変更値、理由、適用revisionを記録する。
通常の利用上限であり、機能を即時停止する`service_controls`とは分離する。
role別接続数のauthoritativeな判定はroom Durable Objectで行い、D1の
`participant_count` / `viewer_count`は一覧表示用projectionとして扱う。
`public_rooms_only`は新規INSERTだけに適用し、既存のunlisted roomや同一requestの
provisioning再試行には遡及しない。

### `guest_sessions`

- `id`: cookieへ露出しない内部guest ID
- `token_hash`: 256-bit cookie tokenのSHA-256、unique
- `created_at`, `expires_at`, `last_seen_at`

cookieには生tokenだけをHttpOnlyで保存する。D1へ生tokenを保存しない。

### `room_memberships`

- `room_id`
- `subject_kind`: `user | guest`
- `subject_id`: 内部user IDまたは内部guest ID
- `actor_id`: room内だけで使用、room内unique
- `role`: `host | participant | viewer`
- `created_at`, `last_seen_at`

`room_id + subject_kind + subject_id`をprimary keyとし、再接続時も同じ
actor IDを使う。activeなログインユーザーだけが非ownerの
`participant | viewer`をticket再発行時に選択できる。guest membershipは
`viewer`だけに制限し、owner membershipは常に`host`へ補正する。

guestのservice横断IDを公開しない。終了時削除。

### `room_invites`

- `id` primary key
- `room_id`、room削除時にcascade
- `token_hash` unique
- `created_by_user_id`
- `created_at`, `expires_at`, nullable `revoked_at`

roomごとに未失効inviteを1件に制限する。生tokenを保存しない。作成時は
room行とinvite hashをD1 batch transactionで同時に登録する。

### `reports`

- `id` primary key
- NOT NULLだがforeign key constraintを持たない`source_room_id`
- `reporter_subject_kind`, `reporter_subject_id`
- `category`, nullable `description`
- `room_name_snapshot`
- `status`
- nullable `evidence_manifest_id`
- `created_at`, `updated_at`, nullable `resolved_at`

room削除でcascadeしない。2026-07-28のD1 migration
`0008_moderation_evidence_fence.sql`で最小schemaを追加した。target
actor/message/stroke参照はevidence bundle内へ固定する。同じsubjectから同じroomへの
未解決reportは`0009_report_abuse_fence.sql`で1件に制限する。

### `evidence_manifests`

- `id` primary key
- foreign key constraintを持たない`source_room_id`
- `status`: pending / committed / failed / deleted
- nullable `object_key`, `object_bytes`, `object_hash`
- `created_at`, nullable `committed_at`
- 必須の`expires_at`
- nullable `deleted_at`
- nullable `deletion_job_id`, `deletion_requested_at`

通常cleanupは、未解決reportに紐づくmanifestが`committed`になるまで失敗終了する。
これにより元event/runtime snapshotを先に削除しない。bundleは固定時点の
runtime snapshot copy、snapshot以後の上限付きevent chunk、report、chat、
room metadata、membership対応、component hashをR2へ保存し、最後にmanifestを
commitする。保持期限到達時はD1 claim、Queue、R2 prefix削除、D1 `deleted`更新の
順で冪等に削除する。Access保護済み管理画面からreportとmanifest状態を確認できる。
evidence object本文を一般画面へ直接公開する経路は持たない。

### `moderation_actions`

- `id`
- source room ID
- admin ID
- action type
- target internal identity
- nullable target room actor ID
- reason
- created_at
- `status`: `pending | applied | failed`
- nullable `applied_at`
- nullable `error_code`
- nullable `result_json`

room管理操作はD1へ`pending`を先に記録し、非公開Service Bindingからroom DOを
操作した後に`applied`と結果を保存する。同じID・同じ入力の再送は保存済み結果を
返し、同じIDの異なる入力は拒否する。DO成功後に応答が失われても再送で収束する。
`result_json`にはlifecycle結果、またはkick / room banの対象actor、
切断connection数、ban期限を置き、Access JWTや生emailは保存しない。
`actor_admin_id`は検証済みAccess JWTの`sub`をSHA-256で一方向化した内部IDとし、
JWT、生email、生`sub`は保存しない。

### `service_controls`

サービス全体の緊急制御を表すsingleton projection。

- `singleton = 1`
- 単調増加する`revision`
- `room_creation_enabled`
- `room_entry_enabled`
- `drawing_enabled`
- `updated_at`
- nullable `actor_admin_id`, `reason`

`0014_service_controls.sql`で追加する。room作成とticket発行は操作ごとにD1の
authoritativeな値を確認する。drawingは各room DOが最大5秒cacheするが、
Hibernation後はD1を再読込する。

### `service_control_actions`

- UUID由来の`id` primary key
- `actor_admin_id`
- 適用した3つのboolean
- `reason`, `requested_at`
- uniqueな`applied_revision`

同じIDと同じ入力の再送は保存済み結果を返し、同じIDの異なる入力は拒否する。
action挿入とsingleton更新はD1 batch transactionで同時に適用する。
`actor_admin_id`は検証済みAccess subjectの一方向化済み内部IDである。

### `snapshot_orphan_scans`

- `id` primary key
- `status`: `running | completed | failed`
- `started_at`, nullable `completed_at`
- `object_count`, `object_bytes`
- `orphan_count`, `orphan_bytes`
- nullable `error`

partial unique indexで実行中scanを1件に制限する。6時間を超えた`running`は次回scanが
`failed`へ移し、新しいscanを開始する。

### `snapshot_orphans`

- `object_key` primary key
- `room_id`
- `object_bytes`, `uploaded_at`
- `reason`: `room_missing | unreferenced`
- `first_detected_at`, `last_detected_at`
- `scan_id`

`0011_snapshot_orphan_inventory.sql`で追加した運用projection。完了scanの結果だけで
置き換え、失敗時は直前のinventoryを保持する。自動削除の根拠にはせず、個別確認と
明示承認の入力にする。

### `snapshot_orphan_deletion_runs` / `snapshot_orphan_deletion_items`

`0015_snapshot_orphan_deletions.sql`で追加する孤児snapshot削除の監査記録。

- runはplan hash、source / verification scan ID、環境、件数、byte数、結果時刻を持つ
- itemはobject keyのSHA-256 hash、内部room ID、reason、byte数、結果だけを持つ
- object keyそのものは監査表へ複製しない
- 同じplan hashの再適用は保存済み完了結果を返す

削除計画は連続scan、R2 metadata、30分の期限を固定する。適用時に再scanして
D1 / DO / R2を照合し、全条件が一致した完全keyだけを削除する。

### `rate_abuse_room_outcomes`

room cleanupがDO SQLiteを物理削除する直前に保存する、濫用制御の最終counter。

- `cleanup_job_id` primary key。再試行時の重複加算を防ぐ
- `room_digest`: 内部room IDのSHA-256。生room IDは保存しない
- `captured_at`
- `accepted_count`, `reject_count`
- `rate_limited_count`, `short_mute_count`, `abuse_disconnect_count`

actor、user、guest session、chat本文、stroke payload、IPは保存しない。
scheduled maintenanceで30日を超えた行を削除する。稼働中roomはDO RPCで
read-only取得し、この終了counterとローカルbaselineを組み合わせて期間差分を出す。

### `bans`

- `id` primary key
- `scope`: MVPでは`room`だけ
- `room_id`
- `subject_kind`: `user | guest`
- `subject_id`
- room内で安定した`actor_id`
- `starts_at`, `expires_at`
- reasonと一意なmoderation action ID

`0013_room_bans.sql`で追加する。ルームBANは対象subjectの新ticket発行をD1で拒否し、
DO内の`room_bans`でも既存ticket・直接再接続を拒否する二重のfenceとする。
期限は対象roomの`max_ends_at`で、room削除時にcascade削除する。MVPでは
service-level banをこの表へ混在させない。

### `service_bans`

`0017_service_bans.sql`で追加する一時的なサービス全体のfence。

- `id`, 一意な`action_id`
- `subject_kind`: `user | guest`
- 内部`subject_id`
- 操作元の`source_room_id`, `source_actor_id`
- `starts_at`, `expires_at`
- reason
- `revoked_at`, `revoked_by_admin_id`, `revocation_reason`,
  一意な`revocation_action_id`

24時間、7日、30日だけを許可し、既定は7日。永久BANとIP単位BANはMVPに含めない。
有効中はuserのroom作成とuser / guestのticket発行を拒否し、適用時点の稼働中
membershipもDOから切断する。適用・解除はCloudflare Access認証済み管理者だけが
実行する。有効期間終了後180日まで監査情報を保持し、scheduled maintenanceで
対応する`moderation_actions`とともに削除する。

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
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE snapshot_jobs (
  job_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  target_room_seq INTEGER NOT NULL,
  protocol_version INTEGER NOT NULL,
  renderer_version INTEGER NOT NULL,
  canvas_generation INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  requested_at INTEGER NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE snapshot_manifests (
  job_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  base_room_seq INTEGER NOT NULL,
  protocol_version INTEGER NOT NULL,
  renderer_version INTEGER NOT NULL,
  canvas_generation INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  codec TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  object_bytes INTEGER NOT NULL,
  object_hash TEXT NOT NULL,
  rgba_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE snapshot_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  current_job_id TEXT
);

CREATE TABLE scheduled_tasks (
  kind TEXT PRIMARY KEY
    CHECK (kind IN ('idle_timeout', 'empty_timeout', 'max_duration')),
  due_at INTEGER NOT NULL
);

CREATE TABLE room_activity_limit (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  warning_level INTEGER NOT NULL
    CHECK (warning_level IN (0, 80, 90, 98, 100)),
  reached_at INTEGER
);

CREATE TABLE room_time_limit (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  warning_stage INTEGER NOT NULL DEFAULT 0
    CHECK (warning_stage IN (0, 1, 2, 3))
);

CREATE TABLE processed_commands (
  dedupe_key TEXT PRIMARY KEY,
  result_room_seq INTEGER,
  expires_at INTEGER NOT NULL
);
```

`room_time_limit.warning_stage`は0=未通知、1=15分、2=5分、3=1分を表す。
最大終了時刻は`room_metadata.max_ends_at`と`scheduled_tasks.max_duration`が保持し、
通知ごとのtask行は作らない。期限と段階から次の予告時刻を導出するため、
DOの単一alarmを他のstroke timeout、idle、cleanup処理と共有できる。

shadow recovery用の一時credentialはroom DO SQLiteにだけ置く。

```sql
CREATE TABLE snapshot_read_tickets (
  token_hash TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  FOREIGN KEY(job_id) REFERENCES snapshot_manifests(job_id)
);
```

生tokenは保存せず、256-bit random tokenのSHA-256だけを保存する。TTLは暫定60秒で、初回利用時に同じtransaction内で`consumed_at`を設定する。room終了時はmanifestとともに削除する。

room WebSocket用の一時credentialも同じ原則でroom DO SQLiteに置く。

```sql
CREATE TABLE room_tickets (
  token_hash TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  connection_id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  can_chat INTEGER NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  session_binding_hash TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
```

Web Workerからprivate Service Bindingでhashを登録し、WebSocket upgrade時に
single useで消費する。期限切れticketは新規登録時に削除し、room終了時は
残存ticketを全削除する。

実migrationでは`_sql_schema_migrations`を持つ。schema初期化以外で`blockConcurrencyWhile`を使わない。関連するSQL writeは外部I/Oを挟まずまとめる。

`connections`はdrawing用`rate_tokens / rate_updated_at`とは別に、
cursor用`cursor_rate_tokens / cursor_rate_updated_at`とchat用
`chat_rate_tokens / chat_rate_updated_at`を持つ。これはHibernation後も
rate limitを安全側へ継続するための値で、cursor座標やpresence一覧は保存しない。
また`can_chat`、`display_name`、`avatar_url`を接続ticketから固定し、roleだけや
client入力からchat権限・プロフィールを決めない。
chatの`seq`はchat内だけの順序であり、drawing `roomSeq`、event log、
snapshot baseRoomSeqへ含めない。

DO SQLite schema v29ではpublic roomの5分one-shot thumbnail taskを
`snapshot_automation`へ追加する。schema v28ではticket、connection、chat messageへchat権限と
server由来プロフィールを追加する。schema v26では`actor_abuse_state`を追加する。

- `actor_id` primary key
- `violation_count`
- `window_started_at`
- `muted_until`
- nullable `disconnected_at`

drawing/chatのrate超過をconnection IDではなくroom actor単位で合算するため、
Hibernationとconnection replacement後も短時間muteを回避できない。通常の
rate tokenは引き続きconnection別とし、段階制御だけをactor別にする。
room cleanup時はDO SQLite全体とともに削除する。

## WebSocket attachment

Hibernation復帰用に16KiB以内の最小情報だけをattachmentへ保存する。

- connection ID
- room actor ID
- role
- session binding hash
- last ack clientSeq

大きい権限・runtime stateはDO SQLiteから復元する。attachmentだけをauthoritativeにしない。

## Snapshot job

Queue messageにはevent本体を入れない。

- job ID
- room routing ID
- target baseRoomSeq
- protocol version
- renderer version
- canvas generation
- manifest generation

consumerはDO RPCでchunk取得する。job stateはDO SQLiteに永続化し、at-least-once deliveryを重複排除する。

## R2 key

```text
rooms/{internal-room-id}/snapshots/staging/{job-id}.kgs
moderation-evidence/{evidence-id}/manifest.json
moderation-evidence/{evidence-id}/snapshot.kgs
moderation-evidence/{evidence-id}/events/{first-seq}-{last-seq}.json
```

- bucketは非公開
- object keyへ公開room slug、user名、tokenを入れない。`internal-room-id`は推測困難な内部routing IDとする。
- runtime snapshotはroom終了時cleanup
- runtime snapshot孤児scanは1時間のgrace period後に参照関係だけを確認し、
  R2を自動削除しない
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
| chat | 暫定で最新100件か24時間の早い方、room終了時に削除 |
| guest session | 暫定30日 |
| room ticket nonce | room開催中。期限切れは登録時、残存分はroom終了時に削除 |
| report evidence | 暫定30日、期限必須。公開前に確定 |
| moderation action | service BANは有効終了後180日。その他は公開前に決定 |
| room ban | room終了まで |
| service ban | 有効終了後180日（有効期間は24時間 / 7日 / 30日） |

## 未決定

- report evidence retention
- service BAN以外のmoderation action retention
- codec確定後のpayload BLOB schema
