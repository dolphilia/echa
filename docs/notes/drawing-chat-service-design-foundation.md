# koge お絵描きチャットサービス設計整理

記録日: 2026-07-26
更新日: 2026-07-29
状態: 設計ベース。MVP実装、preview検証、production初回配備へ反映済み
対象: v2モックアップをkoge Webサービスへ移行するための前提整理

## この文書の目的

この文書は実装計画書そのものではない。

これまでの技術調査、画面設計、モックアップで決めたことを同じ前提へ揃え、計画書を作る前に必要な情報をまとめる。採用済みの方向性、MVP と将来機能の境界、技術的な注意点、未決事項を分離し、実装時にモックアップの見た目だけをそのまま仕様扱いしないための基準にする。

この設計ベースから作成した実装計画は`docs/plans/mvp-implementation-plan.md`を参照する。
実装後に変更された現在値は`docs/spec/`、採用判断は`docs/decisions/`、
検証結果は`docs/results/`を優先する。

## 参照資料

- `docs/notes/drawing-chat-tech-stack-research.md`
  - Cloudflare Workers、Durable Objects、D1、R2 を中心とした技術調査
  - MVP の技術構成、段階分け、コスト、荒らし対策
- `docs/notes/unified-home-room-list-design.md`
  - トップページとルーム一覧の統合方針
  - 非ログイン／ログイン後の情報設計
- `prototypes/v2/rooms/index.html`
  - 統合ホーム、ルーム一覧、ゲスト参加、ログイン後状態、ルーム作成
- `prototypes/v2/drawing-room/index.html`
  - 描画キャンバス、ツール、カラー選択、パン・ズーム、チャット
- `prototypes/v2/login/index.html`
  - ゲスト設定とアカウントログインの初期案
- `prototypes/v2/gallery/index.html`
  - 完成作品の公開一覧とリアクション
- `prototypes/v2/profile/index.html`
  - プロフィール、作品、参加履歴、フレンド
- `prototypes/v2/help/index.html`
  - 利用案内、FAQ、コミュニティガイドライン

## プロダクトの定義

kogeは、複数人が同じ固定サイズのキャンバスへほぼリアルタイムに描画し、
同じ場所で短文チャットによる交流もできる、お絵描きチャットサービス。

中心となる価値は次の 3 点。

1. URL を開き、少ない準備ですぐ同じキャンバスへ入れる。
2. 他の参加者の筆跡と存在を近い時間感覚で感じられる。
3. 描画、短文チャット、スタンプを同じルーム内で気軽に行き来できる。

一般的な図形ホワイトボード、個人向け高機能ペイントソフト、動画配信サービスを目指すものではない。

## 設計原則

### 参加までを短くする

- 公開ルームはアカウントなしでも観覧・参加できる。
- ゲストはニックネームと参加カラーだけを決める。
- サービス紹介ページを経由させず、統合ホームからルームへ直接入れる。

### 描画の体感を優先する

- ローカルの筆跡は通信確認を待たず即時表示する。
- React の再レンダリングを描画 hot path に入れない。
- 通信、永続化、チャットが遅くてもローカルの線が遅延しない構造にする。

### 共同編集の正しさは stroke 単位で扱う

- ピクセル画像全体を高頻度に同期しない。
- 入力開始から入力終了までを 1 stroke とする。
- 線の色、サイズ、濃度、ツール種別は stroke 開始時に固定する。
- 再送、監査、将来の限定undoも stroke ID を基準にする。

### MVP と将来像を混同しない

- モックアップに表示されている機能が、すべて初期リリース対象とは限らない。
- 認証、セッション、ルーム所有権は MVP に含める。
- ギャラリー、詳細プロフィール、フレンド、通知、パレット同期は将来像として保持し、MVP の必須要件から分離する。
- 共通WASMレンダラーとsnapshot-first recoveryはGate Bをpassして採用済み。
  event log全再生はfallbackとして維持する。
- 将来機能を妨げない ID・権限・データ境界だけを先に用意する。

## 現在の画面・機能範囲

### 統合ホーム／ルーム一覧

モックアップ上の機能:

- 現在のルーム数・参加人数
- 開催中ルームのカード一覧
- 検索、フィルター、並び替え
- 参加可能、満員、観覧可能、開始前の表示
- ゲスト参加時のニックネーム・カラー設定
- ログイン後の参加中・最近見たルーム
- ログイン後のルーム作成
- 公開、リンク限定、フレンド限定の公開設定案

### お絵描きルーム

現在のモックアップで確定度が高いもの:

- 960 x 640 の白い固定キャンバス
- キャンバスの表示サイズはウィンドウ変更では変えず、ズームだけで変更
- ブラシ
- 消しゴム
- スポイト
- ズームツール
- ブラシサイズ
- 濃度
- カラー選択
  - サークル
  - スクエア
  - HSB/RGB スライダー
  - HEX
  - 保存済みパレット
- undo / redo（モックに存在するがMVPから削除予定）
- Space + ドラッグによるパン
- ホイールズーム
- スクラブズーム
- 参加者表示
- チャット
- スタンプ
- チャットの開閉
- 招待
- 保存操作

描画ツールから削除済みのもの:

- ペンという別カテゴリ
- バケツ

### ギャラリー

MVP 対象外の将来像としてモックに含まれるもの:

- 完成した合作の一覧
- 新着、人気、フォロー中
- 参加者表示
- いいね

### プロフィール

将来像としてモックに含まれるもの:

- プロフィール
- 参加ルーム数
- 公開作品数
- もらったいいね
- フレンド数
- 作品
- 参加履歴
- いいねした作品

### ヘルプ

利用案内、FAQ、ショートカット、コミュニティガイドライン、問い合わせを想定している。

ただし現在のヘルプには、削除済みのペン・バケツや、未確定の承認制ルーム、ホストによる参加者単位の描画取り消しなどが残っている。本実装前に仕様と同期させる必要がある。

## ユーザー状態

サービス内の状態は「未ログイン」「ゲスト参加中」「ログイン済み」「管理者」を分ける。

### 未ログイン

- 公開ルーム一覧を閲覧できる。
- 観覧可能なルームを観覧できる。
- 参加操作時にゲスト情報を設定する。
- アカウント専用の履歴、通知、フレンドは利用できない。

### ゲスト

- ブラウザごとの一時的な guest ID を持つ。
- ニックネームと参加カラーを持つ。
- 公開ルームまたは有効な room token を持つルームをviewerとして閲覧できる。
- 描く人は選択できず、描画とチャット送信は利用できない。
- チャットは閲覧できる。
- MVP ではルーム終了後の参加履歴を永続化しない。

ゲスト識別子を IP アドレスそのものにしない。ランダムな guest session ID と、荒らし対策用の短期的な IP/UA hash は用途を分ける。

### ログイン済みユーザー

MVP からアカウント機能を導入する。ただし、初期段階で必須にするのは認証、セッション、ルーム作成者の識別、ルーム所有権の復元までとする。

- ルーム作成
- 自分が作成した開催中ルームの確認
- ホスト権限の復元
- participantとしての描画
- roleを問わないチャット送信

次の機能はアカウント基盤を利用するが、MVP の必須範囲には含めない。

- 参加履歴
- 最近見たルーム
- プロフィール
- ギャラリーへの公開
- いいね
- フレンド
- 通知
- 保存済みカラーパレットの同期

### 管理者

- 問題ルームの停止・削除
- 参加者の kick / BAN
- 通報の確認
- 新規ルーム作成や新規入室の緊急停止
- rate limit やルーム上限の調整

MVP では undo / redo と論理的な stroke revert を持たないため、管理者による個別 stroke の無効化も提供しない。問題がある場合はルーム停止、参加者制限、証跡保全で対応する。

開発中と MVP では、管理ページの入口を Cloudflare Access で保護し、アプリ内でも管理者権限を確認する。

## ルーム内ロール

認証状態とは別に、ルームごとのロールを持つ。

| ロール | 主な権限 |
| --- | --- |
| host | ルーム設定、終了、招待、参加者管理、公開範囲の変更。接続と描画準備の完了後にルームを自動開始する |
| participant | 描画、チャット、スタンプ |
| viewer | キャンバス・presence・チャットの閲覧。ログイン済みならチャットを送信できる |
| moderator | kick、mute、通報対応など運営補助 |

