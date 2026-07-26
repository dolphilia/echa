# Stroke protocol v1

更新日: 2026-07-27
状態: 実装前初稿

## 目的

1 strokeを複数クライアントへ途中表示しつつ、確定時に一度だけ濃度を適用し、同じeventから決定的に再描画できるprotocolを定める。

## 範囲

- 対象: brush、eraser、stroke streaming、再送、重複排除
- 対象外: eyedropper、pan、zoom、undo / redo、筆圧
- canvas: 960 x 640、白背景、sRGB
- codec: MessagePack第一候補、CBOR代替候補

codec確定前は、以下を論理schemaとして扱う。文字列opcodeは読みやすさを優先した表現であり、数値opcodeへの圧縮は互換fixtureを作ってから判断する。

## 共通フィールド

### Clientから送るevent

| field | type | rule |
| --- | --- | --- |
| `v` | integer | `1` |
| `op` | string | event種別 |
| `clientSeq` | integer | 接続内で1から単調増加 |
| `id` | string | 128bit以上のランダムstroke ID |

### Serverが受理したevent

client eventへ次を付与または関連づけて永続化・配信する。

| field | type | rule |
| --- | --- | --- |
| `roomSeq` | integer | room内で1から単調増加 |
| `actor` | string | beginへ付与。append/end/cancelはstroke IDから解決 |
| `acceptedAt` | integer | storage metadata。描画payloadと結果には使わない |

clientが送った`actor`、`roomSeq`、`acceptedAt`は信用しない。

## Point

pointは`[x, y, dt]`の3要素配列とする。

- `x`, `y`: canvas論理px。小数第2位へ丸める。
- `dt`: stroke開始からの非負整数ms。
- renderer内部では同じ固定小数点規則へ変換し、Browser / Workers間の差をなくす。
- MVPではpressureを持たない。

座標はcanvas内だけを受理する。端のアンチエイリアスはrendererがclipする。

## Event

### `stroke.begin`

```json
{
  "v": 1,
  "op": "stroke.begin",
  "clientSeq": 1,
  "id": "01J...random...",
  "tool": "brush",
  "color": "#579303",
  "size": 8,
  "opacity": 1,
  "point": [110.25, 155.5, 0]
}
```

- `tool`: `brush`または`eraser`
- `color`: lowercase `#rrggbb`のsRGB文字列
- `size`: canvas論理px
- `opacity`: 0.05から1。小数第2位へ丸める
- eraserでも`tool`を保持する。MVPの描画結果は白色、opacity 100として扱う。
- begin受理後にUI値が変わっても同じstrokeへ反映しない。

### `stroke.append`

```json
{
  "v": 1,
  "op": "stroke.append",
  "clientSeq": 2,
  "id": "01J...random...",
  "points": [
    [126.0, 151.0, 18],
    [145.0, 149.0, 36]
  ]
}
```

同じstrokeの`dt`は非減少とする。空配列は拒否する。

### `stroke.end`

```json
{
  "v": 1,
  "op": "stroke.end",
  "clientSeq": 3,
  "id": "01J...random..."
}
```

受理済みpointsを1 strokeとして確定する。単点strokeもdotとして有効。

### `stroke.cancel`

```json
{
  "v": 1,
  "op": "stroke.cancel",
  "clientSeq": 3,
  "id": "01J...random..."
}
```

未確定strokeを破棄する。`pointercancel`時は可能な限りこれを送る。

## 描画規則

1. beginでstroke専用provisional layerを作る。
2. appendで全pointsを同じlayerへ描き直す。
3. provisional layer自体はopacity 100で描画する。
4. end時にbrush opacityを一度だけ適用してbase canvasへ合成する。
5. eraserはMVPでは白色・opacity 100で合成する。
6. cancel時はbase canvasへ合成しない。

curve補間、丸め、line cap、eraser倍率はrenderer仕様で固定する。モックアップの現在値はround cap / round join、quadratic curve、eraser幅`size * 2.2`だが、WASM renderer fixtureのhash確定までは暫定とする。

## Batchingと上限

| item | 初期値 | 状態 |
| --- | ---: | --- |
| append interval | 50ms | 暫定 |
| points / append | 12 | 暫定 |
| size | 1-60px | モック準拠 |
| opacity | 0.05-1 | モック準拠 |
| points / stroke | 4096 | 暫定安全弁 |
| stroke duration | 120秒 | 暫定安全弁 |
| encoded WebSocket frame | 64KiB | アプリ側暫定上限 |
| unfinished strokes / actor | 1 | 決定 |

Cloudflare側の最大message sizeより十分小さいアプリ側上限を持つ。上限値はcodec実装後に実byteで再測定する。

## 順序・重複・再送

- DOは`clientSeq`が直前以下なら重複または古いeventとして扱う。
- 重複判定keyは`sessionId + connectionId + clientSeq`。
- stroke lifecycleの整合性は`actor + strokeId`でも確認する。
- begin前のappend/end/cancelは拒否する。
- end/cancel後のappendは拒否する。
- clientはack済み`clientSeq`と最後に適用した`roomSeq`を保持する。
- 再接続では新しいroom ticketとconnection IDを取得し、`lastRoomSeq`からresumeする。
- 未ack eventの再送時も同じstroke IDとclientSeqを使う。

## 未完了stroke

- end/cancelがなければ、最後のappendから暫定2秒後にDOが自動確定する。
- 切断しても直ちに破棄しない。
- 自動確定はserver生成の`stroke.end`相当eventとしてroomSeqを持つ。
- 明示的cancelとtimeoutが競合した場合、先に永続化された終端eventを採用する。
- timeout値は低速回線試験で再評価する。

## Reject

最小error code:

- `UNSUPPORTED_VERSION`
- `UNKNOWN_OPCODE`
- `UNAUTHORIZED`
- `ROLE_FORBIDDEN`
- `ROOM_NOT_ACTIVE`
- `RATE_LIMITED`
- `MESSAGE_TOO_LARGE`
- `INVALID_FIELD`
- `OUT_OF_ORDER`
- `DUPLICATE`
- `STROKE_NOT_FOUND`
- `STROKE_ALREADY_FINAL`
- `ROOM_LIMIT_REACHED`

reject eventはdrawing event countへ含めず、理由別metricへ加算する。

## Versioning

- additiveなoptional fieldだけを同じ`v`で追加できる。
- 描画結果が変わる変更はprotocol versionとrenderer versionを上げる。
- serverは対応外versionを黙って近似せず拒否する。
- snapshot manifestはprotocol versionとrenderer versionを保持する。

## 未決定

- MessagePack / CBORの最終選択
- string / numeric opcode
- renderer内部の固定小数点scale
- actorごとのmessage rate
- points / strokeとframe byteの最終値
