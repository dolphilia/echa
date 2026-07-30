# Snapshot vertical-slice remote probe

`wrangler dev --remote`の一時preview sessionから、非公開のDurable Object RPCを呼び出すためのprobe。Workerとしてdeployしない。

許可するroom IDは`^snapshot-probe-[a-f0-9]{16}$`だけで、操作は次の2つに限定する。

- `POST /run?room=...`: 空roomのsnapshot jobをQueueへ送る。
- `POST /run-close?room=...`: jobをQueueへ送った直後にroom close fenceを立てる。
- `GET /status?room=...`: manifest、compaction、自動化設定とroom statsを取得する。
- `POST /compact?room=...&limit=...`: disposable probe roomだけを対象に、
  current jobを固定してcompactionを1 chunk進める。
- `POST /initialize?room=...&slug=<32 hex>&visibility=public|unlisted`:
  disposable roomを初期化する。
- `POST /start?room=...`: 初期化済みroomを開始する。
- `POST /draw?room=...`: completed strokeを1件追加する。
- `POST /fill?room=...&events=<3..60000>&connections=<1..20>&rate=<1..70>`:
  3の倍数のstroke eventを複数actorから安全なrateで投入する。
- `GET /recover?room=...`: 認可済みsnapshotを取得し、object / RGBA hashと
  1000 x 1000 decode、tail / readyを検証する。
- `GET /thumbnail-objects?room=...`: preview測定中だけ、対象room prefixの
  thumbnail object一覧を確認する。
- `GET /runtime-objects?room=...`: preview測定中だけ、対象room prefixの
  runtime snapshot object一覧を確認する。
- `GET /thumbnail-head?room=...&seq=...`: preview測定中だけ、特定世代の
  thumbnail objectをWorkers bindingから直接確認する。

`/fill`は50,000-event / 5,000-event境界のpreview測定専用で、room ID、
event数、接続数、actorごとのrateを厳しく制限する。公開WebSocket認証を迂回せず、
一時的なservice bindingだけを使う。

このprobeはQueue → snapshot consumer → R2 → DO manifest commitのpreview縦切り確認に使用する。

非空の次世代snapshotを確認するときは、第1世代のcommit後に公開WebSocket経路から
完了strokeを追加する。

```bash
node --import tsx tools/snapshot-vertical-slice-probe/draw.mts \
  snapshot-probe-<16 hex> [resumeAfterRoomSeq]
```

その後に同じroomへ`POST /run`を行うと、jobには第1世代を固定した
`sourceSnapshotJobId`と`sourceBaseRoomSeq`が含まれる。
compaction後の検証では、削除済みeventの再送要求を避けるため、statusで確認した
`lastRoomSeq`を`resumeAfterRoomSeq`に指定する。

current snapshot + tail、previous snapshot + bridge/tail、snapshotなしのfail-closedを
公開経路から確認する。

```bash
node --import tsx tools/snapshot-vertical-slice-probe/recover.mts \
  snapshot-probe-<16 hex>

node --import tsx tools/snapshot-vertical-slice-probe/recover.mts \
  snapshot-probe-<16 hex> <current-job-id>

node --import tsx tools/snapshot-vertical-slice-probe/recover.mts \
  snapshot-probe-<16 hex> disabled
```

出力へsnapshot read tokenやobject本体は含めない。