MVP では `host`、`participant`、`viewer` の 3 種類で開始し、複雑な共同管理権限は後回しにする。認証状態とroom roleは分離し、guestはviewerだけ、activeなログインユーザーはparticipantを選択でき、roleを問わずチャットを送信できる。

## ルームのライフサイクル

将来候補を含め、次の状態を区別する。MVPで使用しない状態は後述のとおり除外する。

| 状態 | 内容 |
| --- | --- |
| draft | 作成途中。公開一覧へ出さない |
| waiting | hostの接続・復元・描画準備が完了するまでの開始準備中 |
| active | 描画中 |
| idle | 接続者はいるが、描画・チャットが一定時間なく休止中 |
| closing | 新規操作を止め、接続切断、必要な証跡保全、データ削除を行っている |
| suspended | 通報や管理操作で停止 |
| deleted | 削除完了を表す概念上の終端。永続状態として保持しない |

MVP では `waiting`、`active`、`idle`、`closing`、`suspended`、`deleted` を扱う。終了済みルームを閲覧専用ルームとして保持する `archived` 状態は設けない。

ルームは次の複合条件で終了する。

- host が明示的に終了する。
- 全員退出後、猶予時間を過ぎると終了する。
- 作成から最大開催時間を過ぎると終了する。
- 最終描画・チャットから一定時間が経過したら `idle` にする。
- 管理者は強制終了できる。

初期の暫定値は次のとおりとし、負荷試験と利用状況を見て調整する。

- 全員退出後の終了猶予: 10 分
- 作成からの最大開催時間: 2 時間
- 最終描画・チャットから休止まで: 30 分
- 時間による終了予告: 15 分前、5 分前、1 分前
- event数・byte数による終了予告: 上限の80%、90%、98%

`idle` は終了ではない。接続中の参加者が描画またはチャットを再開すると `active` に戻す。全員退出は `idle` への遷移条件にせず、状態とは別に10分の終了猶予タイマーを開始する。

Durable Object の WebSocket Hibernation はインフラ上の待機状態であり、プロダクト上の `idle` とは独立して扱う。`active` のルームでも接続状況に応じて Hibernation へ入ることがある。

終了時は `closing` へ遷移し、接続中クライアントへ `room.updated(status: closing)` を配信して、新しい描画・チャット・入室を停止する。開始済みstrokeの確定または破棄、必要な通報証跡の保全、`room.closed`配信、WebSocket切断、一覧からの除外、ルーム本体、event log、snapshot manifest、R2上のsnapshotの削除、の順に処理する。終了後の再入室、閲覧専用化、再開は行わない。

通常終了ではルーム行、event log、snapshotを物理削除し、`deleted`を保存しない。APIからは存在しないルームとして扱う。終了前に通報がある場合、または管理者が証跡保全を指定した場合だけ、必要最小限のevent、snapshot、チャット文脈、actor識別子、管理操作履歴を通常のルームデータと分離して期限付きで保存する。証跡の保存が確認できるまでは元event logとsnapshotを削除しない。

証跡保存に失敗した場合は新しい操作を許可しないまま`closing`または`suspended`として保持し、WebSocketは終了理由を通知して閉じる。AlarmまたはQueueで保存を再試行し、管理画面へ通知する。証跡保存を省略して通常削除へ進む操作は、権限と監査記録を必要とする例外とする。

通常終了時のR2 snapshot削除は、ルーム行を消す前にobject keyを冪等なcleanup taskへ登録する。R2削除に一時的に失敗してもルームを再開せず、期限付きのorphan cleanupとして再試行・監視する。

MVP では完成画像をサーバー生成・保存しないため、画像生成やuploadの完了を待つ終了処理は設けない。

時間または活動量の上限へ到達した場合は、hostへ「次のルームを作る」導線を表示する。ルーム名、公開範囲、viewer設定は削除前にクライアントへ渡し、ログイン済みhostが新規ルーム作成APIへ再送できるようにする。削除済みルームのD1行へ依存せず、キャンバスは白紙から開始する。上限は失敗ではなく、共同制作の区切りとして扱う。

## 公開範囲と参加方法

| 公開範囲 | 一覧掲載 | 参加方法 |
| --- | --- | --- |
| public | 掲載する | ゲストまたはユーザーが参加 |
| unlisted | 掲載しない | 招待 token を URL fragment で受け取り、参加 ticket へ交換 |
| friends | ログイン後の対象者だけ | フレンド関係を確認 |
| private | 掲載しない | 明示的な招待 |

MVP では `public` と `unlisted` の 2 種類に絞る。

アカウント機能自体は MVP に含めるが、`friends` と `private` はフレンド関係や高度な招待権限が必要になるため後段とする。

## 描画仕様

### キャンバス

- MVP は 960 x 640 固定。
- 背景は白。
- 画面上のパンとズームはクライアント固有の表示状態であり、共有しない。
- キャンバスの論理座標はズームに依存しない。
- 将来別サイズを許可する場合も、ルーム作成後のサイズ変更は行わない。

### stroke

1 stroke は pointer down から pointer up まで。ブラウザで `pointercancel` が発生した場合、クライアントは可能な限り明示的な `stroke.cancel` を送り、未確定 stroke を破棄する。通信切断などで `stroke.cancel` 自体を送れない場合は、後述する未完了 stroke の自動確定規則を適用する。

最低限保持する情報:

```ts
type Stroke = {
  strokeId: string;
  actorId: string;
  tool: "brush" | "eraser";
  color: number;
  size: number;
  opacity: number;
  points: Array<{
    x: number;
    y: number;
    dt: number;
  }>;
};
```

追加で、プロトコル上は `roomId`、`roomSeq`、`clientSeq`、`canvasGeneration` を持つ。

### 低濃度ストローク

モックアップでは、短い半透明線を区間ごとに本キャンバスへ重ねる方式を廃止した。

入力中は一時キャンバスへ 1 stroke 全体を不透明で再描画し、表示時と確定時に濃度を 1 回だけ適用する。この原則はリモート描画にも必要。

リモートクライアントでも次のように扱う。

1. `stroke.begin` で stroke ごとの一時レイヤーを作る。
2. `stroke.append` で点列を追加し、同じ一時レイヤーを更新する。
3. `stroke.end` で本キャンバスへ濃度を 1 回だけ適用して確定する。
4. 切断や timeout で `stroke.end` が届かない場合の確定・破棄規則を持つ。

区間ごとに `globalAlpha` を適用すると継ぎ目が濃くなるため、受信側でも行わない。

### 消しゴム

現在は白背景固定のため、MVP では白色の stroke として扱える。

将来、透明背景やレイヤーを導入する場合は `destination-out` またはマスクとして意味を変更する必要がある。プロトコルには最初から `tool: "eraser"` を残し、単なる白色ブラシへ変換して送らない。

### 筆圧

MVP では筆圧を扱わない。

- `PointerEvent.pressure` をブラシサイズや濃度へ反映しない。
- MVP の wire protocol では pressure を必須フィールドにしない。
- レンダラーは全ポイントを同じ強さとして扱う。
- 将来導入するときは protocol version を上げるか、後方互換な optional field として追加する。

### undo / redo

現在のモックアップはキャンバス全体の `ImageData` をローカルに保存している。この方式は共同編集へそのまま移行できない。

MVP ではundo / redoを提供しない。ツールバーとショートカットからも外す。

これにより、共同編集の論理revert、snapshot境界、古いevent削除、権限処理を単純にする。

将来追加する場合も、次の小さい仕様を第一候補とする。

- 自分の直近1 strokeだけ。
- stroke終了から10秒以内。
- 1段階だけで、redoは提供しない。
- undoは `stroke.revert` のような論理イベントとしてroomSeqを付ける。
- snapshotへ統合済みのstrokeは対象外。
- snapshot対象はundo可能時間を過ぎたeventまでとする。

### カラー、サイズ、濃度、パレット

- stroke 開始後に UI の値が変わっても、その stroke には反映しない。
- サイズはキャンバス論理 px。
- 濃度は 0-1。
- 色は sRGB の 24bit RGB を基本とする。
- カラーダイアログの HSB は UI 入力形式であり、保存・送信時は RGB/HEX へ正規化する。
- 保存済みパレットは MVP では Local Storage を基本とする。アカウント間同期は後段で D1 を候補とする。

