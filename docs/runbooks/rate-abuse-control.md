# Rate abuse control

更新日: 2026-07-28  
対象: room内の描画・チャットrate超過

## 目的

一時的な操作の集中と継続的な濫用を区別し、通常利用者をroom BANせずに
段階的に抑制する。

1. 個別frameを`RATE_LIMITED`で拒否する。
2. 同じroom actorで10秒の判定窓内に3回到達したら5秒muteする。
3. mute中を含め8回到達したら、その接続をclose code 1008で切断する。
4. room BANとservice-level BANは自動適用しない。

描画とチャットのrate超過は同じactorへ合算する。高頻度になりやすいcursorは
既存のbest-effort dropだけを使い、この段階判定へ含めない。

## 状態と復元

`actor_abuse_state`をroom DO SQLiteへ保存するため、Hibernation、同じactorの
再接続、新しいconnection IDでも判定を継続する。判定窓が10秒以上経過し、
muteも終了していれば、次の違反から新しい窓として数え直す。

mute中の追加送信は違反として数え、mute期限を5秒延長する。disconnect後に
自動BANはしないため、送信を止めて判定窓とmuteが終了すれば再び利用できる。

## 描画の安全な破棄

rate超過した描画frameはclient sequenceをserver側で順序消費し、clientも
対応するoutbox項目を破棄する。既に始まっているstrokeは、そのactor分だけ
server生成endで確定する。これにより次を防ぐ。

- disconnect後の未ack frame再送loop
- mute終了後に古い線が遅れて現れること
- 部分strokeが未確定のまま残ること

チャットはrate超過したmessageだけを保存・配信しない。

## 観測

room DOは次の累積metricを保持する。

- `rate_limited`
- `short_mute`
- `abuse_disconnect`

short muteとdisconnectへの遷移時だけ、Workers Observabilityへ
`message = "rate abuse escalation"`の構造化warn logを出す。logにはroom内部ID、
room actor ID、段階、mute期限だけを置き、chat本文、生IP、ticket、cookieを
含めない。

急増時は次を確認する。

1. 特定roomだけか、複数roomか。
2. `short_mute`に対して`abuse_disconnect`が過度に多くないか。
3. 正常な描画fixtureで同じ事象を再現するか。
4. サービス全体へ波及する場合はemergency modeで新規作成・入室を段階停止する。

## Closed betaのbaseline比較

room終了時のcleanupは、DO SQLiteを削除する前に最終counterをD1
`rate_abuse_room_outcomes`へ保存する。保存するのはroom IDのSHA-256 digest、
accepted / reject / rate limited / short mute / disconnectの各counterと時刻だけで、
actor、chat本文、stroke payload、IPを含めない。終了counterは30日後に
scheduled maintenanceで削除する。

localhost限定operatorを起動する。

```sh
npm run rate-abuse:operator
```

別terminalで、観測開始時と終了時のcaptureをrepository外へ保存する。

```sh
capture_dir="$(mktemp -d /private/tmp/koge-rate-abuse.XXXXXX)"
npm run rate-abuse:capture -- --out "$capture_dir/baseline.json"

# closed betaの通常利用後
npm run rate-abuse:capture -- --out "$capture_dir/current.json"
npm run rate-abuse:compare -- \
  --baseline "$capture_dir/baseline.json" \
  --current "$capture_dir/current.json"
```

比較は継続中roomのcounter差分、期間内に終了したroomの最終counter、新規roomを
重複なく合算する。次の条件をすべて満たした結果だけを閾値判断へ使う。

- `complete = true`
- 比較期間が30日未満
- 通常利用中に表示されたrate警告、mute、disconnectの利用者報告を別途確認済み
- 自動化fixtureや意図的なabuse試験を通常利用期間へ混ぜていない

`rateLimitedPer10kAcceptedDrawingEvents`は描画acceptedを分母にした補助値であり、
chatを含む厳密なmessage reject率ではない。数値だけで閾値を緩和せず、
誤検知の操作内容と再現fixtureを確認する。

## 値の変更

閾値は`DrawingRoom`の定数へ集約する。一度に複数の値を変更せず、previewの
abuse fixtureと通常描画fixtureを同じ版で比較する。値を緩める場合も、
frame byte、point数、stroke時間、room event上限は変更しない。

## preview利用者E2E

自動試験でmuteとdisconnectの境界を確認したうえで、previewでは通常操作を
壊していないことと短時間muteから復帰できることを確認する。

1. 新規roomを開始し、通常の描画とチャットが成功する。
2. 同じ参加者から短時間にチャット送信を繰り返し、
   rate超過を知らせる表示が出ることを確認する。
3. 続けて送信し、短時間muteを知らせる表示が出ることを確認する。
4. 操作を止めて6秒以上待ち、新しいチャットと描画が成功することを確認する。
5. 別の参加者の描画、チャット、接続には影響しないことを確認する。

自動disconnectの閾値確認は、通常利用者へ不要な切断を起こさないよう
Workers Vitestで行う。previewで実施する場合も試験専用roomだけを使い、
実施後に正常な再接続と10秒以上の無操作後の復帰を確認する。
