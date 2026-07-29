# Production room provisioning incident

発生日・復旧日: 2026-07-29

## 影響

productionで新規room作成が失敗し、利用者には
「ルームの準備に失敗しました。もう一度お試しください。」と表示された。
障害時間中に7件のroom projectionが`waiting / failed /
REALTIME_INIT_FAILED`としてD1へ残った。既存の正常roomと認証経路は削除対象に
含めていない。

## 原因

Webのroom provisioning producerは`theme` fieldを送らない新しいpayloadへ更新されて
いた。一方、先に配備されていたRealtimeのconsumerは、同じprotocol versionで
`theme: string | null`を必須としていた。

WebとRealtimeの配備versionがずれた状態でService Binding requestが400となった。
Realtime `/health`はWorker起動とbindingが正常だったため200を返し、payloadの
意味的な非互換は検出できなかった。

## 復旧

次の順でproductionを揃え、段階ごとに停止確認を行った。

1. D1 migration `0018`、`0019`を適用し、未適用0件を確認。
2. Realtimeを配備し、versionと`/health`のproduction bindingを確認。
3. Snapshotを配備し、versionとQueue producer / consumerを確認。
4. Webを配備し、Realtime Service Bindingを確認。
5. HTTP smoke後、ログインユーザーが実roomを作成し、入室・描画できることを確認。

復旧後のversion:

| 対象 | version / 結果 |
| --- | --- |
| D1 | `0001`〜`0019`、未適用0 |
| Realtime | `75f49cef-cd8b-4114-b5f1-7bbb14335693` |
| Snapshot | `00da91cf-5665-416f-b9df-3da5c0ef6868` |
| Web | `0eb82710-790d-4bcf-92b4-5c5a3a5e1c0f` |

## 障害データの削除

利用者による正常roomの作成・入室・描画確認後、障害中の7件を削除した。
削除条件は事前に記録した7 IDに加え、`status = 'waiting'`、
`provisioning_status = 'failed'`、
`provisioning_error_code = 'REALTIME_INIT_FAILED'`をすべて満たす行に限定した。

削除前に、対象roomのinvite、membership、BAN、report、evidence manifest、
moderation actionがすべて0件であることを確認した。D1の実行結果は
`changes = 7`。削除後は次をread-onlyで確認した。

- 対象7 IDの残存: 0
- `REALTIME_INIT_FAILED`の残存: 0
- 正常な`ready` room: 1
- D1の未適用migration: 0

この削除はproduction D1の外部状態を変更した。必要な場合は、保持期間内のD1
Time Travelを使う復旧手順をCloudflare側の現行設定と公式手順で確認する。

## 再発防止

- `packages/protocol`またはWorker間payloadを変更した配備をWeb単独で行わない。
- D1 → Realtime → Snapshot → Webの順をproduction runbookの正本とする。
- field変更はconsumer-firstのexpand / contractを使う。
- 後方互換にできない変更はprotocol versionを上げる。
- 配備前後の3 Worker versionとD1 migration状態を記録する。
- Realtime healthだけで完了とせず、認証済み実roomの作成、自動開始、入室、描画、
  chat、復帰を必須smokeとする。
- 新しいprovisioning失敗が発生した時点で配備を停止し、room作成停止とrollbackを
  判断する。

判断は
[`../decisions/0011-coordinated-production-deployment.md`](../decisions/0011-coordinated-production-deployment.md)、
実行順は
[`../setup/production-deployment.md`](../setup/production-deployment.md)を正本とする。