## リアルタイム同期

### 採用方向

技術調査の第一候補を維持する。

- HTTP/API: Cloudflare Workers + Hono
- ルーム同期: 1 room = 1 Durable Object
- 接続: Durable Objects WebSocket Hibernation
- ルーム内短期状態: Durable Objects SQLite
- メタデータ: D1
- クライアント: Next.js + vinext + TypeScript
- 描画: Canvas 2D + Pointer Events
- プロトコル: MessagePack または CBOR

Next.js/vinext はページ、ルーム一覧、認証、通常 API を担当する。プロフィールとギャラリーは MVP 後に追加する。

Durable Objects は描画ルームの authoritative state、接続、順序、presence、チャット、rate limit を担当する。

高頻度 stroke を Next route handler、Server Actions、React state へ流さない。

### クライアントの責務

- 入力点の取得
- ローカルの即時描画
- 点列の間引き・まとめ
- MessagePack/CBOR エンコード
- 未送信イベントの短期バッファ
- provisional stroke の描画
- snapshotが有効ならsnapshot取得後にtail eventを再生し、無効または未生成ならevent logを先頭から再生
- 共通WASMレンダラーが採用済みなら、確定strokeとcold replayをBrowser WASMで描画する。未採用時はCanvas 2Dを使用
- 再接続
- UI 状態

### Durable Object の責務

- 接続者とロールの管理
- room token / session の検証
- message schema とサイズの検証
- actor ごとの rate limit
- stroke ID と clientSeq の重複排除
- roomSeq の採番
- stroke event の順序確定
- broadcast
- 未完了 stroke の timeout 処理
- チャットと presence の配信
- event log の保持量と開始・終了 sequence の管理
- snapshot manifest、生成状態、`baseRoomSeq`の管理。snapshot機能が無効な構成では持たない
- ルーム停止、kick、BAN

### イベントの最小候補

| 分類 | イベント |
| --- | --- |
| 接続 | `hello`, `welcome`, `resume`, `error` |
| presence | `presence.join`, `presence.update`, `presence.leave` |
| stroke | `stroke.begin`, `stroke.append`, `stroke.end`, `stroke.cancel` |
| チャット | `chat.send`, `chat.message`, `stamp.send` |
| ルーム | `room.updated`, `room.closed`, `room.suspended` |
| 管理 | `participant.kick`, `participant.mute`, `participant.ban` |

opcode、フィールド、上限、互換性ルールは実装前に `docs/spec/` へ独立した仕様として作る。

### 順序と再送

- クライアントは接続ごとの `clientSeq` を採番する。
- Durable Object は受理したイベントへ単調増加の `roomSeq` を付ける。
- `strokeId + event kind + clientSeq` で重複を排除する。
- クライアントは最後に適用した `roomSeq` を保持する。
- 再接続時に `lastRoomSeq` を送り、差分を取得する。
- snapshotが無効または未生成の間は、開催中の全event logを保持し、先頭から、または`lastRoomSeq + 1`から復帰する。
- snapshotを採用した場合は、commit済みsnapshotの`baseRoomSeq + 1`以降、または`lastRoomSeq + 1`以降の大きい方から差分を取得する。

`stroke.end` も `stroke.cancel` も届かない場合は、最後の `stroke.append` から 2 秒後に受信済み部分を自動確定する。

- 単点も dot として有効なため、最低点数では破棄しない。
- 明示的な `stroke.cancel` は未確定 stroke を破棄する。
- 切断時も直ちに破棄せず、同じ 2 秒の猶予を適用する。
- 再送は `strokeId` と `clientSeq` で重複排除する。
- 自動確定時は Durable Object が `stroke.end` 相当の room event を生成して全クライアントへ配信する。
- 2 秒という値は遅延、切断、描画体感の試験結果に応じて調整する。

## event log と復帰

### MVP の基準線と優先拡張

MVPの必須安全網は、snapshotがなくてもroomSeq付きevent logを先頭から再生して復帰できることである。event logのschemaと全再生可能性は維持するが、実装上は共通WASMレンダラーとsnapshot vertical sliceを早い段階で優先し、難しいと判断した場合にこのfallbackでMVPを完了する。

一方で、共通WASMレンダラーとsnapshotはMVPの必須条件ではないが、優先度の高い実装トラックとする。共通WASMレンダラー、snapshot生成、R2保存、snapshotからの復帰までを早期に実装してみて、決定性、性能、運用の単純さに問題がなければ積極的に採用する。成立しない、またはMVPを大きく遅らせると判断した場合はfeature flagを無効にし、event log-onlyの復帰でMVPを完了する。

authoritative stateは段階に応じて次のように変わる。

- snapshot無効時: 開催中の全drawing event log。
- snapshot検証中のshadow mode: 全drawing event logを残し、生成したsnapshotとRGBA hashを検証する。復帰はevent logを正とする。
- snapshot採用後: commit済みsnapshotと`baseRoomSeq`より後のtail event。snapshotが未生成の小さいルームは全event log。

snapshot採用後も、room作成からの総drawing event数と総wire payload byte数は単調増加する活動量カウンターとして保持する。snapshotによるcompactionで上限をリセットせず、ルーム時間・活動量制限のプロダクト方針を維持する。

活動量の暫定上限は次の小さい方とし、実測で調整する。

- 1 ルームあたり 100,000 drawing events
- MessagePack/CBORでエンコードしたdrawing event payloadの合計64MiB
- 最大開催時間 2 時間

`drawing events` は、authoritativeな描画event logへ永続化した `stroke.begin`、`stroke.append`、`stroke.end`、`stroke.cancel`、Durable Objectが生成した自動確定eventを指す。presenceとcursorは含めない。チャットは最新N件の独立した保持上限を持ち、この100,000件には含めない。room lifecycleと管理操作も別の小さい監査記録として扱う。測定ツールと本番メトリクスはこの定義を共有する。

64MiBはeventのwire payload合計に対する論理上限であり、SQLiteの行、index、管理情報を含む物理使用量とは分ける。実encoder導入後は保存前に実byte数を計算し、SQLiteの物理使用量も別メトリクスと安全弁で監視する。

上限の80%、90%、98%で接続中の全利用者へ終了が近いことを通知し、hostと管理画面にはevent数、byte数、残量を追加表示する。

ハード上限とは別にsoft close thresholdと終了用予約領域を設ける。drawing eventの予約量は、protocolで許可する最大同時未完了strokeをすべて確定または破棄できる量以上とする。`room.updated(status: closing)`と`room.closed`などの小さいlifecycle記録には、drawing event logとは独立した予約領域を持つ。soft close threshold到達後は新しい`stroke.begin`を受理せず、開始済みstrokeだけを完了させてから`closing`へ移る。ハード上限到達時も古いeventは削除しない。負荷試験では復帰時間、Durable Objects SQLite容量、CPU時間、broadcast遅延を測定する。

MVP では完成画像の生成・保存とギャラリー公開を行わない。snapshotは開催中の復帰を速くする一時的な技術データであり、完成画像ではない。ルーム終了後はevent log、snapshot manifest、R2上のsnapshotを削除する。通報証跡として保全する場合だけ、通常データとは分離した保持規則を適用する。

### 実操作から見た現在の上限

1人で約10分間利用したfixtureでは、次の結果だった。

- 403.6 events / 実時間分
- 約59.9 KiB / 実時間分
- 約24,200 events / ユーザー時間
- 約3.51 MiB / ユーザー時間

byte値はprotocol初稿に合わせ`clientSeq`を各eventへ追加したschemaで再解析した。event数、stroke数、point数、時間指標は以前の解析から変わらない。

同程度の活動量を基準にすると、100,000 drawing eventsは約4.1ユーザー時間に相当する。最大2時間では「1人で約48,400 drawing events」「2人分の同等活動量で約96,800 drawing events」となり、100,000件という暫定上限と概ね対応する。

参加者が多い、または描画密度が高い場合は2時間より前に活動量上限へ到達する。その場合は次のルームへ移行する方針とする。

### Event上限を引き上げる利点と欠点

利点:

- 活発なルームが時間上限より先に終了しにくくなる。
- 多人数で同時に描ける時間が長くなる。
- snapshotが未採用でも扱えるルーム範囲が広がる。

