# Stroke protocol v1

更新日: 2026-07-29
状態: drawing、presence、cursorのproduction経路を実装し、利用者E2Eまでpass

## 目的

1 strokeを複数クライアントへ途中表示しつつ、確定時に一度だけ濃度を適用し、同じeventから決定的に再描画できるprotocolを定める。

## 範囲

- 対象: brush、eraser、stroke streaming、再送、重複排除、
  非永続presence / cursor
- 対象外: eyedropper、pan、zoom、undo / redo、筆圧
- canvas: 960 x 640、白背景、sRGB
- drawing codec: MessagePack、数値opcode
- cursor codec: 厳格な小型JSON text frame

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
| `connectionId` | string | 送信接続の識別とack照合に使用。描画結果には使わない |
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
| drawing event rate | 80/s、burst 120 | 暫定 |
| cursor update rate | 20/s、burst 30 | 暫定 |
| room activity soft limit | 93,000 events / 56MiB | 終了処理予約を除く |
| room activity hard limit | 100,000 events / 64MiB | 暫定 |

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
- `SERVICE_EMERGENCY_STOP`

reject eventはdrawing event countへ含めず、理由別metricへ加算する。

`SERVICE_EMERGENCY_STOP`はサービス緊急制御で描画受付を止めている間に返す。
DOは開始済みstrokeをserver生成endで先に確定し、拒否したclient frameの
`clientSeq`も順序どおり消費する。clientは対応するoutbox項目とprovisional
表示を破棄し、再開後に停止中のframeを再送しない。presence、cursor、chat、
閲覧はこのrejectだけでは停止しない。

`RATE_LIMITED`となった描画frameは再接続時に再送しない。serverは正しい
`clientSeq`のframeを順序消費し、clientは対応するoutbox項目をack済みとして
破棄する。actorにactive strokeがあればserver生成endで確定する。

描画とチャットのrate超過はroom actor単位の10秒窓へ合算する。3回で5秒mute、
8回でconnectionをclose code 1008で切断する。mute中の送信も違反へ含めて
期限を延長するが、自動room BANは行わない。cursor dropは合算しない。

## Room activity通知とsoft close

soft limitはhard limitから、最大20 actorが進行中strokeを完了するための
7,000 events / 8MiBを予約した値とする。eventまたはpayloadの先着で判定し、
soft limitに対する80%、90%、98%、100%到達時に次を配信する。

```json
{
  "type": "room.activity",
  "level": 98,
  "eventCount": 91140,
  "eventLimit": 93000,
  "payloadBytes": 12000000,
  "payloadLimitBytes": 58720256,
  "acceptingNewStrokes": true
}
```

100%では`acceptingNewStrokes`をfalseにし、新しい`stroke.begin`を
`ROOM_LIMIT_REACHED`で拒否する。既に受理済みのstrokeはappend、end、cancel、
2秒timeoutを継続できる。未完了strokeが0になった時点で
`activity_limit`理由のclosingへ進む。hard limitへ到達した場合は予約枯渇を
避けるため、server生成endで即時closingへ進む。

warning levelとlimit到達時刻はDO SQLiteへ永続化し、Hibernationまたは再接続後にも
復元する。

## Room time通知

作成時刻からの最大時間に対し、15分、5分、1分前に次を配信する。

```json
{
  "type": "room.time",
  "warningMinutes": 5,
  "endsAt": 1722000300000,
  "remainingMs": 299500
}
```

`warningMinutes`は`15 | 5 | 1`、`endsAt`はserverが保持する絶対期限、
`remainingMs`は送信時点の非負整数とする。alarmが遅れて複数の境界を越えた場合は、
現在時刻に対応する最も新しい段階だけを送る。最後に到達した段階はDO SQLiteへ
永続化し、再接続時には最新の`remainingMs`で再送する。この通知はdrawing event
log、roomSeq、idle activityへ含めない。

Cloudflare Workers上のrate limiterは、CPU処理だけが続く間の`Date.now()`差分を
token補充の唯一の根拠にしない。runtimeの時刻はI/O境界まで進まないため、
tokenが枯渇へ近づいた場合だけbounded storage readで時刻を更新し、通常経路では
memory上のbucketを使用する。token、更新時刻、connection attachmentは再起動後も
安全側へ復元する。

## Presenceとcursor

presenceは接続中WebSocketのattachmentから再構成し、event logへ保存しない。
同じroom actorの複数connectionは1 memberへまとめ、actorと
`host | participant | viewer`を配信する。接続・退出時に最新snapshotを
best effortで配信する。

cursorはcanvas論理座標だけを受理し、event log、snapshot、idle activityへ
含めない。clientは最大20Hzを目安に送信し、DOはdrawingとは独立した
20/s・burst 30のtoken bucketをconnectionごとに適用する。超過cursorは
描画を止めずに破棄する。viewerもcursorを送信できる。

Hibernation後はconnection attachmentからpresenceを再構成する。cursorの
最新座標は復元せず、次のclient updateを待つ。clientは2秒更新がないremote
cursorを画面から除去する。

## Versioning

- additiveなoptional fieldだけを同じ`v`で追加できる。
- 描画結果が変わる変更はprotocol versionとrenderer versionを上げる。
- serverは対応外versionを黙って近似せず拒否する。
- snapshot manifestはprotocol versionとrenderer versionを保持する。

## 未決定

- renderer内部の固定小数点scale
- points / strokeとframe byteの最終値
