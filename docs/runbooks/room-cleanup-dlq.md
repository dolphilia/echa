# Room cleanup Queue / DLQ runbook

更新日: 2026-07-28  
対象: `koge-room-cleanup-preview` / `koge-room-cleanup-preview-dlq`

## 目的

通常終了roomのcleanupが滞留またはDLQへ到達した場合に、roomを再開せず、
別roomのデータを削除せず、同じjobを安全に再実行する。

## 検知

read-only endpoint:

```sh
curl -fsS https://realtime-preview.koge.app/health/cleanup
```

正常条件:

- HTTP 200
- `queue.backlogCount = 0`
- `dlq.backlogCount = 0`
- `projection.stuckCount = 0`

値はCloudflare Queuesのpoint-in-time近似値である。単発のmain Queue backlogは
通常処理中でも発生し得る。HTTP 503が2回連続、または5分以上続いた場合に
incidentとして扱う。

## 初動

1. 新しいroom作成や既存roomの利用を直ちに止めない。
2. 失敗roomは`closing`のままにし、再入室可能へ戻さない。
3. Realtime Workerのversionとdeploy時刻を記録する。
4. Workers Logsで`room cleanup failed`を検索し、`messageId`とerror分類だけを記録する。
5. D1をread-onlyで確認する。

```sh
npx wrangler d1 execute koge-preview \
  --remote \
  --config apps/realtime/wrangler.jsonc \
  --env preview \
  --command "SELECT id, status, cleanup_job_id, cleanup_requested_at
             FROM rooms
             WHERE status = 'closing' AND cleanup_job_id IS NOT NULL
             ORDER BY cleanup_requested_at;"
```

## error分類

| failure | 保持されるfence | 対応 |
| --- | --- | --- |
| R2 delete | DOとD1 | R2 binding/bucket障害を解消して再実行 |
| DO `deleteAll()` | D1 | DO/RPC障害を解消して再実行 |
| D1 delete | D1 | D1障害を解消して再実行 |
| projection fence mismatch | D1 | job bodyを再送せず、room IDとjob IDの不一致を調査 |
| invalid job/object key | 全対象 | 再送禁止。schema/versionと生成元を調査 |

## DLQ調査

Cloudflare DashboardのQueuesから
`koge-room-cleanup-preview-dlq`を開き、messageをpeekする。

確認するfield:

- `v = 1`
- `jobId`
- `roomId`
- `closeRequestId`
- `requestedAt`
- `snapshotObjectKeys`

`snapshotObjectKeys`はすべて
`rooms/{roomId}/snapshots/`から始まる必要がある。token、cookie、メールアドレスが
含まれていた場合は再送せずsecurity incidentとして扱う。

## 復旧

1. 原因を修正してRealtime Workerをdeployする。
2. DLQ message bodyを変更せずmain Queue
   `koge-room-cleanup-preview`へ1件だけ再送する。
3. `/health/cleanup`がHTTP 200へ戻るまで確認する。
4. D1から対象room行が消えたことをread-only queryで確認する。
5. main Queue側の成功確認後にだけ、元DLQ messageをackする。

同一jobの重複実行はD1 `cleanup_job_id`でfenceする。D1 room行が既にない場合は
完了済みとしてackされる。

## 禁止事項

- QueueまたはDLQ全体をpurgeしない。
- job bodyのroom ID、job ID、object keyを手編集しない。
- D1 room行を先に手動削除しない。
- R2 prefixやDO storageを手動で一括削除しない。
- report/evidence対象roomを通常cleanupへ再送しない。
- secretやmessage body全体をticket、chat、公開logへ貼らない。

## 解決条件

- `/health/cleanup`がHTTP 200
- main Queue / DLQ backlogが0
- `projection.stuckCount`が0
- 対象D1 room行がない
- 同じ失敗が15分再発しない

## 公式資料

- https://developers.cloudflare.com/queues/observability/metrics/
- https://developers.cloudflare.com/queues/configuration/dead-letter-queues/
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#deleteall