欠点:

- 新規入室・再接続時の転送量とcold replay時間が増える。
- 低性能端末でメインスレッド、メモリ、Canvas再生への負荷が増える。
- Durable Objects SQLiteの読み出し量と復帰時CPU負荷が増える。
- 複数クライアントが同時復帰した場合の負荷集中が大きくなる。
- 復帰中にlive eventへ追いつくまでの一時キューが増える。
- 破損eventやschema不整合の影響範囲が広くなる。
- 荒らしが大量eventを作った場合の保存・転送・再生コストが増える。
- protocol変更時に移行または互換再生するデータ量が増える。
- ルーム終了時の削除処理や障害調査が重くなる。

drawing event上限は目標値ではなく安全弁とする。引き上げる場合は、実fixtureを使った150,000、250,000、400,000 drawing eventsのcold replay、DO SQLite読み出し、WebSocket転送、複数同時復帰を先に測定する。

### 優先実装する共通WASMレンダラーとsnapshot

共通WASMレンダラーのspikeだけで終えず、最小のsnapshot vertical sliceまで優先して実装する。MVPリリースの必須条件にはしないが、技術的に成立するならMVPからsnapshot-firstの復帰を採用する。

Cloudflare Workersはプリコンパイル済みWASMとSIMDを利用できるが、WASM threadingは利用できない。レンダラーは単一スレッドで成立させる。

- [Cloudflare Workers WebAssembly](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)

優先トラックの実装順:

1. Rustなどでrenderer coreを実装する。
2. Browser WASMとWorkers WASMへ同じcoreをbuildする。
3. 同じfixtureから同じRGBA hashが得られることを確認する。
4. ブラウザのローカルprovisional描画はCanvas 2Dを維持し、stroke確定時にBrowser WASMのcanonical結果へ置き換える構成を検証する。
5. 専用WorkerまたはQueue ConsumerがDOからeventを分割取得し、lossless snapshotを生成する。
6. snapshot本体をR2へ保存し、manifestをDOへcommitする。
7. クライアントがsnapshotを取得して、`baseRoomSeq + 1`以降のtail eventへ追いつく。
8. shadow modeでBrowser WASMによるevent log先頭からのcanonical結果と、Workers WASMが生成したsnapshot復帰後のRGBA hashを比較する。
9. 採用条件を満たした場合だけsnapshot-firstを有効化し、満たさない場合はevent log-onlyへ戻す。

ルームDOは1オブジェクトごとに単一スレッドであるため、重いレンダリングをWebSocket処理経路へ入れない。Workersのメモリ上限にはWASM領域も含まれるため、event log全体を一括展開せず、分割入力とバッファ再利用を前提にする。

採用判定で確認する項目:

- Browser / Workers間のRGBA hash一致。
- ブラシ、消しゴム、濃度、単点、高速stroke、cancel。
- 100,000 / 250,000 drawing eventsと64MiB相当。
- WASM初期化、decode、rasterize、lossless PNG/WebP encodeの時間。
- peak memory、Worker CPU、bundle size。
- Queue再試行、重複実行、Worker停止、R2失敗に対する冪等性。
- snapshot取得とtail replayを含むend-to-end復帰時間。

次の条件をすべて満たした場合は、snapshotをfeature flag付きで採用し、対応ルームの新規入室・cold recoveryではsnapshot-firstを標準経路にする。

- Browser / Workersのcanonical rendererでRGBA hashが一致する。
- Browser WASMでの確定stroke描画が入力処理を阻害せず、Canvas 2Dのprovisional表示から自然に置き換えられる。
- 50,000-event初回生成と10,000-event増分生成でWorker余裕を確認し、
  追加比較後は5,000-event増分を既定値とする。100,000-event full replayは
  local worst caseとして回帰測定する。
- snapshot生成失敗、R2保存失敗、manifest commit失敗のいずれでも元eventを削除しない。
- snapshot + tail replayがevent log全再生より明確に速く、標準端末と低性能端末の復帰目標を満たす。
- Queue、R2、manifest、cleanupを含む実装と運用が、MVPの保守可能な範囲に収まる。

いずれかを満たさない、外部コンテナが必須になる、または実装がMVPの主要機能を大きく遅らせる場合は、snapshotをMVPから外してevent log-onlyへ戻す。Cloudflare Containerや外部コンテナによる専用レンダリングはMVP後の再検討候補とし、信頼できないクライアント生成snapshotは最後の候補にする。

snapshot vertical sliceでは、少なくとも次を仕様化する。

- snapshot manifestの`baseRoomSeq`、`canvasGeneration`、protocol version、renderer version、RGBA hash、object byte hash。
- sRGB、白背景、濃度、消しゴム、座標丸め、合成規則。
- PNGまたはlossless WebP。非可逆圧縮は再描画、スポイト、後続strokeの合成結果を変えるため使用しない。
- 生成処理をルームDOから分離し、専用WorkerまたはQueue Consumerがevent logを分割取得する構成。
- snapshot本体のR2保存、commit、DO側manifest更新、古いevent削除の順序と冪等性。
- compaction前の失敗では元event logを削除せず全再生へ戻し、compaction後の失敗では直前の有効snapshotへ戻せること。
- snapshot取得API、認可、整合性検証、live eventへの追従。

導入初期はshadow modeで古いeventを削除せず、snapshot生成と復帰結果だけを検証する。十分な成功率とhash一致を確認してからcompactionを有効にする。compaction時は新snapshotのR2保存とmanifest commitが成功した後に限り削除する。current snapshotが壊れた場合にprevious snapshotから復元できるよう、previousの`baseRoomSeq`からcurrentまでのbridge eventは残し、削除境界はpreviousの`baseRoomSeq`以前とする。最初のsnapshotしかない場合は削除しない。生成待ちjobが固定したsource境界は追加の削除下限として保護する。次のsnapshot Workerはcurrent snapshotを基点にtailを適用して生成できることをcompactionの前提とする。incremental generation、previous境界でのchunk deletion、中断再開、重複実行、compaction後の次世代生成、room closeとの競合フェンスは2026-07-27にlocalとCloudflare disposable preview roomで成立した。同日のpreview測定では50,220-event初回生成がCPU 17.121秒、10,020-event増分が3.891秒で、20接続・約400 events/sとの同時実行でもbroadcast欠落は0だった。memory p999は31,596,578 bytesで128 MiB上限の23.5%だった。2026-07-28の70,020-event compaction canary後もcurrent/previous両経路からroomSeq 79,980へ復帰したため、Gate Bをpassしsnapshot-firstを採用した。終了cleanup、DLQ、orphan inventoryはproductionまで実装・確認済みである。通常roomはshadowを維持し、event compactionはclosed betaの観測後に段階導入する。

snapshot modeはルーム単位で`event_log_only`、`shadow`、`snapshot_compacted`を持ち、この順にだけ進める。compactionを一度行ったルームは全event logへ戻れないため、feature flagを停止しても`snapshot_compacted`のルームはsnapshot + tailで終了まで動かす。停止後に作る新規ルームと、まだcompactionしていない`shadow`ルームだけをevent log-onlyへ戻す。

runtime起動条件は固定時間ではなくevent数とbyte数を使う。現在は初回50,000
drawing eventsまたは16MiB、その後5,000 eventsまたは4MiBの増分を採用する。
推定replay時間による動的triggerは将来候補として残す。

### 復帰フロー

1. クライアントがルームメタデータ、canvas generation、event logの開始・終了roomSeq、commit済みsnapshot manifestの有無を取得する。
2. 有効なsnapshotがあれば、認可済みURLから取得してhash、version、`baseRoomSeq`を検証する。
3. snapshotを適用し、`baseRoomSeq + 1`以降のtail eventをroomSeq順に再生する。
4. snapshotが無効、未生成、取得失敗、検証失敗の場合、shadow modeでは直前の有効snapshotを試し、それも利用できなければ全eventが残っているため先頭からのevent log再生へ自動fallbackする。
5. snapshot機能を採用しcompaction済みの場合は、直前の有効snapshotと保持済みbridge eventへfallbackする。それも利用できなければ入室を中止し、破損状態として管理側へ通知する。
6. snapshot機能自体が無効な構成では、event logを先頭からroomSeq順に再生する。
7. WebSocketのlive eventへ追いつく。復帰中に届いたlive eventは一時キューへ入れる。
8. ログ欠落、上限超過、schema非互換、hash不一致があれば、不完全なキャンバスを表示せず管理側へ通知する。

