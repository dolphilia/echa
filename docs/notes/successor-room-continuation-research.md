# 後継ルームによる描画継続の調査メモ

記録日: 2026-07-30  
状態: 調査中。後継ルーム方式を有力候補とするが、正式な仕様決定ではない

## この文書の目的

現在のルーム時間・drawing event上限を維持しながら、利用者が同じキャンバスの
続きを長く描けるようにする方法を整理する。

特に、終了するルームのキャンバスだけを新しいルームへ引き継ぐ
「後継ルーム」方式について、採用理由、引き継ぐ情報、安全条件、実装上の論点を
計画書作成前の調査メモとして残す。

実装済みの現在仕様は`docs/spec/`、採用済み判断は`docs/decisions/`を優先する。

## 背景

現在の主な安全弁は次のとおりである。

- 新規stroke受付のsoft limitは93,000 drawing events
- hard limitは100,000 drawing events
- drawing event payloadのsoft limitは56MiB、hard limitは64MiB
- 最大開催時間は2時間
- soft limit以降は新しいstrokeを受理せず、開始済みstrokeを完了して終了する

過去の1人・約10分fixtureでは、1人あたり約403.6 events / 実時間分だった。
同程度の利用密度を単純合算すると、93,000 eventsまでの目安は1人で約3時間50分、
2人で約1時間55分、5人で約46分、10人で約23分となる。

snapshot-first recoveryは成立しているが、snapshot生成やevent compactionを行っても、
ルーム作成後の累計drawing event数と累計payload byte数はリセットしない。
snapshotは復帰・保存負荷を軽くするものであり、それだけでルームを長く開催できる
ようにはならない。

関連資料:

- [`drawing-chat-service-design-foundation.md`](./drawing-chat-service-design-foundation.md)
- [`../decisions/0007-snapshot-first-recovery.md`](../decisions/0007-snapshot-first-recovery.md)
- [`../results/phase3-snapshot-compaction.md`](../results/phase3-snapshot-compaction.md)
- [`../spec/room-lifecycle.md`](../spec/room-lifecycle.md)

## 検討した方法

### 累計event上限を単純に引き上げる

実装は比較的単純だが、荒らし、保存量、障害調査、room close、snapshot失敗時の
fallback範囲も同時に大きくなる。上限を引き上げる場合は150,000、250,000、
400,000 eventsのcold replay、複数同時復帰、DO SQLite、Worker CPUの再測定が
必要になる。

### append batchingを強くする

append間隔や1 eventあたりのpoint数を増やせば、同じ描画量に対するevent数を
減らせる。ただし、短いstrokeではbegin/endの比率が高いため効果が限られる。
未確定範囲、反映遅延、frame sizeも増えるため、補助的な最適化とする。

### snapshot後に累計上限をリセットする

同じルームを長く開催できる一方、snapshotを跨いで無制限にeventを生成できる。
復旧用tailの上限と、生涯活動量・荒らし対策のカウンターを分離しない単純な
リセットは採用しない。

### snapshot epochを導入する

同じルームを複数epochへ分け、epochごとの復旧用上限と、ルーム全体の生涯上限を
別に管理する方法である。trueな同一ルームを長く維持する必要が明確になった場合の
候補だが、protocol、復旧、運用、障害時fallbackの変更範囲が大きい。

### ホストによる時間延長

初期2時間に対して1時間単位などで延長する方法である。時間だけ延ばしてもevent上限
へ先に到達するため、epochまたは上限変更と組み合わせる必要がある。

### 後継ルームを作成する

現ルームを安全に終了し、確定したキャンバス状態を初期状態とする新しいルームを
作る。新ルームは新しいURL、event log、活動量カウンター、開催時間を持つ。

現在の「1ルームは短く、安全に終了する」「制限後は次のルームへ移る」という
プロダクト方針を維持しながら、利用者には続きを描く導線を提供できる。このため、
現時点の有力候補とする。

## 有力候補: 後継ルーム方式

### 基本方針

- 後継ルームは通常の新規ルームとして扱う。
- 新しい32文字slugとURLを発行する。
- 現ルームの確定済みキャンバスだけを初期キャンバスとして引き継ぐ。
- 新ルームのdrawing eventはroomSeq 1から始める。
- event数、payload byte数、開催時間は新ルームで0から開始する。
- 現ルームは通常のroom close順序に従って終了・削除する。
- 後継ルームが利用可能になる前に現ルームの正本を削除しない。

