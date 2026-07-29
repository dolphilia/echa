# ADR 0007: MVPのroom復帰にsnapshot-firstを採用する

日付: 2026-07-28  
状態: 採用

## 判断

MVPの開催中roomへの新規入室とcold recoveryは、共通WASMレンダラーで生成した
lossless snapshot + tail eventを標準経路にする。

- snapshot未生成のroomとcompaction前の障害ではevent log先頭から再生できる。
- current snapshotが使えない場合はprevious snapshot + bridge/tailへ戻る。
- compaction済みroomで有効なsnapshotがない場合は、不完全なキャンバスを返さず
  `409 SNAPSHOT_RECOVERY_REQUIRED`でfail-closedする。
- compactionは`event_log_only -> shadow -> snapshot_compacted`の前方向遷移とし、
  一度eventを削除したroomをevent log-onlyへ戻さない。
- 通常roomの自動compactionは段階導入する。Phase 6の終了cleanupと監視を完成し、
  preview canary、closed betaの順に対象を広げる。

## Gate Bの根拠

- Browser / Workersのcanonical RGBA hash: 9/9一致
- 100k local recovery p50:
  - full replay 18.25秒
  - snapshot + 約1,000-event tail 178.8ms
- preview initial generation:
  - 50,220 events / 217,620 points
  - CPU 17.121秒、30秒上限へ42.9%の余裕
  - memory p999 31,596,578 bytes、128 MiB上限へ76.5%の余裕
- preview incremental generation:
  - 10,020 events / 43,420 points
  - CPU 3.891秒
- 20接続・約400 events/sとの同時実行:
  - broadcast欠落0
  - incremental runのACK p95 196.7ms
- Queue重複、R2/metadata/hash/version不整合、current/previous fallback、
  room close競合、chunk compactionを試験済み
- 70,020 eventsを削除するpreview canary後も、current + 3,960 tailと
  previous + 9,960 bridge/tailの両経路がroomSeq 79,980へ復帰

## 採用時の制約

- snapshotは完成画像やギャラリー用データではなく、開催中roomの一時的な復帰データ。
- room終了時にevent log、manifest、current/previous/staging objectを削除する。
- 通報証跡として保全する場合だけ、通常データと分離した期限付き保存を行う。
- 総event数・総payload bytesの活動量上限はcompactionでリセットしない。
- protocol / renderer / codec version不一致を近似せず、互換経路またはfail-closedを使う。

## ロールバック方針

全体flagを停止した場合、新規roomとまだcompactionしていないshadow roomは
event log-onlyへ戻せる。すでにcompaction済みのroomはsnapshot + tailを維持し、
終了まで運用する。

## 残る実装

- Phase 6の通常終了・通報時cleanupとorphan R2再試行
- snapshot success / age / fallback / hash mismatch / cleanup failureの監視
- previewでの自動compaction canaryとclosed beta rollout