## データ配置

### D1

MVP で長期参照・検索が必要な通常データ。

- users
- guest_sessions の必要最小限
- rooms
- room_memberships
- room_invites
- reports
- moderation_actions
- bans

最初は `users`、`rooms`、`room_memberships`、`reports`、`moderation_actions` を中心とした小さな集合に絞る。MVPの表示名や認証に必要な最小属性は`users`へ置き、詳細プロフィールを導入するときに`user_profiles`を追加する。

通常終了時に`rooms`を物理削除しても通報記録を保持できるよう、`reports`と証跡manifestは削除対象のroom行への必須foreign keyにしない。代わりに外部公開しない`sourceRoomId`、通報時点の最小ルームメタデータ、証跡object key、保持期限を記録する。

`gallery_works`、`work_contributors`、`reactions`、`friendships`、`notifications` はMVPのmigrationや空テーブルにも含めず、対象機能の設計時に追加する。

### Durable Objects SQLite

ルーム単位の順序と短期状態。

- room runtime state
- roomSeq
- 短期 stroke event log
- 未完了 stroke
- ルーム単位のsnapshot mode、生成状態、manifest、`baseRoomSeq`
- connection/session mapping
- chat 最新100件か24時間の早い方（暫定）
- rate limit counter

presence は接続中メモリを中心にし、永続化は最小限にする。

### R2

snapshot優先トラックが採用条件を満たした場合、開催中ルームのlossless snapshot保存に使用する。snapshot objectは非公開とし、短命な認可済みURLまたはWorker経由で取得する。ルーム終了時に削除し、公開作品や完成画像として残さない。

snapshotをMVPから外した場合、通常の描画・復帰経路ではR2を使用しない。ギャラリーやサーバー保存画像を導入するときは用途、bucket、保持規則を改めて設計する。

通報済みまたは管理者停止したルームの証跡保全には限定的に使用できる。ルームの通常データとはbucket prefix、認可、保存目的を分離し、保持期限による自動削除を設定する。これはギャラリー用の完成画像保存ではない。

### クライアント

- UI 設定
- カラーパレット
- 最後の guest identity
- 未送信 stroke の短期バッファ
- 最後に適用した roomSeq
- 適用済みsnapshotの`baseRoomSeq`、hash、renderer version

Local Storage には小さな設定、IndexedDB には未送信 event や復帰用バッファを置く。

## HTTP API の境界

通常 API と WebSocket を分ける。

### HTTP

- ルーム一覧取得
- ルーム詳細取得
- ルーム作成
- 招待 token の発行・ローテーション・失効
- 招待 token から短命な room ticket への交換
- snapshot manifest取得と認可済みsnapshot取得。snapshot feature flag有効時のみ
- 通報
- 管理操作

プロフィールAPIはMVP後に追加する。

### WebSocket

- stroke
- presence
- cursor
- chat
- stamp
- room runtime update
- close/suspend

高頻度イベントを HTTP action や Server Action へ送らない。

## 認証

### MVP の認証

- ゲスト session を first-party cookie で識別する。
- cookie は HttpOnly、Secure、SameSite を適切に設定する。
- 表示名とカラーは session に関連づける。
- ゲストはルームへ参加できるが、ルームを作成できない。
- ルーム作成はログイン済みユーザーだけに許可する。
- アカウント認証は Better Auth + Google OAuthを採用する。
- セッションとユーザーは D1 に保存する。
- メール認証はMVPの必須経路に含めない。
- public room は公開 slug、unlisted room は招待 token を利用し、短命な参加 ticket へ交換する。
- WebSocket 接続時に ticket を検証する。
- 管理画面は Cloudflare Access + アプリ内管理者確認。

### token と ticket の安全設計

- 内部 `roomId` は URL に直接使用しない。
- public room の `roomSlug` は 128 bit 以上のランダム値とする。
- unlisted room の招待 token は256 bitのランダム値とし、サーバーにはSHA-256だけを保存する。招待token自体は失効またはroom終了まで再利用でき、交換後のroom ticketをsingle useとする。
- 招待 token はローテーションと失効を可能にする。
- URLから受け取った招待 tokenは、HTTP APIで短命な `roomTicket` へ交換する。
- `roomTicket` の有効期限は暫定 60 秒とし、1 回の WebSocket 接続にだけ使用できる。
- 再接続時は新しい ticket を取得する。
- ticket は `roomId`、actor ID、role、session ID、期限、一意な nonce に紐付ける。
- MVPでは256-bit opaque tokenを採用し、room DOにはhashとclaimsだけを保存する。
- WebSocket upgrade時にDO内transactionでnonceを消費し、replayを拒否する。
- host 権限は URL token ではなく、ログインセッションと room ownership から判定する。
- token、ticket、認証cookieをアクセスログ、Referer、エラー本文へ出さない。
- 招待情報は可能なら URL fragment で受け取り、明示的な交換処理でサーバーへ送る。

### ゲスト identity

- ブラウザ単位の guest session は暫定 30 日間有効とする。
- room ごとに別の participant ID を発行し、サービス横断で外部へ同じ guest ID を露出しない。
- ニックネームと参加カラーは 30 日間引き継げる。
- ルーム開催中に同じ session で再入室した場合は、同じ actorとして識別する。
- 同じactorの同時connectionは1つとし、新しいticket接続で旧接続を置換する。
- MVPではルーム終了後の参加履歴をゲストへ永続的に紐付けない。
- cookie 削除、明示的なリセット、30 日経過で identity を更新する。
- BAN、rate limit 用識別子は guest session と短期 IP/UA hash を分離する。
- 保存期間はプライバシーと荒らし対策の実測を踏まえて調整する。

MVPではゲストsessionからユーザーへ昇格しても、過去の参加履歴や描画eventをユーザーへ移管しない。将来、参加履歴やギャラリーを導入するときに、guest actor IDとuser IDを関連づける必要性、本人確認、重複・乗っ取り対策を改めて設計する。

## ルーム一覧とホーム

統合ホーム方針を採用する。

- ルーム一覧をサービスの中心画面にする。
- 非ログインでも公開ルームを取得できる。
- MVPのログイン後表示には、自分が作成した開催中ルームを追加する。参加履歴・最近見たルームはMVP後に追加する。
- LP 的な説明は一覧より後ろへ置く。
- 本番では `/` を第一候補とし、`/rooms/` は同画面または転送とする。

一覧 API が返す最低情報:

- roomSlug
- name
- status
- visibility
- participantCount
- participantLimit
- viewerCount
- canJoin
- canView
- startsAt / endsAt
- tags

MVPではサーバー生成画像を保存しないためthumbnailを返さない。一覧の参加者名やavatarをどこまで公開するかはプライバシー方針と合わせて決める。

## チャットと presence

### presence

- 参加者名
- 参加カラー
- ロール
- cursor 座標
- drawing / idle などの簡易状態

cursor は保存しない。送信頻度を制限し、最新値だけを配信する。

### チャット

- 最大文字数を設定する。
- 最新 N 件または短い TTL だけ保持する。
- URL、連投、禁止語、巨大 Unicode 文字列への対策を持つ。
- サーバー時刻と message ID を付ける。
- 削除・mute・通報に必要な actor ID を保持する。

スタンプは許可済みの ID だけを送る。

チャット送信はactiveなログインユーザーだけに許可し、host / participant / viewerの
全roleで利用できる。guest viewerは受信だけ許可する。送信には次の暫定制限を適用する。

- チャット: 10 秒あたり 5 件まで、1 分あたり 30 件まで
- スタンプ: 1 秒あたり 1 件まで、1 分あたり 20 件まで
- 最大文字数、message byte、Unicode正規化の検証
- 管理者の緊急停止と個別 mute
- actor/session/IP単位の段階的 rate limit
- 違反の反復時は一時 mute、切断、BAN の順で強化

具体値は負荷試験と荒らし対策の運用結果で調整する。

## ローカル保存とルーム終了

### 「保存」ボタンの意味

