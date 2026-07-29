# Production initial deployment

実施日: 2026-07-29

## 結果

production D1 migrationとRealtime、Snapshot、Web Workerの初回配備を完了した。
`koge.app`と`realtime.koge.app`はHTTPSで到達可能。機械的smoke、
OAuth、製品room、Access管理操作の利用者E2E、初回Worker Analyticsをpassした。
公開運用gateが残るため、一般公開完了とはまだ扱わない。

## 配備対象

| 対象 | version |
| --- | --- |
| Realtime | `476b45bf-73b8-4dad-85cd-054acdc3a63f` |
| Snapshot | `7fb79a67-6c40-4227-a627-3b06d1e7ba07` |
| Web | `011c5f1d-4d25-4dc5-b7c0-3cf9cdca7cf2` |

## Database

- database: `koge-production`
- migration: `0001`〜`0017`
- unapplied: 0
- emergency control: room作成、新規入室、描画がすべて許可
- read-only query: APAC / NRT primary、変更0

## Queue

- snapshot、cleanup、moderation evidence: producer 1 / consumer 1
- cleanup / moderation evidence DLQ: producer 1 / consumer 0

## Smoke

- home: 3回連続HTTP 200、HTML
- unauthenticated session: HTTP 200、`null`
- public rooms: HTTP 200、空配列
- Realtime health: HTTP 200、environment `production`、全binding true
- admin: Cloudflare AccessへHTTP 302
- remote secret: 必須3名称が存在し、値は取得・記録していない

Custom Domain伝播直後だけRealtimeに1104、Webに500が1回ずつ出た。再試行後は収束し、
以後の安定確認では再現しなかった。

## 残るgate

2026-07-29に利用者E2Eとして次をpassした。

1. Google OAuth test userのlogin。
2. public room作成。
3. 別browserのparticipant / viewer入室。
4. 描画、remote cursor、chat、reload復帰。
5. host終了、一覧除外、再入室拒否。
6. Access認証後のproduction管理画面。

終了後のread-only確認:

- D1 `rooms`、`reports`、`evidence_manifests`、`snapshot_orphans`: すべて0
- cleanup main Queue / DLQ backlog: 0 / 0
- cleanup pending / stuck projection: 0 / 0
- evidence main Queue / DLQ backlog: 0 / 0
- evidence pending / deletion / stuck projection: すべて0
- orphan health: HTTP 200、inventory 0、automatic deletionなし

R2 object inventoryのlatest scanはまだ`null`であり、R2全objectの独立列挙を行った
結果ではない。今回の短いE2Eは50k snapshot trigger未満で、D1 cleanup fenceと
Queue healthに異常はない。

## Worker Analytics

対象時間窓は`2026-07-29T05:24:00Z`〜`06:19:00Z`。

| Worker | sample | request | error | 最大CPU p99 | 最大memory p999 | 判定 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Realtime | 44 | 86 | 0 | 12,770 | 2,486,284 bytes | pass |
| Snapshot | 0 | 0 | 0 | 0 | 0 | 未起動、想定内 |
| Web | 83 | 175 | 2 | 94,315 | 14,161,691 bytes | pass（既知の配備時過渡エラー） |

Realtimeのstatusはsuccess 42、`clientDisconnected` 1、
`responseStreamDisconnected` 1だった。どちらもerror 0であり、今回の
WebSocket切断・room終了操作と整合する。最大memory p999は30% headroom基準
93,952,409 bytesを十分下回る。

Webはsuccess 82、`scriptThrewException` 1だった。異常sampleは
`2026-07-29T05:32:19Z`の2 requests / 2 errorsだけで、CPU p99 819、
memory p999 786,432 bytesだった。これは初回Custom Domain伝播直後に確認した
home / session一時500と時刻・件数が一致する。直後の`05:33Z`以降はsuccessで
再現せず、最大memory p999も30% headroom基準を十分下回るため、
既知の配備時過渡エラーとして初回Worker Analytics gateをpassとする。

残るgate:

1. 規約、retention、alert、backup、closed betaを含むRelease Gate。
