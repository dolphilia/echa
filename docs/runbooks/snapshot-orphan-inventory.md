# Runtime snapshot orphan inventory runbook

更新日: 2026-07-28  
対象: `koge-runtime-snapshots-preview` / `koge-preview`

## 目的

room cleanupの失敗や旧実装の残存によって、D1 roomまたはDO runtime stateから
参照されなくなったR2 snapshotを検出する。定期scanは読み取り専用であり、
R2 objectを自動削除しない。削除はlocalhost限定operatorによる計画・確認・再検証の
別工程とする。

## 自動scan

Realtime Workerの毎日03:17 UTC（12:17 JST）のscheduled handlerで実行する。

- 対象key:
  `rooms/{roomId}/snapshots/staging/{jobId}.kgs`
- uploadから1時間未満はin-flightとして除外する。
- D1 roomがないobjectは`room_missing`。
- D1 roomはあるがDOのjob/manifestにないobjectは`unreferenced`。
- 最大10,000 object、500 roomでfail closedに停止する。
- 完了scanだけが現在のinventoryを置き換える。失敗時は直前のinventoryを保持する。

## 検知

```sh
curl -fsS https://realtime-preview.koge.app/health/orphan-snapshots
```

正常条件:

- HTTP 200
- `latest.status = completed`または初回scan前の`latest = null`
- `inventory.count = 0`

HTTP 503はscan失敗・実行中・孤児1件以上のいずれかを表す。
responseは件数とbyte数だけを返し、object keyは公開しない。

## 手動scan

repository内のlocalhost限定toolを使う。

```sh
npm run orphan-snapshots:operator
```

別terminalで1回だけ実行し、完了後にdev processを停止する。

```sh
npm run orphan-snapshots:scan
```

toolは専用のremote Service Entrypointを使う。deployされず、公開endpointを
作らない。通常Webが使う`RoomProvisioningService`から削除操作を分離する。

## 調査

最初にobject keyを表示せず、理由別に集計する。

```sh
npx wrangler d1 execute koge-preview \
  --remote \
  --env preview \
  --config apps/realtime/wrangler.jsonc \
  --command "SELECT reason,
                    COUNT(*) AS object_count,
                    SUM(object_bytes) AS object_bytes,
                    MIN(uploaded_at) AS oldest_uploaded_at,
                    MAX(uploaded_at) AS newest_uploaded_at
             FROM snapshot_orphans
             GROUP BY reason
             ORDER BY reason;"
```

個別keyは、削除候補を承認する担当者だけがD1から確認する。公開log、issue、chatへ
貼らない。

## 削除判断

次の全条件を満たすまで削除しない。

1. 連続する2回以上の完了scanで同じobjectが検出される。
2. `room_missing`ならD1 roomが存在しないことを再確認する。
3. `unreferenced`ならDO inventoryにないこととsnapshot jobが実行中でないことを
   再確認する。
4. 未解決reportのmoderation evidence objectではないことをprefixで確認する。
5. 削除対象keyの一覧を人が確認し、明示的に承認する。

## 削除計画

計画作成は新しいscanを実行し、連続する2回以上の完了scanに残る候補だけを
最大100件選ぶ。R2 `head()`でsize、upload時刻、etagも固定し、計画全体を
SHA-256 hashで封印する。

```sh
plan_dir="$(mktemp -d /private/tmp/koge-orphan-plan.XXXXXX)"
plan_file="$plan_dir/plan.json"
npm run orphan-snapshots:plan -- --out "$plan_file"
```

計画ファイルはobject keyを含む。toolはmode `0600`で新規作成し、既存ファイルを
上書きしない。repository、共有folder、issue、chatへ置かない。計画は30分で
失効する。

## 明示承認と適用

別の確認者が全key、reason、件数、byte数を確認してから、計画出力のconfirmationを
完全一致で指定する。

```sh
npm run orphan-snapshots:apply -- \
  --plan "$plan_file" \
  --confirm 'DELETE <plan-hash> <object-count>'
```

適用直前にさらにscanし、現在のD1 / DO参照関係とR2 metadataを計画へ照合する。
1件でも変化していれば何も削除せず停止する。削除は計画に含まれる完全一致keyだけへ
R2 bindingで行い、直後に`head()`がnullであることを確認する。

D1 `snapshot_orphan_deletion_runs`へ計画hash、scan ID、集計結果を、
`snapshot_orphan_deletion_items`へobject keyのSHA-256 hashと結果を記録する。
生のobject keyは監査表とWorkers logへ保存しない。適用後は再scanし、
計画ファイルを削除する。

## 禁止事項

- `/health`が503という理由だけで自動削除しない。
- `rooms/`全体やroom prefix全体を削除しない。
- 1時間のgrace periodを短縮して実行中jobへ近づけない。
- scan失敗時にD1 inventoryを空にしない。
- moderation evidence prefixをruntime snapshotとして扱わない。
- plan fileをrepositoryへcommitしない。
- plan hashや件数だけを見て、object keyの目視確認を省略しない。
- 通常Web用Service Entrypointへ削除操作を追加しない。

## 2026-07-28 preview初回結果

- completed scan: 1
- mature runtime snapshot: 10 object / 66,207 bytes
- `room_missing`: 10 object / 66,207 bytes
- `unreferenced`: 0
- upload範囲:
  2026-07-27T08:11:16.594Z–2026-07-27T14:34:37.745Z
- R2自動削除: 0

これらは旧preview試験roomの候補として保持する。削除は上記の再確認と明示承認を
別工程で行う。

## 2026-07-28 preview初回削除結果

- 連続scanで`room_missing` 10 object / 66,207 bytesを確認
- plan作成、全key目視確認、plan hashと件数による明示承認: pass
- 適用直前scanとR2 metadata再検証: pass
- deleted: 10 object / 66,207 bytes
- already missing / skip: 0
- 適用後inventory: 0 object / 0 bytes
- `/health/orphan-snapshots`: HTTP 200
- D1 audit: completed 1 run / deleted 10 item
- 承認用plan file: 適用後に削除

削除したR2 objectは復元できない。監査表にはplan hash、集計値、object key hashを
保持し、生のobject keyは保持しない。

## 公式資料

- https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- https://developers.cloudflare.com/r2/api/workers/workers-api-usage/
- https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
