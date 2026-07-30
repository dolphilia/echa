# 公開ルームサムネイル仕様

更新日: 2026-07-30
状態: 実装済み、preview機能検証済み

## 範囲

サムネイルは開催中の公開ルームを一覧で識別するための一時的な派生画像である。
完成画像、ギャラリー、証跡、room終了後の保存には使わない。

- source: generation 2の1000 x 1000 canonical RGBA
- output: 512 x 512、不透明sRGB PNG
- 対象: `visibility = public`かつ`status IN (active, idle)`
- 対象外: waiting、unlisted、closing、suspended、削除済みroom

## 生成

通常snapshot commit後、同じRGBAをbilinear縮小する。サムネイルのためにeventを
再取得・再生しない。object keyは次のversion付き形式とする。

```text
rooms/{internal-room-id}/thumbnails/{base-room-seq}.png
```

D1 `rooms.thumbnail_base_room_seq`が前進する場合だけprojectionを更新する。遅れて完了
した古いjobは現在の参照を巻き戻さず、自分の不要objectを削除する。更新成功後と
`newer_thumbnail`によるskip時はroom prefixを列挙し、現在より古いsequenceのobjectを
削除する。これによりQueue再送時も旧object残存を自己修復する。

snapshot commit後に処理が失敗した場合は`thumbnail.retry` messageを同じSnapshot
Queueへ送る。retry consumerはcommit済み`.kgs`のobject hash、RGBA hash、renderer、
寸法を検証してdecodeし、画像処理だけを行う。

## 初回one-shot

public roomがactiveになった時点で5分後をDO SQLiteへ記録する。

- 期限前に描画snapshotがcommitされた場合は`satisfied`にする。
- 期限時点で確定strokeがあれば現在のcompleted-stroke boundaryを1回enqueueする。
- strokeがactiveなら確定まで待つ。
- 描画がなければ`waiting_for_stroke`とし、pollingしない。
- 期限後の最初の確定strokeで1回だけenqueueする。
- feature flag停止、unlisted、suspend、closingでは無効化する。
- Queue sendより前にjob IDをDO SQLiteへ同期予約し、同一境界の並列判定を1 jobへ
  集約する。

## 配信

一覧にはnullableな`thumbnailVersion`だけを返す。

```text
GET /api/rooms/{public-slug}/thumbnail?v={base-room-seq}
```

endpointはD1が現在参照するpublic active / idle roomとversionの一致を確認してから、
private R2 objectをstreamする。正常画像はbrowser内のprivate immutable cacheと
ETagを付け、共有CDNには保存しない。これにより、公開中に取得済みのbrowserは同じ
versionを再取得せず、新しいrequestはD1のvisibility / lifecycle検証を必ず通る。D1参照は
あるがobjectが一時的に見つからない場合は短時間cacheの共通placeholderを返す。
version不一致、unlisted、終了済み、flag停止は404でfail-closedにする。

## Cleanupと観測

room cleanup Queueはroom prefix配下のthumbnailを列挙・削除してからroom projectionを
削除する。publishと終了が競合してD1更新が拒否された暫定objectも、対象roomが
非適格ならpublish側で削除する。失敗時は既存のQueue retry / DLQ fenceを使う。
orphan inventoryはruntime snapshot R2とthumbnail R2を同じ2回scan・明示確認の手順で
検出、削除する。

通常logにはjob ID、room ID、baseRoomSeq、処理status、bytes、wall timeだけを残し、
stroke payload、chat本文、tokenを記録しない。