現在のお絵描きモックには「保存」があるが、意味が未確定。

MVP では次のように定義する。

- 「画像を保存」: クライアントで PNG をダウンロード。
- 「ルームを終了」: host が終了処理を開始し、WebSocketを閉じてルーム、event log、復帰用snapshotを削除。
- 復帰用snapshotは優先実装トラックで成立した場合だけ自動生成する。利用者が操作する保存機能や完成画像ではない。

ローカルPNGダウンロードはサーバーへ画像を送信せず、ルームの終了条件にも影響しない。

### MVP 後のギャラリー

MVP ではギャラリーページ、完成画像のサーバー生成・保存、作品公開、いいねを実装しない。将来導入する場合は、次を改めて決める。

- host が公開を決定するか、参加者同意が必要か。
- contributor 表示と匿名ゲストの扱い。
- 削除依頼と公開停止。
- NSFW、著作権、通報。
- いいねの重複防止。

## 荒らし・セキュリティ対策

### WebSocket / stroke

- 接続数上限
- ルームごとの描画可能人数上限
- actor ごとの message rate
- stroke あたり最大点数
- 1 append あたり最大点数
- 最大ブラシサイズ
- 最大 message byte
- 座標範囲チェック
- 不正 opcode の切断
- 未完了 stroke の timeout
- 重複 event の排除

### ルーム・チャット

- ルーム作成 rate limit
- 表示名・ルーム名・ルームテーマの長さ制限
- chatは本文500 Unicode code points、2件/秒・burst 5の独立bucket、
  最新100件か24時間の早い方を暫定値とする。
- activeなログインユーザーはroleを問わず送信可、guestは送信不可とし、受信は
  全roleに許可する。
- 表示名とavatar URLはclient入力ではなく、activeなユーザープロフィールから
  serverが接続ticketへ固定する。
- chatはdrawing event logやsnapshotのroomSeqから分離し、room内の短期
  sequenceで順序付ける。
- mute / kick / BAN
- 通報
- emergency mode
- 新規ルーム停止
- 新規入室停止
- viewer の送信権限分離

### Web

- CSP
- CSRF 対策
- XSS 対策
- OAuth redirect 検証
- room token のログ・Referer 漏えい対策
- snapshot manifestとR2 objectの認可、推測困難なobject key、短命な取得URL
- snapshot hash・content type・byte数・renderer versionの検証
- 画像uploadを導入する場合のcontent type・サイズ検証、非公開bucket、署名URL

## コミュニティと法務上の前提

公開 UGC サービスとして、少なくとも次を公開前に用意する。

- 利用規約
- プライバシーポリシー
- コミュニティガイドライン
- 通報手段
- 問い合わせ手段
- 削除依頼手段
- 禁止コンテンツ方針
- 未成年利用の扱い
- ログ・IP/UA hash の利用目的と保持期間
- 共同キャンバスに描いた内容の権利と禁止事項

計画書より前に法務結論をすべて出す必要はないが、データ削除、一覧掲載停止、通報時の期限付き証跡保全を可能にするデータモデルは確保する。

## 観測と運用

最低限記録するメトリクス:

- active room 数
- room ごとの participant / viewer 数
- WebSocket 接続成功率
- 再接続率
- message rate / byte rate
- stroke reject 数と理由
- provisional stroke timeout 数
- roomSeq lag
- event log event 数・byte 数
- event log replay 所要時間
- snapshot生成成功率・失敗理由・所要時間
- snapshot age・size・`baseRoomSeq`・hash不一致数
- snapshot取得時間・tail replay時間・event log fallback率
- R2保存・取得・削除エラー
- D1/DO エラー
- chat rate limit
- kick / BAN / report 数

ログへ生の room token、認証 token、チャット全文、IP アドレスを無制限に残さない。

運用機能:

- ルーム検索
- ルーム停止
- 接続者確認
- kick / BAN
- 通報確認
- 通報証跡の保全・期限確認・削除
- emergency mode
- D1のアカウント・認証設定・通報・運用記録のexport / backup

短命な`rooms`、`room_memberships`、通常のroom event log、snapshot、sessionは復旧用backup対象に含めない。これにより、削除済みルームや期限切れsessionをbackupから復活させない。通報証跡は通常backupと分離し、定めた保持期限を越えて復元されないようにする。

## 性能目標

技術調査の成功条件を初期基準にする。

- 1ルーム10-20接続でbroadcast、再接続、viewer増加を検証する。この値は同時接続の負荷試験目標であり、10-20人が2時間連続描画できることを保証する活動量枠ではない。
- ローカル描画は次のanimation frameで表示し、入力からprovisional表示までのp95を32ms以内とする。
- 通常回線で、他参加者へのprovisional stroke反映のp95を250ms以内、確定反映を1秒以内とする。
- pointer event をそのまま 1 点ずつ送らず、10-20Hz 程度でまとめる。
- 再読み込み後にsnapshot + tail event、またはevent log全再生で復帰できる。
- ルーム一覧や通常ページは描画 WebSocket と独立して動く。

event log復帰の初期受け入れ値は次とする。標準端末と低性能端末の具体的な機種・ブラウザは負荷試験計画で固定する。

- 標準端末では最初の描画表示まで500ms以内、100,000 drawing eventsの全replayを3秒以内。
- 低性能端末では最初の描画表示まで1秒以内、100,000 drawing eventsの全replayを8秒以内。
- replay中の最大main-thread sliceは16msを目標とし、50msを超えるLong Taskを発生させない。
- peak memory、転送byte、DO SQLite読取時間を毎回記録し、前回基準から20%以上悪化した場合は回帰として調査する。
- 復帰中のlive eventキューにbyte上限と件数上限を設け、超過時は不完全な状態で続行せず、復帰を最初からやり直す。

snapshotを採用する場合は、同じfixtureと端末でsnapshot + tail replayをevent log全再生と比較する。snapshot経路は全再生より明確に速く、少なくとも上記の初回表示・全復帰目標を満たすことを採用条件とする。生成側は実際に利用するWorker制限に対してCPU、メモリ、実行時間の30%以上の余裕を目標とする。

追加で測定する。

- 60 秒の連続描画後も UI が大きく劣化しない。
- 低速回線、200-500ms 遅延、短い切断で復帰できる。
- chat flood が描画 broadcast を阻害しない。
- viewer 増加が participant の描画遅延を悪化させない。

## Event log測定基盤

event log上限を実測で調整するため、`tools/event-log-benchmark/` に外部依存のない測定ツールを用意した。

### 現在測定できるもの

- `?measure=1` を付けた描画モックから、実操作のraw stroke fixtureを記録
- raw fixtureを繰り返さず1回だけ変換し、記録時間とアクティブ描画時間を分けて集計
- raw strokeを `stroke.begin` / `stroke.append` / `stroke.end` へ変換
- 指定event数または推定wire byte数までevent logを生成
- event数、stroke数、point数、JSON byte数、MessagePack相当の推定byte数を集計
- Canvas 2Dでevent logをcold replay
- replay時間、最初の描画までの時間、最大処理slice、Long Taskを計測

MessagePack相当byte数は、wire library未採用時点の見積もりである。protocol実装後は実encoderが返すbyte数に置き換える。

実操作fixtureの単回解析には次を使う。

```sh
npm --prefix tools/event-log-benchmark run analyze-raw -- \
  /absolute/path/to/echa-raw-strokes.json
```

この解析は暫定バッチ条件の50ms／最大12 pointsを適用し、begin、append、endの正確な件数、events/実時間分、events/アクティブ描画分、推定byte数を出力する。条件比較時は `--append-interval-ms` と `--max-points-per-append` を変更する。

### 初回の動作確認

付属の小さなsample fixtureを増幅し、同一の開発環境で次を確認した。

| event数 | stroke数 | point数 | 推定MessagePack | cold replay |
| ---: | ---: | ---: | ---: | ---: |
| 10,001 | 2,222 | 15,561 | 約912.8 KiB | 約33.8 ms |
| 100,001 | 22,222 | 155,561 | 約8.99 MiB | 約1,795.9 ms |

