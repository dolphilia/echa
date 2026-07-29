# ADR 0004: account削除はsession失効、room終了、削除jobの順で処理する

日付: 2026-07-27  
状態: 採用・実装済み（migration `0018`は次回deploymentで適用）

## 判断

account削除requestを受けたら、次の順で処理する。

1. userを`deleting`にし、新規login、room作成、ownership操作を停止する。
2. 全sessionとprovider tokenを失効させる。
3. userがhostの開催中roomをclosingへ移し、通常のroom cleanupを完了する。
4. D1のownership、membership、provider account、session、userを冪等なjobで削除する。
5. 通報・BANなど保持根拠がある証跡だけを、通常accountから切り離した内部参照で期限まで保持する。
6. job完了後は元userへ復元できない。

## 理由

- accountだけを先に消してhost不在roomを残さない。
- 通常終了と同じroom cleanup経路を再利用できる。
- 外部I/O失敗時に一部だけ復活する状態を避けられる。
- moderation evidenceを通常のaccount dataと分離できる。

## 公開前に決めるもの

- 利用者向けの猶予または即時削除表示
- provider token revokeの失敗時対応
- 法令・通報対応に必要な保持期間
- backupからの削除反映期間
- 削除完了通知を提供するか

## 2026-07-29 実装

- 設定画面で確認入力`delete`と確認dialogの二段階確認を必須にした。
- 24時間以内に作成されたsessionをfresh sessionとして要求する。
- request受付時に全sessionとprovider accountをD1から削除する。
- 所有roomはroom DOの通常cleanupへ送り、失敗時はscheduled scanで再試行する。
- 最後の所有room削除後にuserを物理削除する。
- moderation上の保持対象はuser IDを不可逆digestへ置換してから保持する。
- 利用者には削除requestを即時受理したことを表示し、完了通知はMVPでは
  提供しない。
