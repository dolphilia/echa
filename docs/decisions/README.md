# Decision records

更新日: 2026-07-28

実装経路やデータ境界を変える判断を記録する。採用済みのrecordを変更するときは、元の文書を書き換えて履歴を消さず、新しいrecordでsupersedeする。

| ID | 判断 | 状態 |
| --- | --- | --- |
| [`0001-room-start.md`](./0001-room-start.md) | roomはhostが明示的に開始する | 採用 |
| [`0002-auth-scope.md`](./0002-auth-scope.md) | MVPはGoogle OAuth 1種類、メール認証なし | 採用 |
| [`0003-environments-and-origins.md`](./0003-environments-and-origins.md) | local / preview / productionを分離する | 採用 |
| [`0004-account-deletion.md`](./0004-account-deletion.md) | session失効、room終了、削除jobの順で処理する | 採用 |
| [`0005-phase0-tooling.md`](./0005-phase0-tooling.md) | npm workspace、vinext、独立realtime Workerで開始する | 暫定採用 |
| [`0006-protocol-codec.md`](./0006-protocol-codec.md) | MessagePackと数値wire opcodeを採用する | 採用 |
| [`0007-snapshot-first-recovery.md`](./0007-snapshot-first-recovery.md) | MVPのroom復帰にsnapshot-firstを採用する | 採用 |
| [`0008-temporary-service-bans.md`](./0008-temporary-service-bans.md) | service BANは一時・subject単位・管理者解除可能にする | 採用 |