推定byteは`clientSeq`追加後のschemaで再生成した。cold replay値は同じpoint列を使った初回測定値であり、rendererが無視するmetadata追加後のブラウザ再測定は必要である。100,001 eventsでは8msごとにブラウザへ制御を返し、測定上の最大sliceは8msだった。この値はツールの動作確認結果であり、実利用の上限根拠にはしない。実際の複数ユーザー操作を記録したfixture、複数端末、複数回の測定結果で置き換える。

このsampleでは100,000 drawing eventsでも推定64MiBへ達していない。event数上限とbyte上限は別々に保持し、さらに復帰時間を主要な判断基準にする。

### 初回時点で未測定だったもの

- Durable Objects SQLiteへの保存・読み出し
- WebSocketのchunk転送時間
- 複数クライアントの同時復帰
- 復帰中に届くlive strokeへの追従
- Durable ObjectのCPU時間、wall time、保存量
- 低速回線と切断を含むend-to-end復帰
- Workers WASMでのsnapshot生成時間とpeak memory
- Queue、R2保存、manifest commitを含むsnapshot vertical slice
- snapshot取得、decode、tail replay、event log fallbackのend-to-end比較

これらはPhase 2、3、7で順次測定・実装した。現在の結果は
`docs/results/phase7-performance-foundation.md`を正本とし、Safari / Firefox、
低性能端末、closed betaの継続測定は残っている。

## テスト方針

### レンダラー

- 固定 stroke fixture から期待画像を生成する。
- ブラシ、消しゴム、濃度、単点、高速 stroke を含める。
- 低濃度 stroke の継ぎ目が濃くならないことを画像差分で確認する。
- zoom / pan は描画データを変更しないことを確認する。

### 共通WASMレンダラーとsnapshot優先トラック

- Browser WASM / Workers WASMで同じfixtureのRGBA hashが一致すること
- Canvas 2Dのprovisional表示とWASMのcanonical結果の差異を計測すること
- 100,000 / 250,000 drawing eventsと64MiB相当でdecode、rasterize、lossless encodeを計測すること
- peak memory、Worker CPU、初期化時間、bundle sizeを記録すること
- snapshot生成、R2保存、manifest commit、snapshot + tail replayを通したvertical slice
- shadow modeでBrowser WASMによるevent log全再生とWorkers WASMのsnapshot復帰のRGBA hashが一致すること
- snapshot-first、直前snapshot、event log-onlyのfallback順序
- manifest commit前にはeventを削除せず、compactionの再実行が冪等であること
- 優先トラックが失敗してもMVPのCanvas 2D + event log復帰経路へ影響しないこと

### プロトコル

- encode / decode fixture
- schema version
- 重複 event
- 順序入れ替え
- append 欠落
- stroke.end 欠落
- pointercancelからのstroke.cancel
- 明示的cancelと切断timeoutによる自動確定の競合
- resume
- event log 先頭からの復帰
- message size 上限
- drawing event数・wire payload byte数の集計
- soft close threshold以降の新規stroke.begin拒否
- 終了用予約領域で開始済みstrokeを完了できること

### Durable Object

- 10-20 接続の broadcast
- roomSeq の単調増加
- rate limit
- kick / BAN
- hibernation 復帰
- SQLite 再読込
- active / idleとWebSocket Hibernationが独立していること
- 同時再接続時のevent log読取とlive event追従
- snapshot生成中もWebSocket broadcastが阻害されないこと
- snapshot manifestの世代更新とtail event境界

### E2E

- ゲスト設定から入室
- 2 ブラウザ間の描画同期
- チャットと presence
- snapshot + tail eventからの再読み込み復帰。feature flag有効時
- snapshot未生成・無効時のevent log全再生復帰
- ログインユーザーによるルーム作成
- ゲストのルーム作成拒否
- 再ログイン・再接続後のroom ownershipとhost権限復元
- undo / redoのUI・ショートカット・protocol eventが存在しないこと
- host 終了
- 全員退出後の自動終了
- 最大開催時間での自動終了
- 活動量上限での予告、stroke完了、次ルーム作成
- 管理者停止
- 通報あり終了時の証跡保全と通常event log・snapshot削除
- 通報なし終了時にルーム行、event log、snapshotが残らないこと
- 非ログイン／ログイン後ホーム

### 障害試験

- WebSocket 切断
- event log 上限到達
- event上限直前の複数同時stroke
- 通報証跡保存失敗時に元event logを削除しないこと
- `room.closed`配信中の切断と終了処理の再実行
- D1 timeout
- Durable Object restart
- Durable Objects SQLiteの容量不足・読取失敗
- WASM初期化・snapshot生成・R2保存・manifest commitの各失敗
- snapshot破損、hash不一致、version非互換、取得timeout
- shadow modeでのevent log fallback
- compaction後に現行snapshotが壊れた場合の直前snapshot fallback
- ルーム終了時のsnapshot object削除失敗と再試行
- room ticketの期限切れ・再利用・別sessionからの使用
- client の古い schema version

## MVP の境界

### MVP 1: 描画同期の技術検証

- ローカル描画
- ブラシ、消しゴム、色、サイズ、濃度
- 固定白キャンバス
- 1 ルーム
- 2-20 クライアント
- stroke streaming
- provisional stroke
- roomSeq
- 再接続
- event log cold replay測定
- 共通WASMレンダラーの決定性・性能spike。優先
- snapshot vertical sliceとshadow mode。優先だがMVP blockerではない

### MVP 2: アカウントとルームサービス

- 統合ホームと公開ルーム一覧
- public / unlisted room
- Better Auth を用いた最小アカウント機能
- ログインユーザーによるルーム作成
- room ownership と host 権限の復元
- ゲスト identity
- ゲスト参加
- presence
- cursor
- チャット
- viewer
- event log / 復帰
- 採用条件を満たした場合のsnapshot-first復帰。満たさない場合はevent log-only
- 100,000 drawing events / 64MiB / 作成から2時間の複合上限
- soft close threshold、終了用予約領域、次ルーム作成導線
- undo / redoなし
- host 終了
- 自動終了とデータ削除
- rate limit
- 管理者停止

### MVP 3: 公開前の運用

- 通報
- kick / BAN
- emergency mode
- 管理画面
- 通報時だけの期限付き証跡保全
- snapshot採用時の生成・fallback・R2 cleanup監視
- ログ・メトリクス
- 利用規約、プライバシー、ガイドライン
- backup

### MVP 後

- プロフィール
- 参加履歴
- フレンド
- 通知
- ギャラリー
- いいね
- アカウント間パレット同期
- friends / private room
- 高度なブラシ
- 複数レイヤー
- 画像貼り付け
- 本格的なモバイル UI

## 現在の資料間の不整合

計画書へ進む前に、次を正すか、意図的な将来案として明記する。

| 対象 | 不整合 | 方針 |
| --- | --- | --- |
| 技術調査 | MVP 描画に「ペン」とある | 現在の UI に合わせ「ブラシ」に統一 |
| ヘルプ | ペン、バケツのショートカットが残る | 削除し、ズームと Space パンを追加 |
| ヘルプ | トップページの「はじめる」を案内 | 統合ホームのゲスト参加へ変更 |
| ヘルプ | 承認制ルーム、参加者単位undoを確定機能として説明 | MVPから削除し、将来の「直近1 stroke・10秒以内」候補へ変更 |
| ログイン | ゲスト設定とアカウントログインを 1 ページで扱う | ゲスト設定は入室モーダル、アカウント認証は別画面に分離 |
| 統合ホーム | ログイン後機能までモックに存在 | 認証とルーム作成は MVP、履歴・フレンド・通知は後段に分離 |
| 描画ルーム | ローカル ImageData undo | MVPからundo / redo UIを削除 |
| 描画ルーム | 「保存」の意味が曖昧 | ダウンロード、終了、checkpoint を分離 |
| ギャラリー | 作品公開といいねが完成機能のように見える | MVP 後として扱う |
| プロフィール | 参加履歴、フレンド、作品所有 | アカウント基盤はMVPに含めるが、これらの機能はMVP後として扱う |
| ルーム作成 | フレンド限定が選べる | MVP はログイン必須かつ public / unlisted のみ |
| snapshot | R2 保存だけが決まり、生成主体が未定 | event logの全再生可能性をfallbackとして維持しつつ、共通WASMレンダラーからsnapshot + tail復帰までを優先実装。採用条件を満たせばsnapshot-first、難しければMVPはevent log-only |

