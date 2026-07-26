# Event log and recovery

更新日: 2026-07-27
状態: 実装前初稿

## 方針

- event log全再生はMVPの必須fallback。
- 共通WASM rendererとsnapshot vertical sliceを優先する。
- 採用条件を満たせばsnapshot-first、難しければevent log-only。
- snapshotは完成画像ではなく、開催中だけ存在する復帰用データ。

## Authoritative state

| mode | authoritative state |
| --- | --- |
| `event_log_only` | 全drawing event log |
| `shadow` | 全drawing event log。snapshotは検証用 |
| `snapshot_compacted` | commit済みsnapshot + `baseRoomSeq`より後のtail event |

room作成からの総event数・総payload byte数はcompaction後も保持し、活動量上限をリセットしない。

## Event log

永続対象:

- `stroke.begin`
- `stroke.append`
- `stroke.end`
- `stroke.cancel`
- server生成のtimeout end

別保持:

- chat: 最新N件またはTTL
- room lifecycle / moderation: 小さい監査記録
- cursor / presence: 原則非永続

logical byte counterは実codecが返すdrawing event payload byteの累計。SQLite row/indexを含む物理容量は別metric。

## Recovery request

clientは次を送る。

- protocol version
- renderer version
- canvas generation
- last applied roomSeq
- cached snapshot baseRoomSeqとhash。あれば

serverは次を返す。

- room status
- canvas generation
- event log start/end roomSeq
- snapshot mode
- current/previous snapshot manifest
- tail取得境界

## Snapshot manifest

```ts
type SnapshotManifestV1 = {
  schema: "echa.snapshot-manifest.v1";
  roomId: string;
  canvasGeneration: number;
  baseRoomSeq: number;
  protocolVersion: number;
  rendererVersion: string;
  width: 960;
  height: 640;
  colorSpace: "srgb";
  format: "png" | "webp-lossless";
  objectKey: string;
  objectBytes: number;
  objectByteHash: string;
  rgbaHash: string;
  createdAt: number;
  generation: number;
};
```

manifestは外部へ内部room IDや生のR2 keyを不用意に公開しない。client向けresponseは認可済み取得URLまたはWorker endpointを返す。

## Snapshot job

1. DOが`jobId`、target `baseRoomSeq`、renderer versionを永続化。
2. Queueへ小さいjob messageを送る。event本体はQueueへ入れない。
3. consumerがDO RPCからeventをchunk取得。
4. Workers WASMで960 x 640 RGBAへ描画。
5. lossless encodeし、object byte hashとRGBA hashを計算。
6. 一時keyへR2 PUT。
7. DO RPCでjobId、baseRoomSeq、hash、generationを検証。
8. manifestをcommit。
9. shadowなら全eventを残す。
10. compacted modeならcommit後だけ`roomSeq <= baseRoomSeq`を削除。

Queueはat-least-once deliveryとして扱い、job処理を冪等にする。retry上限後はDLQへ送り、roomはevent logで継続する。

## Snapshot trigger

初期候補はいずれか。

- 50,000 drawing events
- 16MiB logical payload
- 推定full replay 2秒

同時に複数jobを起動しない。前job終了後の増分が小さい場合は再生成しない。総活動量上限は100,000 events / 64MiB / 2時間のまま。

## Adoption gate

すべて満たす場合だけsnapshot-firstを有効化する。

- Browser / Workers WASMのRGBA hash一致
- Browser WASMの確定stroke描画が入力を阻害しない
- 100,000 eventsでWorker制限に30%以上の余裕を目標
- snapshot + tailがfull replayより明確に速い
- R2/manifest/Queue失敗時にeventを消さない
- end-to-end障害試験が通る
- 運用複雑性がMVPの保守範囲

## Shadow mode

- 全eventを残す。
- Browser WASM full replay hashとWorkers snapshot hashを比較。
- snapshot生成成功率、hash一致率、時間、memoryを記録。
- snapshotを利用した試験復帰を行うが、失敗時はfull replay。
- 観測期間と必要成功率は負荷試験計画で決める。

## Compaction

- R2 PUT成功だけでは削除しない。
- manifest commit成功後だけ削除可能。
- current snapshotが検証されるまでprevious snapshotを残す。
- deletionはchunk単位で冪等に行う。
- compaction済みroomはevent_log_onlyへ戻さない。
- feature flag停止時は新規roomと未compaction shadow roomだけをevent_log_onlyへ戻す。

## Client recovery

### Snapshot-first

1. manifest取得。
2. object取得。
3. object byte hash、format、size、versionを検証。
4. decodeしてcanvasへ適用。
5. `baseRoomSeq + 1`からtail replay。
6. buffered live eventへ追いつく。

### Fallback

1. shadowでsnapshot失敗: event log先頭からBrowser WASMまたはCanvas 2Dで再生。
2. compactedでcurrent失敗: previous snapshot + tail。
3. previousも失敗: 不完全表示せず入室中止、管理通知。
4. event_log_only: event log先頭から再生。

共通WASMが採用された場合、確定strokeとcold replayはBrowser WASMをcanonical rendererとする。Canvas 2Dはprovisional表示に残す。

## Live catch-up

- recovery開始時のtarget roomSeqを固定する。
- recovery中の新eventはbyte/件数上限付きqueueへ保持。
- targetへ到達後、queueをroomSeq順に適用。
- queue上限超過時は中途半端に続けず、新しいtargetで再開。

## Corruption

次を破損として扱う。

- roomSeq欠落・逆転
- unsupported protocol / renderer
- object hash / RGBA hash不一致
- baseRoomSeqとtail境界の不整合
- canvas generation不一致

破損時は利用者へ再試行可能なエラーを出し、room ID、sequence、manifest generation、reasonだけを管理metricへ残す。tokenやchat全文は残さない。

## Cleanup

room終了時はevent、manifest、current/previous/temp snapshotを削除する。R2 keyは先にcleanup taskへ登録し、orphan objectを期限付きで再試行する。report証跡へ移したobjectは別prefix・別retention。

## 未決定

- lossless PNG / WebPの最終選択
- event chunk size
- shadow観測期間と採用成功率
- snapshot再生成の最小増分
- R2取得をWorker proxy / presigned URLのどちらにするか