### 引き継ぐ情報

必須候補:

- canonical rendererで確定した1000 x 1000 RGBAキャンバス
- renderer version、protocol version、canvas generation
- RGBA hashとsnapshot object hash
- 元ルームと後継ルームを運用上追跡するための非公開のcontinuation識別子
- 元ルームのホストを後継ルームのホストとするための所有者情報

検討候補:

- ルーム名
- 公開・非公開、描画参加設定などのルーム設定
- ルーム単位のbanやmoderation状態
- 参加者へ後継ルームを案内するための短時間の遷移情報

### 引き継がない情報

現時点では次を引き継がなくてよいと考える。

- チャット履歴
- 元ルームのURLとslug
- 元ルームのdrawing event log
- 元ルームのevent・payload活動量カウンター
- 元ルームの開催開始時刻と残り時間
- presence、remote cursor、WebSocket接続
- 未確定stroke
- 招待URLとinvite token

参加者は新しいURLへ移動し、改めて入室・ロール選択・WebSocket接続を行う。
チャットは空の状態から始める。

## 想定する利用者フロー

1. 時間または活動量上限が近づいたことを現在の通知方式で案内する。
2. ホストのルームメニューへ「このキャンバスの続きで新しいルームを作る」を表示する。
3. 確認画面で、チャットとURLは引き継がれないことを説明する。
4. 新しいstroke開始を一時停止し、開始済みstrokeの確定またはキャンセルを待つ。
5. target roomSeqを固定し、引き継ぎ用snapshotを生成・検証する。
6. 新しいslug、D1 projection、Durable Objectを冪等にprovisionする。
7. snapshotを新ルームの初期キャンバスとしてcommitする。
8. 新ルームが入室可能になったことを確認する。
9. 現ルームの接続中利用者へ新しいルームへの案内を表示する。
10. ホストが移動するか、一定猶予後に現ルームを通常終了する。

自動遷移だけにすると参加者が状況を理解しにくいため、まずはホストの明示操作を
起点とする案を推奨する。

## snapshotの扱い

後継ルームの初期状態は、完成画像やギャラリー作品ではなく、開催中の復旧用
runtime snapshotとして扱う。

現ルームのR2 objectをそのまま参照すると、現ルームcleanupで削除される。
そのため次のどちらかが必要になる。

1. 検証済みsnapshotを後継ルームのR2 namespaceへコピーし、新manifestをcommitする。
2. 引き継ぎ専用objectを作り、後継ルームのcommit完了まで削除をfenceする。

1の方がroom close後の所有関係とcleanupが単純になるため有力である。

後継ルームでは、引き継いだRGBAを`baseRoomSeq = 0`相当のgenesis snapshotとして
扱い、その後のstrokeをroomSeq 1から適用する案を優先して検証する。既存manifestが
正の`baseRoomSeq`だけを前提としている箇所、current/previous fallback、snapshot
generationの単調性についてはspikeで確認する。

## 安全条件

後継ルームを作成できるのは、少なくとも次をすべて満たす場合とする。

- 操作者が現ルームのホストである。
- 現ルームがactiveまたはidleで、close処理中ではない。
- active strokeがない、または安全に確定・キャンセルできる。
- canonical rendererが利用可能である。
- snapshotのR2保存、hash検証、manifest commitが成功する。
- 後継ルームのD1 projectionとDO provisioningが完了する。
- 新規ルーム作成の緊急停止が有効ではない。
- moderation evidenceの保全fenceと競合しない。

途中で失敗した場合は後継ルームを公開せず、現ルームを元の状態のまま継続するか、
既存の上限到達処理で終了する。現ルームのeventやsnapshotを先に削除しない。

## 現在仕様との衝突

### 1ユーザー1ルーム制限

現在は、ホストがactive、idle、waiting、suspendedのルームを持つ間、新しいルームを
作成できない。後継ルーム作成では一時的に新旧2ルームが必要になるため、通常の
作成APIをそのまま利用できない。

後継ルーム専用の原子的なhandoff処理を用意し、次を保証する必要がある。

- 同じ元ルームから複数の後継ルームを作らない。
- 後継ルーム作成中だけ所有者の2ルーム状態を許容する。
- 後継ルームがreadyになった後だけ元ルームをclosingへ進める。
- 失敗時は作成途中のprojection、DO、R2 objectを回収する。

