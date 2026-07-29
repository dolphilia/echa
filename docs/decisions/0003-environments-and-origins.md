# ADR 0003: local / preview / productionを分離する

日付: 2026-07-27  
状態: 採用

## 判断

local、preview、productionで次を分離する。

- Worker名
- D1 database
- R2 bucket
- Queue / DLQ
- Better Auth secret
- Google OAuth client
- application origin
- realtime origin
- cookieとtrusted origins
- log / alert

production dataをlocalまたはpreviewへ接続しない。preview dataをproduction backupへ含めない。

## Origin

```text
local app:       http://localhost:3000
local realtime:  http://localhost:8787
preview app:     https://preview.koge.app
preview realtime:https://realtime-preview.koge.app
production app:  https://koge.app
production realtime:https://realtime.koge.app
```

auth routeはapplication originの`/api/auth/*`を第一候補とする。realtime Workerが別originでも、auth cookieを直接共有する設計にはしない。Webから短命room ticketを発行し、realtimeへ渡す。

サービス名とCloudflare resource名のprefixには`koge`を使う。`www.koge.app`は別originとして扱わず、production公開時に`https://koge.app`へredirectする。

## 設定の置き場所

- 公開可能なbinding名、resource ID、origin: `apps/*/wrangler.jsonc`
- local public値とlocal secret: `.env.local`または`.dev.vars`。git管理しない
- remote secret: Wrangler secret
- CI deploy credential: repository/organizationのsecret store

値の一覧と入力方法は`docs/setup/external-services.md`を参照する。
