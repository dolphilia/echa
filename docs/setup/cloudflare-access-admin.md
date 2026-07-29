# Cloudflare Access: koge管理画面

更新日: 2026-07-29

## 目的

管理画面と管理APIをCloudflare Accessでdeny by defaultにし、Worker側でも
`Cf-Access-Jwt-Assertion`の署名、issuer、audience、有効期限を検証する。
previewでは2026-07-28、productionでは2026-07-29にAccess applicationと
公開管理routeを接続し、利用者E2Eをpassした。

## previewで設定済みの内容

1. Cloudflare Zero Trust Dashboardの
   `Access controls > Applications`を開く。
2. `Self-hosted and private`のapplicationを作成する。
3. application名を`koge admin preview`とする。
4. 次の2 pathを同じapplicationで保護する。
   - `preview.koge.app/admin/*`
   - `preview.koge.app/api/admin/*`
5. Allow policyには実際に管理を担当するidentityだけを指定する。
   email domain全体やEveryoneは使用しない。
6. session durationは初期値として8時間以下にする。
7. application作成後、Additional settingsから
   Application Audience (AUD) Tagを取得する。
8. Zero Trustのteam domainを確認する。
   形式は`https://<team-name>.cloudflareaccess.com`。

設定値:

- issuer: `https://dolphilia.cloudflareaccess.com`
- AUD:
  `b7536e7cc03d57d8889760015ad850b72f08ae4a838a741054fc02094377c785`

## productionで設定済みの内容

- path: `koge.app/admin/*`、`koge.app/api/admin/*`
- issuer: `https://dolphilia.cloudflareaccess.com`
- AUD:
  `ddfcf25a51f780af02c6cff5073c6ba1fd0a6d42fdd9883a0232076cf5bd29ef`
- deny by default、許可対象identityだけをAllow
- 未認証requestがAccess loginへredirectされることを確認済み
- Access認証後の管理画面と管理操作をproduction利用者E2Eで確認済み

## 取得後に共有・記録する非secret値

| 値 | 例 | 記録先 |
| --- | --- | --- |
| issuer / team domain | `https://example.cloudflareaccess.com` | `environment-inventory.md` |
| preview AUD tag | Access application固有文字列 | `environment-inventory.md` |

どちらも認証credentialではないが、Gitへ記録するのは値を設定する実装時だけとする。
Access cookie、JWT、service token、API tokenは文書やチャットへ貼らない。

実装時のWeb Worker変数名:

- `CF_ACCESS_ISSUER`
- `CF_ACCESS_AUD`

## Worker側の必須検証

- `Cf-Access-Jwt-Assertion` headerを使用する。
- Access certs endpointからRS256公開鍵を取得し、rotationへ追従する。
- issuerが`CF_ACCESS_ISSUER`と完全一致することを確認する。
- audienceに`CF_ACCESS_AUD`が含まれることを確認する。
- `exp`、`nbf`を検証する。
- JWTの`sub`から一方向hashのadmin内部IDを作り、生emailを監査表へ保存しない。
- 管理操作はsame-origin POST、server生成action ID、bounded reasonを必須にする。

## preview確認手順

1. `https://preview.koge.app/admin/rooms`を開く。
2. Cloudflare Accessの許可対象identityで認証する。
3. 管理対象roomと人数が表示されることを確認する。
4. 試験用roomへ理由を入力し、`管理停止`を実行する。
5. room側の接続終了、`管理停止中`表示、再入室拒否を確認する。
6. 同じroomを`強制終了`し、一覧から消えることを確認する。

kick / room BANの確認:

1. 試験用roomを作成し、別ブラウザまたは別sessionで非ホストとして入室する。
2. 管理画面の`参加者管理`を開き、接続中のホスト・描く人・見る人が表示される
   ことを確認する。ホストには退出操作が表示されない。
3. 理由を入力して非ホストへ`退出`を実行し、対象の全接続が閉じることを確認する。
4. 対象ブラウザから明示的に再入室できることを確認する。
5. 同じ対象へ`ルームBAN`を実行し、対象の全接続が閉じることを確認する。
6. 対象ブラウザでreloadまたは再入室し、room終了まで入室を拒否されることを
   確認する。別subjectとホストの接続は維持されることも確認する。

service BANの確認:

1. 削除してよい試験用roomを作成し、別browserで非ホストとして入室する。
2. 管理画面で理由、`24時間`を選び、対象へ`サービスBAN`を適用する。
3. 対象connectionが閉じ、「現在は再入室できません」と表示されることを確認する。
4. 対象browserのreloadと別の公開roomへの入室がともに拒否されることを確認する。
5. 対象がログインuserなら、新規room作成も拒否されることを確認する。
6. 管理画面のサービスBAN一覧に対象、理由、期限が表示されることを確認する。
7. `解除`から解除理由を入力し、一覧が解除済みになることを確認する。
8. 対象browserで明示的に再入室できることを確認する。

試験中に30日を選ばない。誤って別の利用者へ適用した場合は直ちに解除し、
操作理由と解除理由を残す。

emergency modeの確認:

1. 管理用browserで管理画面を開き、試験用roomを1件作成する。roomには
   ホストと別browserを接続し、通常の描画とチャットができることを確認する。
2. 管理画面で「新しいルーム作成を許可」だけを外し、理由を入力して適用する。
   新規room作成が一時停止メッセージになる一方、既存roomは継続することを確認する。
3. room作成を再び許可する。
4. 「新しい入室を許可」だけを外し、未接続の別browserで試験用roomへ入室できない
   こと、既存接続は切れず描画・チャットを継続できることを確認する。
5. 新しい入室を再び許可する。
6. 「描画を許可」だけを外し、最大5秒待ってから描画する。描画停止の通知が表示
   され、停止中の線が残らず、チャットと閲覧を継続できることを確認する。
7. 描画を再び許可し、最大5秒待って新しいstrokeを描けることを確認する。
8. 最後に3項目がすべてcheckedで「通常運用」と表示されることを確認する。

途中で予期しない挙動があった場合も、検証終了前に3項目をすべて許可へ戻す。
詳細な停止・復旧手順は
[`../runbooks/emergency-mode.md`](../runbooks/emergency-mode.md)を参照する。

Access cookie、JWT、画面に表示されたidentity情報は記録しない。

## 参考

- [Cloudflare Access: Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Cloudflare Access: Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/access/app-paths/)
