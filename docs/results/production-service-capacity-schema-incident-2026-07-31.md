# Production service capacity schema incident

日付: 2026-07-31

## 影響

- `https://koge.app/`がHTTP 500となり、トップページを表示できなかった
- `/api/rooms`、既存room画面、room thumbnail、Realtime healthはHTTP 200だった
- RealtimeのD1、Durable Objects、Queue、R2 bindingは正常だった

## 原因

production D1では旧内容の`0021_service_capacity_limits.sql`が適用済みだった。
その後、同じmigration fileへ`public_rooms_only`列が追加されたため、D1の
`d1_migrations`には0021適用済みと記録されている一方、実tableには列が存在しない
状態になった。

Webのトップページは`readServiceCapacityLimits`から同列を読み取るため、
server renderingがSQLite `no such column: public_rooms_only`で失敗した。

## 復旧

1. productionのmigration履歴、`PRAGMA table_info`、対象row数をread-onlyで確認
2. リポジトリの0021をproductionへ実際に適用された旧内容へ戻した
3. 列追加を新しい`0022_public_room_visibility_limit.sql`へ分離
4. 一時ローカルD1で0001〜0022を新規適用
5. Webのroom test 14件、admin test 8件を実行し、全件pass
6. production D1へ0022だけを適用

Worker codeの再配備は行っていない。

## 復旧後確認

- production D1未適用migration: 0
- `service_capacity_limits.public_rooms_only`: 存在
- `service_capacity_limit_actions.public_rooms_only`: 存在
- 現行設定: revision 1、live room 20、participant 5、viewer 15、
  public rooms only false
- `https://koge.app/`: HTTP 200
- `https://koge.app/api/rooms`: HTTP 200
- `https://realtime.koge.app/health`: HTTP 200
- ブラウザ表示: トップページ正常、console warning / error 0

## 再発防止

- remoteへ一度でも適用したmigration fileを変更しない
- 追加schemaは必ず新しい連番の前進migrationへ分離する
- `migrations list`だけでなく、追加columnと初期値をread-only queryで確認する
- migration変更を含む配備では、新規の一時ローカルD1へ全migrationを適用する
