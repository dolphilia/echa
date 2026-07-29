# Phase 0実行記録

実施日: 2026-07-27  
更新日: 2026-07-29  
状態: local / remote preview完了。後続Phaseとproduction初回配備も完了

## 完了した決定

- room開始: hostの明示開始
- MVP認証: Google OAuth 1 provider、メール認証なし
- origin: local / preview / productionを分離し、authはsame-originを第一候補
- account削除: session失効、owned room終了、冪等削除jobの順
- tooling: npm workspace、Node.js 22、vinext、独立realtime Worker

詳細は[`../decisions/README.md`](../decisions/README.md)を参照する。

## 完了した基盤

- root npm workspaceとlockfile
- Node.js 22基準、TypeScript strict、Oxlint
- vinext + Cloudflare Workersの最小Web app
- Hono realtime Worker
- 1 room = 1 SQLite-backed Durable Objectの最小class
- D1、R2、Queue、Durable Object bindings
- `wrangler types`によるgenerated `Env`
- D1 phase 0 migration
- Cloudflare Workers Vitest integration
- GitHub Actions CI
- local secret exampleとgitignore
- 外部サービス入力手順

## 検証結果

| Check | 結果 |
| --- | --- |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm audit` | 0 vulnerabilities |
| `npm run cf:types:check` | Web / Realtimeとも一致 |
| `npm run lint` | pass |
| `npm run typecheck` | pass |
| Realtime Worker integration test | 2 pass |
| Event log benchmark test | 8 pass |
| Renderer fixture test | 1 pass |
| Realtime Worker dry-run build | pass |
| vinext production build | pass |
| local D1 migration | 1 migration pass |

Next.jsのtransitive dependencyに出たPostCSS/Sharp advisoryは、root overrideで修正版へ固定して解消した。overrideはNext.js更新時に不要になったかを再確認する。

vinext buildは成功したが、`1.0.0-beta.4`でありroute classificationに`Unknown`表示がある。
Phase 4でBetter Auth route、cookie、D1を統合し、production利用者E2Eまで成立したため
MVPでは継続採用する。beta依存であることはupgrade時の回帰対象として残す。

## 当時未完了だった項目

次は2026-07-29までに完了した。

- Cloudflare accountの確定
- preview / production originの確定
- preview D1 / R2 / Queueの作成
- preview Worker deployment
- Google OAuth applicationの作成
- remote secret登録
- preview health check

production resource、migration、3 Worker配備、Custom Domain、Access、利用者E2Eも
後続Phaseで完了した。CI API tokenと自動deployだけは未設定である。
現在値は[`../setup/environment-inventory.md`](../setup/environment-inventory.md)を参照する。

## Phase 0の完了判定

local scaffold、decision、remote previewのexit criteriaを満たし、Phase 0は完了した。
最終結果は[`../results/phase0-completion.md`](../results/phase0-completion.md)を参照する。
