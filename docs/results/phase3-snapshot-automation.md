# Phase 3: snapshot automation

更新日: 2026-07-28

状態: local実装・自動試験、preview `shadow`縦切り完了。自動削除は無効

## 実装

Durable Objectへsnapshot生成とcompactionの自動orchestrationを追加した。

- `SNAPSHOT_AUTOMATION_MODE`: `off` / `shadow` / `compact`
- 初回trigger: 50,000 drawing eventsまたは16MiB logical payload
- 再生成trigger: 直近jobから10,000 eventsまたは4MiB増加
- 判定境界: clientの`stroke.end` / `stroke.cancel`、server timeout end
- active stroke、queued job、closing roomがある場合は生成しない
- jobへtrigger種別と作成時点の単調増加counterを保存する
- `compact`時はmanifest commit後にDO alarmで最大500 eventsずつ削除する
- `compact`からflagを下げると、未実行のcompaction予約を破棄する

localとpreviewの初期modeは`shadow`である。snapshot jobは自動生成するが、
event logは削除しない。Gate Bはpassしたが、通常roomでの`compact`有効化は
Phase 6の終了cleanupと監視後に段階導入する。

## 安全性

- snapshot jobの既存unique境界で同一targetの重複を防ぐ。
- Queueはat-least-onceとして扱い、consumer、R2 staging、manifest commitは
  既存の冪等経路を使う。
- compactionはcurrent job一致、previous境界、queued source保護を毎chunkで
  再検証する。
- room close transactionでqueued jobをsupersededにし、compaction予約も消す。
- schema更新前のjobは移行時点の総event / payload counterを基準値へ設定し、
  既存roomで直後に不要なsnapshotが再生成されることを防ぐ。

## 検証

- policy unit test:
  - mode validation
  - inactive / active stroke / queued jobの抑止
  - 初回event / payload trigger
  - 再生成delta
  - compactだけがdeletionを予約すること
- Durable Object integration test:
  - 50,000 events到達時に自動jobが1件だけ作られる
  - 再判定で重複jobを作らない
  - Durable Object再初期化後もjobと自動化状態を復元する
  - trigger metadataをSQLiteへ保存する
  - shadow modeのalarmがpending compactionを破棄する

実行結果:

```text
Test Files  3 passed (3)
Tests      21 passed (21)
```

リポジトリ全体の`npm run check`とRealtime Workerの
`cf:types:check`も成功した。

## Preview確認

- Realtime Worker version:
  `fd05237b-8c65-4a51-8091-3a97e7c818be`
- Worker startup time: 7ms
- probe room: `snapshot-probe-20260727abcd1234`
- mode: `shadow`
- threshold: 50,000 events / 16MiB
- regeneration delta: 10,000 events / 4MiB

公開WebSocket経路から1 stroke、3 events、285 payload bytesを保存した。
completed-stroke後の自動判定は`below_threshold`となり、jobとcompaction予約を
作らず、event 3件を保持した。これにより、previewのschema v13 migration、
room identity保存、feature flag読込、completed-stroke triggerが接続できた。

## Gate B後の確認

50k initial / 10k incrementalのWorker CPU、wall timeとlive broadcast latencyは
2026-07-27に測定した。結果は
[`phase3-snapshot-preview-performance.md`](phase3-snapshot-preview-performance.md)
を参照。

1. ~~GraphQL Analytics APIでSnapshot Workerのmemory usage p999を取得する。~~
   31,596,578 bytes、128 MiB上限の23.5%でpass。
2. ~~限定したpreview roomで`compact`をcanaryする。~~
   70,020 eventsを削除し、current/previous復帰と409 fail-closedを確認。
3. Phase 6の終了cleanupと監視後、通常preview roomの自動compactionを段階導入する。

詳細は
[`phase3-snapshot-preview-performance.md`](phase3-snapshot-preview-performance.md)
と[`phase3-snapshot-compaction.md`](phase3-snapshot-compaction.md)を参照。