### 上限回避

後継ルームはevent数と時間をリセットするため、繰り返せば実質的に長時間利用できる。
これは意図した機能である一方、無制限な資源利用にならないよう、次のchain単位の
観測または安全弁を検討する。

- continuation chain全体のルーム数
- chain全体の経過時間
- chain全体の累計eventsとpayload bytes
- 同一ホストの作成頻度
- moderation・rate abuse signal

初期導入では上限値を推測で固定するより、メトリクスを必ず保存し、closed betaの
実測後にchain上限を決める。

### moderation

service banは当然すべての後継ルームへ適用される。room banを後継ルームへ
引き継ぐかは未決である。引き継がない場合、後継ルーム作成がroom ban回避に
使われる可能性があるため、少なくとも短時間のcontinuation chain内では引き継ぐ案を
検討する。

通報証跡がある現ルームは、通常のsnapshot引き継ぎと証跡保全snapshotを混同せず、
それぞれ独立したobject、retention、cleanup fenceを使用する。

## UI案

ホスト向けメニュー:

- `このキャンバスの続きで新しいルームを作る`
- 上限が近い場合は終了予告ダイアログにも同じ操作を表示する

確認文の要点:

- キャンバスだけを引き継ぐ
- 新しいURLになる
- チャットは引き継がれない
- 参加者は新しいルームへ入り直す
- 元ルームは終了し、再入室できない

参加者向け:

- 後継ルームがreadyになるまで`続きを準備しています`と表示する
- ready後に`新しいルームへ移動`を表示する
- 自動リダイレクトを採用する場合も、利用者が理解できる数秒の案内を挟む
- 移動しなかった利用者向けに、新URLをコピーできるようにする

## 利点

- 1ルームあたりのevent、時間、障害影響範囲を現在のまま維持できる。
- snapshot compaction済みルームをさらに複雑なepochへ拡張しなくてよい。
- 新ルームは小さいtailから始まるため、復帰性能が安定する。
- 古いevent、チャット、接続状態を引き継がずに済む。
- 現在のroom close、cleanup、moderation evidence fenceを再利用しやすい。
- 将来、同一ルームepochが必要かを利用実績から判断できる。

## 欠点

- URLが変わり、参加者の再入室が必要になる。
- snapshot handoff用のR2 copy、manifest、provisioningが必要になる。
- 新旧ルームが短時間共存するため、1ユーザー1ルーム制限との調整が必要になる。
- handoff中の失敗回収と冪等性が必要になる。
- chain単位の荒らし・利用量観測を追加する必要がある。
- ルーム名、公開設定、banをどこまで引き継ぐか決定が必要になる。

## 実装計画前に決める事項

1. 継続操作を常時表示するか、上限の80%以降だけ表示するか。
2. ホストの明示操作だけにするか、上限到達時に自動提案するか。
3. ルーム名と公開・参加設定を引き継ぐか。
4. room banをcontinuation chainへ引き継ぐか。
5. 参加者を自動遷移させるか、移動ボタンだけにするか。
6. 後継ルームがreadyになってから元ルームを閉じるまでの猶予時間。
7. genesis snapshotのmanifest表現と`baseRoomSeq`の扱い。
8. R2 copyと旧ルームcleanupの所有権・fence。
9. 1ユーザー1ルーム制限におけるhandoff例外のtransaction境界。
10. continuation chainのメトリクスと最終安全上限。
11. 新規ルーム作成の緊急停止中に継続を許可するか。
12. handoff失敗時のUI、retry、途中データ回収。

## 推奨する次の調査

1. fixture snapshotを別roomのgenesisとして読み込み、同じRGBA hashになるか確認する。
2. genesis適用後のroomSeq 1以降を描画し、再読み込み後も一致するか確認する。
3. R2 copy、manifest commit、元room closeを故障注入付きで試験する。
4. 1ユーザー1ルーム制限を壊さないhandoff用D1 transactionを設計する。
5. 2ブラウザを元ルームから後継ルームへ移動させるE2Eを作る。
6. 通報証跡があるルームでhandoffとcloseを競合させ、証跡が失われないか確認する。

これらが成立してから、正式なdecision record、lifecycle仕様、data model、
protocol変更、実装計画を作成する。
