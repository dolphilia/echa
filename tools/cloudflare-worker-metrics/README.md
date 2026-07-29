# Cloudflare Worker metrics query

Cloudflare GraphQL Analytics APIからWorkerのCPU quantileとmemory usage quantileを
読み取る。API tokenは引数、repository file、出力へ含めない。

必要なtoken権限:

- Account
- Account Analytics
- Read
- account resourceは対象のkoge accountだけ

測定時だけshell環境へ`CLOUDFLARE_ANALYTICS_API_TOKEN`を設定し、実行後に解除する。

```sh
read -s CLOUDFLARE_ANALYTICS_API_TOKEN
export CLOUDFLARE_ANALYTICS_API_TOKEN

node tools/cloudflare-worker-metrics/cli/query.mjs \
  --account add7fa1a3932f0d7e81b8c668f42156f \
  --script koge-snapshot-preview \
  --from 2026-07-27T14:25:00Z \
  --to 2026-07-27T14:36:00Z

unset CLOUDFLARE_ANALYTICS_API_TOKEN
```

`read -s`で入力したtokenは画面へ表示されない。shell historyへtoken値を直接書かない。
出力の`maximumMemoryBytes.memoryUsageBytesP999`が
`targetMaximumBytesForThirtyPercentHeadroom`以下なら、128 MiB制限へ30%以上の余裕を
持つ目安とする。
