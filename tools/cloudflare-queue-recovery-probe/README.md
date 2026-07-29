# Cloudflare Queue recovery probe

Phase 6のpreview限定probe。製品Queueのduplicate / DLQ / unchanged-body
reinsertionを確認するために使う。

- `wrangler.producer.jsonc`: 短命なworkers.dev endpointからprobe jobをmain
  Queueへ1回だけ送る。deploy時にランダムな`PROBE_TOKEN`を`--var`で渡し、
  `x-koge-queue-probe-token` headerに同じ値を付ける。
- `wrangler.rescue.jsonc`: DLQへ短命なconsumerを接続し、probe bodyだけをmain
  Queueへ戻す。
- `evidence_dlq_probe_`以外のmessageはmain Queueへ送らない。
- rescue consumerは検証直後に必ず削除する。
- D1 fixtureは`status = deleted`だけを使い、検証後に削除する。
- probe Workerは検証直後に削除する。
- Queue bindingは`wrangler dev --remote`未対応のためremote devでは送信しない。
