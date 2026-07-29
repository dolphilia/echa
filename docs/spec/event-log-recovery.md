# Event log and recovery

更新日: 2026-07-29
状態: Gate B pass。snapshot-first採用、productionはshadow modeで稼働

## 方針

- event log全再生はMVPの必須fallback。
- 共通WASM rendererとsnapshot vertical sliceを優先する。
- Gate Bの採用条件を満たしたためsnapshot-firstを標準経路にする。
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

serverは次を返す。現行shadow実装では、WebSocketのsnapshot offerと後続replay / readyに分けて返す。

- room status
- canvas generation
- event log start/end roomSeq
- snapshot mode
- current/previous snapshot manifest
- tail取得境界

## Snapshot manifest

```ts
type SnapshotManifestV1 = {
  v: 1;
  jobId: string;
  roomId: string;
  baseRoomSeq: number;
  protocolVersion: 1;
  rendererVersion: 1;
  canvasGeneration: 1;
  generation: number;
  codec: "koge-rgba-deflate-v1";
  width: 960;
  height: 640;
  objectKey: string;
  objectBytes: number;
  objectHash: string;
  rgbaHash: string;
  createdAt: number;
};
```

manifestは外部へ内部room IDや生のR2 keyを不用意に公開しない。client向けresponseは認可済み取得URLまたはWorker endpointを返す。

現行実装はWorker proxyを採用する。Durable Objectが60秒・1回限りの256-bit tokenを発行し、tokenのSHA-256だけをSQLiteへ保存する。clientはtokenをURLへ含めず、`Authorization: KogeSnapshot {token}`でrealtime Workerへ渡す。Workerはtokenを原子的に消費し、manifestとR2 metadataを照合してobject bodyを`private, no-store`でstreamする。

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
10. compacted modeでもprevious snapshotからcurrentへ到達するbridge eventを残す。
    削除境界はcurrentではなくpreviousの`baseRoomSeq`以前とする。

Queueはat-least-once deliveryとして扱い、job処理を冪等にする。retry上限後はDLQへ送り、roomはevent logで継続する。

## Snapshot trigger

初期実装は、completed-stroke boundaryで次のいずれかを満たしたときにjobを1件だけ
生成する。

- 50,000 drawing events
- 16MiB logical payload

2回目以降は、直近job作成時点から次のいずれかまで再生成しない。

- 5,000 drawing events増加
- 4MiB logical payload増加

同時に複数jobを起動しない。前job終了後の増分が小さい場合は再生成しない。総活動量上限は100,000 events / 64MiB / 2時間のまま。

自動化は非secret環境変数`SNAPSHOT_AUTOMATION_MODE`で切り替える。

| 値 | 動作 |
| --- | --- |
| `off` | 自動job生成と自動compactionを行わない |
| `shadow` | 自動jobを生成するがeventを削除しない |
| `compact` | 自動job生成に加え、commit後の安全な境界をalarmで分割削除する |

local / preview / productionの現在値は`shadow`とする。`stroke.end`、`stroke.cancel`、または
timeoutによるserver生成endの後だけ判定する。queued job、active stroke、
closing roomがある場合は生成しない。jobのtrigger種別と作成時点の総event数・
総payload byte数をSQLiteへ保存し、再判定とschema移行後の不要な再生成を防ぐ。

## Adoption gate

判定: **pass**（2026-07-28、ADR 0007）

すべて満たす場合だけsnapshot-firstを有効化する。

- Browser / Workers WASMのRGBA hash一致
- Browser WASMの確定stroke描画が入力を阻害しない
- 50,000-event初回生成と当初10,000-event増分でWorker制限に30%以上の余裕。
  後続比較で5,000-event増分も同条件を満たした
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
- previous snapshotからcurrentへ到達するeventを削除しない。
- 次のsnapshot生成はcurrent snapshotを読み込み、その後のtailだけを適用できること。
- 最初のsnapshotしかない場合は、安全なprevious境界がないため削除しない。
- deletionはchunk単位で冪等に行う。
- `compact`時の自動deletionはDurable Object alarmで最大500 eventずつ実行し、
  未完了またはqueued sourceによるblock時だけ次のalarmを設定する。
- 削除cursorと`shadow -> snapshot_compacted`遷移は、最初のevent削除と同じ
  SQLite transactionで確定する。
- queued jobが固定した最古の`sourceBaseRoomSeq`を越えて削除しない。
- 呼び出し時に固定したcurrent jobが入れ替わっていた場合は何も削除しない。
- compaction済みroomはevent_log_onlyへ戻さない。
- feature flagを`compact`から`shadow`または`off`へ下げた場合、未実行の自動
  compaction予約を次のalarmで破棄する。既にcompaction済みのroomは
  event_log_onlyへ戻さない。

2026-07-27時点で、job作成時にcurrent manifestを固定し、R2 objectのmetadata、
object hash、codec、RGBA hashを検証して共通WASM rendererへloadした後、
固定baseより後のtailだけで次世代を生成する経路はlocal / previewで成立した。
previous境界のchunk deletion、中断再開、重複実行、queued source保護、
current / previous復旧、圧縮後の次世代生成もlocal / disposable preview roomで
成立した。feature flagとcompleted-stroke triggerによる自動shadow生成、
commit後のalarm駆動chunk compaction、flag停止時の予約破棄も実装した。
memory p999を含むpreview性能と70,020-event canaryを確認し、Gate Bはpassした。
その後、5,000-event増分をpreview実測から既定値へ昇格した。終了cleanup、
Queue / DLQ health、orphan inventoryはproductionまで実装・確認済みだが、
通常roomは安全側の`shadow`を維持する。`compact`はclosed betaの成功率、
復帰hash、Queue滞留、R2 object数を観測してから段階導入する。詳細は
[`../results/phase3-snapshot-compaction.md`](../results/phase3-snapshot-compaction.md)。

## Client recovery

### Snapshot-first

1. manifest取得。
2. object取得。
3. object byte hash、format、size、versionを検証。
4. decodeしてcanvasへ適用。
5. `baseRoomSeq + 1`からtail replay。
6. buffered live eventへ追いつく。

現行実装はWebSocket frameをPromise chainで直列処理する。snapshot offerの検証・適用が完了するまで、同じconnectionで既に到着したtail / ready / live frameを適用しない。

### Fallback

1. shadowでcurrent snapshot失敗: currentを除外して自動再接続し、previous
   snapshotがあればprevious + tailを試す。
2. shadowでpreviousも失敗または存在しない: canonical stateを白紙へ戻し、
   event log先頭からBrowser WASMで全再生。
3. compactedでcurrent失敗: previous snapshot + 保持済みbridge event + tail。
4. compactedでpreviousも失敗: 不完全表示せず入室中止、管理通知。
5. event_log_only: event log先頭から再生。

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

2026-07-27時点で、closingの永続化とqueued jobのsupersedeを同じDO transactionで
行い、開始済みWorkerのcommitをsupersededへする終了フェンスはlocal / previewで
成立した。close結果はmanifestと全jobからcleanup候補keyを列挙する。
2026-07-28に専用Queueを使うR2 delete、DO `deleteAll()`、D1/list projection削除、
evidence commit fence、retry / DLQ / healthを実装し、2026-07-29にproductionの
利用者E2Eと終了後healthをpassした。

## 暫定実装値と未決定

- runtime snapshot codecは`koge-rgba-deflate-v1`。10k / 50k / 100k測定で問題があれば再検討する。
- event chunk上限は500。
- shadow観測期間と採用成功率
- Worker proxyのtoken TTL、失敗率、R2 egress / Worker実行コストを実負荷で再評価
