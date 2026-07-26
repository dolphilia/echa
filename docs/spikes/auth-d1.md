# Spike: Better Auth with D1

## Goal

MVPに必要なlogin/session、room creation、room ownership復元をCloudflare Workers + D1で安全に実装できるか確認する。

Better Authは2026年時点でD1 bindingのnative supportを案内しているが、採用versionを固定して実環境で確認する。

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

- schemaはBetter Auth CLIまたはprogrammatic migration outputをreviewして固定。
- D1はinteractive transactionを提供しない前提で、使用pluginが要求しないことを確認。
- preview/prod databaseを分離。
- sessionや短命roomをbackupから無条件復元しない。

## Pass

- Worker runtimeで主要flowが動く。
- migrationを再現できる。
- bundle/startupが許容範囲。
- ownershipがURL tokenではなくuser sessionから復元される。
- security testに重大な未解決がない。

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
- https://developers.cloudflare.com/d1/worker-api/

