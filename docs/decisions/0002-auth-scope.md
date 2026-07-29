# ADR 0002: MVPはGoogle OAuth 1種類、メール認証なし

日付: 2026-07-27  
状態: 採用

## 判断

- MVPのアカウント認証はBetter Authを使用する。
- 最初のsocial providerはGoogle OAuthとする。
- email/password、magic link、メール確認、パスワード再設定はMVPに含めない。
- auth routeは原則としてWebと同じoriginの`/api/auth/*`へ置く。
- Better Auth + D1の成立性はPhase 4のauth spikeで最終確認する。

## 理由

- room作成とhost ownership復元に必要なaccount機能を最小化できる。
- メール配送、password保管、recovery、abuse対応をMVPから外せる。
- same-originにすることでcookieとCORSの構成を単純にできる。

## 制約

- provider障害時の代替loginはMVPにない。
- Google Cloud ConsoleのOAuth consent screen、client ID、client secretが必要。
- production公開前にhomepage、privacy policy、terms、support contactを用意する。
- provider追加時はaccount linkingと同一emailの扱いを別recordで決める。

## Callback

Better Authの既定`basePath`を使用する場合、Googleのredirect URI候補は次になる。

```text
{APP_ORIGIN}/api/auth/callback/google
```

実際のURIはPhase 4で採用versionのhandlerを動かして確認してからGoogle Cloud Consoleへ確定登録する。
