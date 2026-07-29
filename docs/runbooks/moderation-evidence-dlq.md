# Moderation evidence Queue / DLQ runbook

更新日: 2026-07-28  
対象: `koge-moderation-evidence-preview` /
`koge-moderation-evidence-preview-dlq`

同じQueueは生成job `moderation.evidence`と期限削除job
`moderation.evidence.delete`を扱う。期限削除は毎日03:17 UTC
（12:17 JST）のscheduled scanから投入される。

## 目的

通報証跡の生成が滞留またはDLQへ到達した場合に、証跡未確定のまま通常room
dataを削除せず、同じ固定時点のbundleを安全に再生成する。

## 検知

```sh
curl -fsS https://realtime-preview.koge.app/health/evidence
```

正常条件:

- HTTP 200
- `queue.backlogCount = 0`
- `dlq.backlogCount = 0`
- `projection.stuckCount = 0`

Queue値はpoint-in-timeの近似値である。HTTP 503が2回連続、または5分以上続いた
場合にincidentとして扱う。

## 初動

1. 対象roomはactiveなら継続可能だが、終了時は`closing`から再開しない。
2. D1のevidenceを手動で`committed`へ変更しない。
3. Realtime Worker versionとdeploy時刻を記録する。
4. Workers Logsで`moderation evidence`とmessage IDを確認する。
   削除jobでは`moderation evidence deletion`も確認する。
5. D1をread-onlyで確認する。

```sh
npx wrangler d1 execute koge-preview \
  --remote \
  --config apps/realtime/wrangler.jsonc \
  --env preview \
  --command "SELECT evidence.id, evidence.status, evidence.created_at,
                    evidence.expires_at, report.id AS report_id,
                    report.source_room_id, report.status AS report_status
             FROM evidence_manifests evidence
             JOIN reports report ON report.evidence_manifest_id = evidence.id
             WHERE evidence.status IN ('pending', 'failed')
             ORDER BY evidence.created_at;"
```

## error分類

| failure | 安全な状態 | 対応 |
| --- | --- | --- |
| DO plan/event read | D1 pending/failed、元room data保持 | DO/RPC障害を解消して再送 |
| runtime snapshot read/hash | D1 pending/failed、元snapshot保持 | R2 objectとsnapshot manifestを調査 |
| R2 component/manifest PUT | D1 pending/failed、元data保持 | R2障害を解消し同じjobを再送 |
| D1 commit | R2に再利用可能なpartial/complete object | D1障害を解消し同じjobを再送 |
| expiry/job fence mismatch | 全対象保持 | bodyを変更せず生成元を調査 |
| event sequence gap | 全対象保持 | compactionと固定snapshot cursorを調査 |

R2 component keyは決定的なので、同じjobの再送は同じobjectだけを上書きする。
manifestをR2へ書いた後にだけD1を`committed`へ更新する。

## DLQ調査と復旧

Cloudflare Dashboardで`koge-moderation-evidence-preview-dlq`を開き、
messageをpeekする。`kind = moderation.evidence`、`jobId = evidenceId`、
`reportId`、`roomId`、`requestedAt`、`expiresAt`を確認する。

1. 原因を修正してRealtime Workerをdeployする。
2. bodyを変更せずmain Queueへ1件だけ再送する。
3. D1 evidenceが`committed`、reportが`under_review`になったことを確認する。
4. `/health/evidence`がHTTP 200へ戻ることを確認する。
5. closing roomではcleanupが再起動し、通常dataが削除されることを確認する。
6. 成功確認後に元DLQ messageをackする。

## 禁止事項

- D1 evidenceを手動で`committed`へ変更しない。
- manifestやcomponentのhash/object keyを手編集しない。
- 証跡commit前にroom cleanupを強制しない。
- evidence prefix全体やDLQ全体をpurgeしない。
- 削除jobの`evidenceId`と異なるR2 prefixを削除しない。
- `expires_at`を過去へ書き換えて削除を急がせない。
- manifest、report本文、内部subject IDを公開logやticketへ貼らない。

## 解決条件

- `/health/evidence`がHTTP 200
- main Queue / DLQ backlogが0
- `projection.stuckCount`が0
- 対象evidenceが`committed`
- R2 manifestが存在する
- closing roomの通常cleanupが完了する

## Preview recovery probe

実Queueのduplicate、DLQ検知、bodyを変更しない再投入は
[`../../tools/cloudflare-queue-recovery-probe/README.md`](../../tools/cloudflare-queue-recovery-probe/README.md)
の限定toolで確認する。

- 製品evidenceを失敗fixtureに使わない。
- `evidence_dlq_probe_` prefixの専用IDだけを使う。
- main Queue / DLQ backlogが0であることを開始前に確認する。
- rescue consumer接続中は他のDLQ messageがないことを確認する。
- 終了後にconsumer、probe Worker、D1 fixtureを必ず削除する。
- 最終的に`/health/evidence`がHTTP 200へ戻るまで完了扱いにしない。

## 公式資料

- https://developers.cloudflare.com/queues/observability/metrics/
- https://developers.cloudflare.com/queues/configuration/dead-letter-queues/
- https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
