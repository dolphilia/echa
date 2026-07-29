# Spike: Better Auth with D1

更新日: 2026-07-28
状態: local / preview成立。Google OAuth callback E2E pass

## Goal

MVPに必要なlogin/session、room creation、room ownership復元をCloudflare Workers + D1で安全に実装できるか確認する。

Better AuthはD1 bindingのnative supportを案内している。MVPは安定版
`better-auth@1.6.25`を固定し、1.7 RCは採用しない。

## Decisions required first

- 最初のOAuth provider
- email認証を入れるか
- production/preview/localのbase URL
- account deletion policy

## Minimum implementation

- Better Auth + D1 binding
- generated migrationをrepository管理
- login/logout/session
- Secure/HttpOnly/SameSite cookie
- user IDをownerとするroom作成
- 再login後のhost role復元
- session revoke
- OAuth callback allowlist
- CSRF / Origin validation

guest sessionはBetter Auth user sessionと分離する。MVPでは過去guest actorをuserへ移管しない。

## Tests

- new login
- existing login
- invalid callback/state
- logout/revoke
- expired session
- secret rotation
- duplicate provider account
- room create guest reject
- room create user accept
- ownership restore
- deleted user / suspended user
- D1 timeout

## D1 points

- schemaは採用versionのprogrammatic migration outputをreviewし、
  `migrations/d1/0002_better_auth.sql`へ固定した。
- D1はinteractive transactionを提供しない前提で、使用pluginが要求しないことを確認。
- preview/prod databaseを分離。
- sessionや短命roomをbackupから無条件復元しない。

## 2026-07-28時点の結果

- D1 bindingを直接Better Authへ渡すrequest-scoped auth factoryを実装した。
- `/api/auth/*`を同一originのvinext routeとしてbuildできた。
- generated `Env`にrequired secret名を含め、secret値はconfigへ保存していない。
- Google OAuthだけを有効化し、email/passwordと即時account削除を無効化した。
- Secure / HttpOnly / SameSite=Lax cookie、trusted origin、database rate limitを設定した。
- Workers runtime + local D1で未ログインsession、cookie付きcross-origin拒否、
  短いsecretのfail-closedを試験した。
- auth migrationをlocalと`koge-preview`へ適用した。
- production dependencyの`npm audit --omit=dev`は0 vulnerabilitiesだった。
- Better Authの2026年6月security updateで示されたcore修正版
  `1.6.11`以降を満たす。MVPでSSO、SCIM、OAuth provider pluginは使用しない。

証跡は
[`../results/phase4-auth-home-foundation.md`](../results/phase4-auth-home-foundation.md)
を参照。

## Pass

- Worker runtimeで主要flowが動く。
- migrationを再現できる。
- bundle/startupが許容範囲。
- ownershipがURL tokenではなくuser sessionから復元される。
- security testに重大な未解決がない。

local主要flow、migration再現性、preview OAuth E2Eはpass。preview Workerへ必要な
3 secretを登録し、未ログインsession、Google認可開始、callback、session、logout、
session revoke、再loginを確認した。Googleはclient IDとredirect URIを拒否せず、
sign-in画面から同一originのcallbackへ戻る。

対話試験後のpreview D1は、個人情報やtokenを読まず集計だけを確認した。active user、
Google account、active sessionはいずれも1件で、logout前のsessionは残らず、
再login後のsessionが1件だけ存在した。事前の非対話probeが作った未消費OAuth state
2件は期限付きverificationとして残るが、probeではcallbackを行っていないため
想定内とする。

## Deliverables

- auth config
- D1 migration
- local/preview test
- provider decision
- session/ownership E2E
- version/security advisory確認記録

## Sources

- https://better-auth.com/docs/concepts/database
- https://better-auth.com/docs/installation
- https://better-auth.com/blog/security-update-june-2026
- https://developers.cloudflare.com/d1/worker-api/
