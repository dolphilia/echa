# koge documentation

更新日: 2026-07-31

## 現在地

kogeはMVP主要機能の実装、preview検証、production配備と直近の復旧検証まで
完了している。機械的smoke、利用者E2E、終了後health、Worker Analyticsはpassした。
room provisioning障害は協調配備で復旧し、障害中のfailed projectionも削除済みである。
service capacity migrationの履歴不一致によるトップページ障害は、前進migration
`0022`で復旧済みである。
一般公開前には規約、retention、alert、backup/restore試験、closed betaの
公開運用gateを完了する。

## 文書の読み順

1. [`plans/mvp-implementation-plan.md`](./plans/mvp-implementation-plan.md)
   — 現在の進捗、残作業、Release Gate
2. [`spec/README.md`](./spec/README.md)
   — 実装と試験が従う現行仕様
3. [`decisions/README.md`](./decisions/README.md)
   — 採用済みの重要判断
4. [`setup/README.md`](./setup/README.md)
   — 環境値、外部サービス、配備手順
5. [`runbooks/README.md`](./runbooks/README.md)
   — 障害・管理・削除の運用手順
6. [`results/README.md`](./results/README.md)
   — Phase別検証、性能測定、production配備証跡

## ディレクトリ

| path | 位置づけ |
| --- | --- |
| `notes` | 調査と設計の背景。現在値はspec / decision / planを優先 |
| `spec` | 現行のprotocol、data、lifecycle、recovery仕様 |
| `decisions` | 変更履歴を残すArchitecture Decision Record |
| `plans` | 実装順序、exit criteria、Release Gate |
| `spikes` | 実装前に作成した検証票。結果はresultsへ移行済み |
| `results` | 時点固定の実験・E2E・配備結果 |
| `setup` | local / preview / production設定と外部サービス |
| `runbooks` | 本番運用の検知、判断、復旧手順 |

## 正本の優先順位

矛盾した場合は次の順で判断する。

1. 現在のコード、migration、test、Wrangler config
2. 後から採用されたdecision record
3. `docs/spec`
4. `docs/plans`の現在状態
5. `docs/notes`とprototype

履歴文書である`docs/results`は当時の事実を保持し、現在仕様の代わりにはしない。
実装との不一致を見つけた場合は、コードだけでなく仕様・索引・runbookも更新する。
