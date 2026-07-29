# Snapshot vertical-slice remote probe

`wrangler dev --remote`の一時preview sessionから、非公開のDurable Object RPCを呼び出すためのprobe。Workerとしてdeployしない。

許可するroom IDは`^snapshot-probe-[a-f0-9]{16}$`だけで、操作は次の2つに限定する。

- `POST /run?room=...`: 空roomのsnapshot jobをQueueへ送る。
- `POST /run-close?room=...`: jobをQueueへ送った直後にroom close fenceを立てる。
- `GET /status?room=...`: manifest、compaction、自動化設定とroom statsを取得する。
- `POST /compact?room=...&limit=...`: disposable probe roomだけを対象に、
  current jobを固定してcompactionを1 chunk進める。

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
