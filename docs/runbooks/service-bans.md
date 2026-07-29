# Temporary service BAN runbook

## 適用前

1. Cloudflare Accessで管理画面へ入り、対象roomと接続中memberを確認する。
2. 通報証跡または観測した行為と対象actorが一致することを確認する。
3. 24時間、7日（既定）、30日から必要最小限の期間を選ぶ。
4. 個人情報を書かず、第三者が判断を追える操作理由を入力する。
5. 確認dialogの対象actor末尾と期間を再確認して適用する。

適用後は対象connectionが閉じ、同一user / guest subjectの新規ticketと、
userの新規room作成が拒否される。既存membershipが25 roomを超える場合、
古いconnectionの即時切断は保証しないが、再接続は拒否される。

## 解除

1. 管理画面の「サービスBAN」で対象、期限、理由を確認する。
2. 誤認、異議申立て受理、または措置不要を判断した根拠を解除理由へ記す。
3. 「解除」を実行し、一覧が「解除済み」になったことを確認する。
4. 対象利用者には新しいticketが必要であり、閉じたconnectionは自動復帰しない。

## 障害時

- 適用結果が不明な場合は同じHTTP応答を再送せず、一覧を更新して有効行を確認する。
- 管理APIが503なら、Access認証、Web -> Realtime Service Binding、D1 healthの順に
  確認する。
- 緊急性が高く個別BANが成立しない場合は、`emergency-mode.md`に従い新規入室
  または描画受付を停止する。

## 保存してよい情報

- 内部user / guest subject ID
- source actor ID
- 管理者の不可逆な内部ID
- 理由、適用・期限・解除時刻

生email、Access JWT / `sub`、cookie、room ticket、生IPは記録しない。
