# ADR 0005: npm workspace、vinext、独立realtime Workerで開始する

日付: 2026-07-27  
状態: 暫定採用

## 判断

- npm workspaceを使用する。
- Node.js 22をCIと開発の基準にする。
- Webはvinext `1.0.0-beta.4`でscaffoldし、Cloudflare Workers buildをPhase 0で確認する。
- realtimeはHonoを使用する独立Workerとし、1 room = 1 SQLite-backed Durable Objectを置く。
- Wrangler configはJSONC、compatibility dateは`2026-07-27`とする。
- binding typeは`wrangler types`で生成し、手書きしない。
- lintはOxlint、Workers integration testはVitest 4 + Cloudflare Workers poolを使用する。

## 理由

- Web UIと高頻度WebSocket処理を独立して検証できる。
- protocol packageを後から両方へ共有しやすい。
- vinextが成立しなくても、realtime Workerとprotocolを維持したままWebだけReact + Viteへ交換できる。

## 判定

Phase 0時点で次を確認する。

- vinext production build
- realtime Worker dry-run build
- generated binding types
- D1とSQLite-backed Durable Objectを使うlocal integration test

vinextはbetaであるため、本番採用はPhase 4の認証、cookie、server renderingを含むbuildを再確認して確定する。