## 計画書作成前の決定事項

### 決定済み

1. MVP では筆圧を含めない。
2. host終了、全員退出、最大開催時間、idle、管理者強制終了を組み合わせる。通常終了後はルーム、event log、snapshotを物理削除し、再入室・閲覧・再開は許可しない。通報または管理停止がある場合だけ、必要最小限の証跡を通常データと分離して期限付きで保全する。
3. event log先頭からの復帰をMVPの必須fallbackとする。共通WASMレンダラーとsnapshot vertical sliceは優先して実装し、決定性、性能、障害時の安全性、運用負荷に問題がなければsnapshot-firstを採用する。難しい場合はfeature flagを無効にし、event log-onlyでMVPを完了する。
4. drawing event log上限は100,000 events / wire payload 64MiB、最大開催時間は作成から2時間で開始し、負荷試験で調整する。soft close threshold以降は新しいstrokeを開始せず、予約領域で開始済みstrokeを完了してから終了する。
5. `stroke.end` 欠落時は最後のappendから暫定2秒後に自動確定する。
6. MVPではundo / redoを提供しない。将来追加する場合は「自分の直近1 stroke・10秒以内・redoなし」を候補とする。
7. activeなログインユーザーはroom roleを問わずチャットを送信できる。guestはviewerとして閲覧とチャット受信だけを利用でき、rate limit、mute、BANを適用する。
8. ゲストはルームを作成できず、描く人も選択できない。
9. guest identityは暫定30日、roomごとにparticipant IDを分離する。MVPではゲストの過去の参加履歴や描画eventをアカウントへ移管しない。
10. 内部ID、公開slug、招待token、短命な接続ticketを分離し、安全性を優先する。

### 暫定値の検証事項

- 全員退出後10分、最大開催2時間、idleまで30分が実利用に適するか。
- drawing event log 100,000 events / wire payload 64MiBで復帰時間とDO負荷を許容できるか。
- drawing eventの終了用予約量が最大同時未完了strokeに十分で、独立したlifecycle予約領域から`room.closed`を配信できるか。
- 未完了strokeの2秒timeoutが低速回線でも誤確定を起こさないか。
- undoなしが利用者に受け入れられるか。必要なら直近1回・10秒以内を検証する。
- 共通WASMレンダラーがBrowser / Workersで決定的かつ制限内に動作するか。
- snapshot + tail replayがevent log全再生より明確に速く、採用条件を満たすか。
- shadow modeからcompactionへ進める成功率・hash一致率・観測期間をどう定めるか。
- guest identity 30日が再入室、プライバシー、荒らし対策に適するか。
- room ticket 60秒・1回限りが通常の接続と再接続を阻害しないか。

### 公開前

1. 通報、削除、BAN、証跡アクセスの運用。
2. チャット、通報証跡、IP/UA hashの保持期間。通常のroom event logとsnapshotは終了時に削除する。
3. 利用規約と禁止コンテンツ。
4. 緊急停止の責任者と操作方法。
5. バックアップと復旧目標。

### 計画書確定前に残るアカウント決定

次は2026-07-27に決定し、productionまで実装済み。

1. OAuth providerはGoogle。
2. MVPにメール認証を含めない。
3. Better Auth `1.6.25`をD1へ永続化する。

### MVP 後の各機能を導入する前

1. ギャラリーにおける共同作品の公開権限。
2. 完成画像の生成・保存・削除方法。
3. 作品 contributor と user / guest の関連。
4. フレンドの定義。
5. 通知の種類。

## 計画書を作る前に用意する成果物

次の成果物を計画入力として用意し、その後Phase 0〜7で実装・検証した。
個別の現在状態は`docs/spec/`と`docs/results/`を参照する。

1. `docs/spec/stroke-protocol.md` — 作成済み
   - opcode
   - schema
   - 上限
   - 順序
   - 再送
   - versioning
2. `docs/spec/room-lifecycle.md` — 作成済み
   - 状態遷移
   - role
   - 公開範囲
   - 終了条件
   - idleと全員退出猶予の分離
   - 通報証跡の保全を含む終了順序
3. `docs/spec/event-log-recovery.md` — 作成済み
   - 保持上限
   - eventとbyteの計数定義
   - soft close thresholdと終了用予約領域
   - event log全再生
   - snapshot manifestと`baseRoomSeq`
   - snapshot + tail replay
   - shadow mode、compaction、fallback
   - 上限到達時の終了
   - event 保持
   - 復帰
4. `docs/spec/data-model.md` — 作成済み
   - D1
   - DO SQLite
   - ID
   - retention
5. `docs/spec/guest-session.md` — 作成済み
   - cookie
   - room ticket
   - nickname
   - rate limit identity
6. `tools/renderer-fixtures/v1/` — fixture初稿とschema testを作成済み
   - 基本 stroke
   - 濃度
   - 消しゴム
   - 単点
   - cancel
7. 2 クライアント同期 spike — preview / productionの別browser E2Eまで完了
8. 共通WASMレンダラーとsnapshot優先トラック — Stage A-DとStage Eの安全なchunk compactionまで実装・検証済み
   - Browser / WorkersのRGBA hash一致
   - Queueまたは専用Workerでのlossless snapshot生成
   - R2保存とmanifest commit
   - snapshot + tail replay
   - shadow modeとevent log fallback
   - 採用／延期の判定記録
   - feature flagによる自動shadow生成とalarm駆動compactionを実装済み
   - preview / production Worker性能を確認済み
9. 自動終了時の接続切断・証跡保全・データ削除 — Queue / DLQ / healthとproduction E2Eまで完了
10. Durable Object WebSocket Hibernation — SQLite復帰、attachment、再接続を実装・検証済み
11. 小規模負荷試験 — Phase 7のrealtime / snapshot / browser測定まで完了
12. Better Auth + D1 — Google OAuth、session、ownership復元をproduction E2Eまで完了
    - user / session schema
    - OAuth callback
    - cookie設定
    - room ownership復元
    - session失効

## 採用結果

現在の実装で採用しているもの:

- Next.js + vinext + TypeScript
- Cloudflare Workers + Hono
- 1 room = 1 Durable Object
- WebSocket Hibernation
- D1 + Durable Objects SQLite
- Canvas 2D provisional描画 + Pointer Events + 共通WASM canonical renderer
- MessagePackと数値wire opcode
- 960 x 640 の白い固定キャンバス
- brush / eraser の stroke 同期
- zoom / pan / eyedropper はローカル UI
- Better Auth を用いたアカウント機能を含む MVP
- ゲスト参加は許可し、ルーム作成はログイン必須
- public slug / unlisted token / 短命 room ticket
- 管理画面は Cloudflare Access で保護
- event log全再生を必須fallbackとして維持
- snapshot-first recovery。event log-onlyをfallbackとして維持
- 作成から最大開催2時間、hard limit 100,000 events / 64MiB
- 通常受付soft limit 93,000 events / 56MiBと終了用予約領域
- MVPではundo / redoなし
- snapshot採用時も総event数・総byte数の活動量上限はリセットしない
- 完成画像のサーバー生成・保存とギャラリーページは MVP 対象外
- 通常終了時はルーム、event log、snapshotを削除し、通報時だけ期限付き証跡を分離保全
- ギャラリー、プロフィール、フレンド、通知は MVP 後

## 計画書の完了条件

作成済みの`docs/plans/mvp-implementation-plan.md`では、少なくとも次を満たす。

- MVP 1-3 の各成果物と依存関係が分かる。
- UI 実装と同期基盤を別トラックで進められる。
- 最初の 2 クライアント同期までの最短経路が分かる。
- event log fallback、共通WASMレンダラー、snapshot vertical slice、再接続、ルーム終了時の削除を早い段階に置く。
- 管理・荒らし対策を公開直前の付け足しにしない。
- アカウント認証とルーム所有権は MVP に含め、ギャラリー、プロフィール、フレンド、通知は必須経路から外す。
- 各段階に計測可能な受け入れ条件がある。
- snapshot優先トラックには、snapshot-firstを採用するかevent log-onlyへ戻すかを早期に判断できる明示的な判定点がある。
- 失敗した場合に MessagePack/CBOR、event log上限、snapshot、ルーム終了方式、フロント構成を見直せる判断点がある。
