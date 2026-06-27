# お絵描き配信サイトの技術スタック調査

調査日: 2026-06-27

## 結論

お絵描き配信サイトの第一候補は、Cloudflare Workers + D1/R2 + Durable Objects + Cloudflare Stream。

お絵描きチャットと違い、配信サイトの主コストはリアルタイム同期ではなく動画の視聴分数または転送量。低フレームレートにできる点は有利だが、マネージド動画配信サービスでは「動画の分数」や「視聴者へ配信した分数」で課金されることが多く、フレームレートを下げても料金が比例して下がるとは限らない。

それでも Cloudflare Stream を第一候補にする理由:

- OBS/ブラウザからの live ingest、HLS 再生、録画、サムネイル、分析をまとめやすい。
- Ingress と encoding が無料。課金軸は保存分数と配信分数の 2 つで読みやすい。
- Workers/D1/R2/Durable Objects と組み合わせると、配信ページ、認証、コメント、通知、通報、配信キー管理を同じプラットフォームで持てる。
- 自前で FFmpeg/RTMP/HLS/CDN を運用するより、障害時の責任範囲が狭い。

小規模で毎月の動画コストを極限まで下げたいなら、YouTube Live / Twitch などに配信して自サイトは埋め込み・番組表・コメント補助だけを持つ案も強い。ただし、外部プラットフォームの規約、広告、アカウント停止、UI 制約、アーカイブ制御に依存する。

## 前提

小規模コミュニティの通常ケースを次のように置く。

- 1,000 MAU
- 配信者 20-30 人/月
- 月 100 時間のライブ配信
- 平均同時視聴者 10 人
- ピーク同時視聴者 20-50 人
- 月間視聴時間 1,000 viewer-hours = 60,000 delivered minutes
- アーカイブは 30 日保持し、月 6,000 stored minutes
- 配信品質は 720p / 10-15fps / 0.6-1.5Mbps 程度を標準にする
- 為替は概算で 1 USD = 162 円

お絵描き配信では、ゲーム配信ほど 60fps は不要。画面の大部分が静止し、変化も筆跡中心なので、OBS やブラウザ側で低 fps・低 bitrate に寄せる。音声ありでも 720p 10-15fps で十分なケースが多い。

ただし、個人運営の小規模コミュニティでは、この通常ケースはやや強めの見積もり。pixivSketch Live の観測感に近づけるなら、次のような分布を想定したほうがよい。

- 非常に有名な絵描き: 同時視聴 200 人程度。ただし頻度は低い。
- 普段の人気絵描き: 同時視聴 20 人程度。
- 定期的に配信している人: 同時視聴 10 人程度。
- 無名/新規配信者: 同時視聴 1-2 人程度。

この分布では、配信時間の大半を無名/小規模配信が占めるなら、月平均の同時視聴者は 3-5 人程度で見積もるほうが自然。以後、従来の平均 10 人は「小規模通常・強め」、平均 3-5 人は「個人運営の現実ケース」として扱う。

## 推奨構成

### アプリ基盤

- フロントエンド: React + Vite または Next.js
- API/runtime: Cloudflare Workers + Hono
- DB: D1
- オブジェクト保存: R2
- リアルタイムコメント/視聴者数: Durable Objects + WebSocket Hibernation
- 動画配信: Cloudflare Stream
- 認証: まず匿名視聴 + 配信者アカウント。公開運用時に OAuth/メール認証。

### 配信経路

配信者:

- OBS から RTMPS/SRT で Cloudflare Stream へ送信
- ブラウザ配信を作る場合は MediaRecorder/WebRTC から server 側 ingest へつなぐ。ただし MVP では OBS 優先。

視聴者:

- Cloudflare Stream Player または HLS.js で再生
- 低遅延が必要なら LL-HLS / WebRTC 系を検討
- コメントは動画とは別に Durable Objects で同期

### データモデル

- `User`
- `Channel`
- `StreamSession`
- `StreamKey`
- `LiveStatus`
- `ChatMessage`
- `ModerationAction`
- `Archive`
- `Follow`
- `Notification`

動画そのものは Cloudflare Stream に置き、D1 には video id、配信状態、タイトル、タグ、公開範囲、アーカイブ期限などを保存する。

## 技術選択肢

### Cloudflare Stream

最もバランスがよい第一候補。

Cloudflare Stream は、保存分数と配信分数だけで課金される。Ingress と encoding は無料で、帯域追加課金も配信分数に含まれる。保存は $5/1,000 minutes、配信は $1/1,000 minutes。

通常ケース:

- 配信: 60,000 delivered minutes x $1/1,000 = $60
- 録画保存: 6,000 stored minutes x $5/1,000 = $30
- Workers/D1/R2/DO: $5-10
- 合計: $95-100/月 = 約 15,400-16,200 円/月

アーカイブを保存しない、または外部に逃がす場合:

- 配信 $60 + アプリ $5-10 = $65-70/月 = 約 10,500-11,300 円/月

注意点:

- 低 fps/低 bitrate にしても Stream の課金は基本的に分数ベース。
- アーカイブ保存が効く。短期保持・自動削除・重要配信だけ保存が必要。
- 画質別の細かいコスト制御は自前 HLS より弱い。

### YouTube Live / Twitch 埋め込み

最安の選択肢。動画配信は YouTube/Twitch に任せ、自サイトは番組表、プロフィール、タグ検索、コメント補助、通知だけを持つ。

通常ケース:

- 動画配信: $0
- アプリ基盤: Cloudflare Workers/D1/R2/DO で $5-10/月
- 合計: 約 800-1,600 円/月 + ドメイン代

向いている場合:

- 最初の公開検証
- 動画配信基盤の運用を避けたい
- 収益化やアーカイブも既存プラットフォームに寄せてよい

注意点:

- UI、広告、アーカイブ、BAN、規約、配信者アカウント要件に依存する。
- 自サイト内の視聴体験を完全には制御できない。
- 配信者が自分の YouTube/Twitch アカウントを持つ必要がある。

### AWS IVS

低遅延ライブ配信のマネージド基盤。OBS からの配信、低遅延視聴、チャットなどを AWS に寄せられる。

AWS IVS Low-Latency Streaming は、入力時間と出力時間で課金される。Basic channel は入力 $0.20/hour。日本/香港/東南アジアの HD 出力は最初の 10,000 hours で $0.092/hour。

通常ケース:

- 入力: 100 live hours x $0.20 = $20
- 出力: 1,000 viewer-hours x $0.092 = $92
- アプリ/DB/録画/S3/ログ: $10-30+
- 合計: $120-150/月 = 約 19,400-24,300 円/月

向いている場合:

- AWS に寄せたい
- 低遅延と配信機能を重視する
- 将来、Cognito/S3/Lambda/DynamoDB/CloudFront と統合する

注意点:

- AWS 周辺サービスの費用と運用が乗る。
- お絵描き配信の小規模 MVP にはやや重い。

### Mux

動画 API とプレイヤー、分析が強い。料金ページでは video delivery が 100,000 free minutes/month 以後 $0.0008/min、storage が $0.0024/min から、input は starting at free。

通常ケース:

- Delivery: 60,000 minutes は free 枠内の可能性がある
- Storage: 6,000 minutes x $0.0024 = $14.40
- アプリ基盤: $5-10
- 合計: $20-40/月 = 約 3,200-6,500 円/月

向いている場合:

- 動画 API と分析を重視する
- 小規模で delivery free 枠に収まる
- Mux Player / Mux Data を使いたい

注意点:

- 「starting at」表記のため、実際の live workflow、画質、機能、利用条件で見積もり確認が必要。
- カスタムドメインなど一部機能は追加費用がある。

### Livepeer Studio

分散型動画基盤を使った managed streaming。Free Sandbox は 1,000 transcoding minutes、60 storage minutes、5,000 delivery minutes、concurrent viewers up to 30。Growth は $100 minimum monthly spend。

通常ケース:

- Free 枠は delivery 5,000 minutes で足りない
- Growth は最小 $100/月
- 合計: $100/月以上 = 約 16,200 円/月以上

向いている場合:

- Livepeer エコシステムを使いたい
- concurrent viewers と配信基盤を managed にしたい

注意点:

- 小規模でも本番利用では $100 minimum が支配的。

### 自前 VPS + RTMP/SRT + HLS + CDN

MediaMTX、OvenMediaEngine、nginx-rtmp、FFmpeg などで ingest し、HLS/LL-HLS を生成して CDN へ配信する構成。

通常ケースで 720p 10-15fps / 0.6-1.5Mbps とすると:

- 60,000 viewer-minutes
- 0.6Mbps なら約 270GB/月
- 1.0Mbps なら約 450GB/月
- 1.5Mbps なら約 675GB/月

VPS + CDN の目安:

- VPS: $10-25/月
- CDN: Bunny CDN Asia/Oceania $0.03/GB なら 270-675GB で $8-20/月
- アーカイブ保存: R2/Bunny Storage 等で $1-5/月
- 合計: $25-60/月 = 約 4,100-9,700 円/月

向いている場合:

- コストを抑えたい
- 画質/ビットレート/アーカイブ保存を細かく制御したい
- 多少の運用負担を受け入れられる

注意点:

- 障害対応、OBS 接続トラブル、HLS セグメント生成、録画、再起動、監視、DDoS、CDN キャッシュ制御を自分で見る。
- 配信者が複数同時に増えると CPU、I/O、帯域、オリジン負荷が急に問題になる。
- FFmpeg でサーバー側 transcoding を始めると CPU/GPU コストが跳ねる。MVP では配信者側 OBS に単一画質で encode してもらう。

### Bunny Stream / Bunny CDN

Bunny Stream は encoding free、storage from $0.01/GB、CDN from $0.005/GB と帯域課金が安い。動画ファイル配信やアーカイブ配信には有力。ライブ ingest の要件が合うかは実装前に確認する。

自前 ingest + Bunny CDN の HLS 配信として使うなら、上記 VPS + CDN 案に近い。小規模では $20-50/月程度に収まる可能性がある。

## 月額比較

小規模通常・強めケース、1 USD = 162 円。

| 構成 | 月額目安 | 円/月の概算 | 評価 |
| --- | ---: | ---: | --- |
| YouTube Live / Twitch 埋め込み + 自サイト | $5-10 | 約 800-1,600 円 | 最安。外部依存が許容できるなら初期検証向き。 |
| Mux | $20-40 | 約 3,200-6,500 円 | 小規模で free delivery に収まるなら強い。要見積もり確認。 |
| VPS + RTMP/HLS + CDN | $25-60 | 約 4,100-9,700 円 | 安いが運用負担あり。技術的には中級以上。 |
| Cloudflare Stream + Workers/D1/R2/DO | $95-100 | 約 15,400-16,200 円 | 第一候補。料金は上がるが運用が軽い。 |
| Cloudflare Stream アーカイブなし | $65-70 | 約 10,500-11,300 円 | 録画を持たないなら現実的。 |
| Livepeer Studio Growth | $100+ | 約 16,200 円+ | 最低利用料が支配的。 |
| AWS IVS | $120-150+ | 約 19,400-24,300 円+ | AWS 統一・低遅延重視なら候補。 |

## 個人運営向けの低め試算

個人運営の現実ケースを次のように置く。

- 月 100 時間のライブ配信
- 平均同時視聴者 3 人
- 月間視聴時間 300 viewer-hours = 18,000 delivered minutes
- アーカイブは 30 日保持し、月 6,000 stored minutes
- 有名配信者の単発スパイクは別枠で吸収する

Cloudflare Stream:

- 配信: 18,000 delivered minutes x $1/1,000 = $18
- 録画保存: 6,000 stored minutes x $5/1,000 = $30
- Workers/D1/R2/DO: $5-10
- 合計: $53-58/月 = 約 8,600-9,400 円/月

Cloudflare Stream アーカイブなし:

- 配信 $18 + アプリ $5-10 = $23-28/月 = 約 3,700-4,500 円/月

自前 VPS + HLS + CDN:

- 18,000 viewer-minutes
- 0.6Mbps なら約 81GB/月
- 1.0Mbps なら約 135GB/月
- 1.5Mbps なら約 203GB/月
- VPS $10-25 + CDN $3-7 + 保存 $1-5
- 合計: $15-40/月 = 約 2,400-6,500 円/月

YouTube/Twitch 埋め込み:

- 動画配信 $0
- アプリ基盤 $5-10
- 合計: 約 800-1,600 円/月

個人運営の現実ケースでの比較:

| 構成 | 月額目安 | 円/月の概算 | 評価 |
| --- | ---: | ---: | --- |
| YouTube Live / Twitch 埋め込み + 自サイト | $5-10 | 約 800-1,600 円 | 最安。初期検証向き。 |
| VPS + RTMP/HLS + CDN | $15-40 | 約 2,400-6,500 円 | 安いが運用負担あり。 |
| Cloudflare Stream アーカイブなし | $23-28 | 約 3,700-4,500 円 | 録画不要なら現実的。 |
| Cloudflare Stream + アーカイブ30日 | $53-58 | 約 8,600-9,400 円 | 独自配信基盤として扱いやすい。 |
| Mux | $20-40 | 約 3,200-6,500 円 | 条件が合えば強い。要見積もり確認。 |
| AWS IVS | $45-70+ | 約 7,300-11,300 円+ | AWS 統一なら候補。 |

### スパイクの影響

同時視聴 200 人の有名配信者が 2 時間配信した場合:

- viewer-hours = 200 x 2 = 400
- delivered minutes = 24,000
- Cloudflare Stream delivery = $24 = 約 3,900 円

つまり、Cloudflare Stream では「非常に有名な絵描きの 2 時間配信 1 回」が、個人運営の通常月 18,000 delivered minutes より大きいコストになる。月額上限を守るには、次の対策が必要。

- 月の delivered minutes 予算を決めて dashboard に出す。
- 人気配信者のスパイクを検知したら、アーカイブ保存を短くする。
- 配信者ごとに月間配信時間またはアーカイブ保持量の上限を持つ。
- 予算超過時は新規配信開始を一時停止し、既存配信だけ継続する。
- 本当に大きい配信は YouTube/Twitch 併用に逃がす。

## 規模別の目安

Cloudflare Stream 前提。

| 規模 | 仮定 | 月額目安 |
| --- | --- | ---: |
| クローズドα | 20 live hours/月、平均 5 視聴者、録画 30日 | $15-25 |
| 個人運営・低め | 100 live hours/月、平均 3 視聴者、録画 30日 | $53-58 |
| 個人運営・低め録画なし | 100 live hours/月、平均 3 視聴者、録画なし | $23-28 |
| 小規模通常 | 100 live hours/月、平均 10 視聴者、録画 30日 | $95-100 |
| 小規模・録画なし | 100 live hours/月、平均 10 視聴者、録画なし | $65-70 |
| 中規模 | 300 live hours/月、平均 15 視聴者、録画 30日 | $360-370 |
| ピーク拡大 | 500 live hours/月、平均 30 視聴者、録画 30日 | $1,000+ |

計算式:

- delivered minutes = live hours x 60 x average viewers
- Cloudflare Stream delivery = delivered minutes / 1,000 x $1
- stored minutes = live hours x 60 x archive retention months
- Cloudflare Stream storage = stored minutes / 1,000 x $5

## MVP の実装方針

1. まず OBS 配信だけを正式対応にする。ブラウザ配信は後回し。
2. 720p / 10-15fps / 0.8-1.5Mbps の推奨設定を配信画面に明記する。
3. 配信者ごとに stream key を発行し、漏洩時に即ローテーションできるようにする。
4. アーカイブはデフォルト 7-30 日保持。長期保存は配信者が明示的に選ぶ。
5. コメントは動画配信基盤と分け、Durable Objects で room ごとに管理する。
6. 視聴者数、配信開始/終了、エラー、アーカイブ生成状態を webhook で D1 に反映する。
7. 配信一覧は「現在配信中」「最近のアーカイブ」「フォロー中」を中心にする。
8. 通報、BAN、NGワード、モデレーター権限を MVP に含める。配信サイトでは荒らし対応が重要。
9. 月額上限を決め、Stream delivered minutes が閾値を超えたら新規配信開始を制限する emergency mode を用意する。

## 推奨順位

1. Cloudflare Stream + Workers/D1/R2/Durable Objects
2. YouTube Live / Twitch 埋め込み + 自サイト
3. Mux
4. VPS + RTMP/HLS + CDN
5. AWS IVS
6. Livepeer Studio
7. Bunny Stream / Bunny CDN

本番で独自サイト体験を持つなら Cloudflare Stream が最も扱いやすい。最初の需要検証だけなら YouTube/Twitch 埋め込みが安い。コスト重視で技術運用を受け入れられるなら VPS + HLS + CDN が次点。Mux は小規模 free delivery に収まる場合の強い対抗候補。

## 支援金で賄う場合の損益分岐

個人運営の小規模お絵描き配信サイトを支援金で運営する場合、動画配信費に加えて、ドメイン、メール通知、監視、バックアップ、決済手数料、スパイク予備費を入れる必要がある。ここでは人件費、開発端末、外注、法務/会計顧問、広告費は含めない。

### 必要最低限の月額コスト

| 運営形態 | 配信基盤 | サーバー/配信費 | 最低限の周辺費 | 予備費 | 支援目標 |
| --- | --- | ---: | ---: | ---: | ---: |
| 外部埋め込み | YouTube Live / Twitch + 自サイト | 800-1,600 円 | 1,000-2,000 円 | 1,000 円 | 3,000-5,000 円 |
| 独自配信・録画なし | Cloudflare Stream アーカイブなし | 3,700-4,500 円 | 1,500-3,000 円 | 1,000-2,500 円 | 8,000-10,000 円 |
| 独自配信・録画30日 | Cloudflare Stream + 30日アーカイブ | 8,600-9,400 円 | 1,500-3,000 円 | 3,000-7,000 円 | 15,000-20,000 円 |
| スパイク込み安定 | Cloudflare Stream + 30日アーカイブ | 8,600-9,400 円 | 2,000-4,000 円 | 10,000-15,000 円 | 25,000-30,000 円 |
| 自前低コスト | VPS + RTMP/HLS + CDN | 2,400-6,500 円 | 2,000-4,000 円 | 2,000-5,000 円 | 8,000-15,000 円 |

周辺費の内訳:

- ドメイン: 150-300 円/月
- メール送信/通知: 0-1,000 円/月
- 監視/ログ/エラー通知: 0-1,000 円/月
- バックアップ/予備ストレージ: 0-1,000 円/月
- 決済・会計まわりの雑費: 0-500 円/月
- スパイク予備費: 人気配信者の単発配信、保存増、検証用リソース

結論:

- 最初の需要検証を YouTube/Twitch 埋め込みで行うなら、月 3,000-5,000 円で赤字回避しやすい。
- 独自配信だがアーカイブを持たないなら、月 8,000-10,000 円が現実的な最低ライン。
- Cloudflare Stream で 30 日アーカイブまで持つなら、月 15,000-20,000 円を最低目標にする。
- 同時視聴 200 人級の単発スパイクを許容するなら、月 25,000-30,000 円あると運用しやすい。

### FANBOX 300 円プランの場合

FANBOX の手数料は、全年齢設定なら支援額の 10%、R-18 コンテンツ設定なら 12.9%。銀行振込は、3 万円未満の振込で 200 円、3 万円以上で 300 円の振込手数料がかかる。PayPal 受け取りなら FANBOX 側の振込手数料はない。

300 円プランの手取り目安:

- 全年齢設定: 300 円 - 10% = 270 円/人
- R-18 設定: 300 円 - 12.9% = 約 262 円/人

PayPal 受け取りまたは振込手数料を無視した場合:

| 支援目標 | 想定する運営ライン | 全年齢設定 | R-18 設定 |
| ---: | --- | ---: | ---: |
| 5,000 円 | 外部埋め込みの現実ライン | 19 人 | 20 人 |
| 10,000 円 | 独自配信・録画なし | 38 人 | 39 人 |
| 15,000 円 | 独自配信・録画30日の下限 | 56 人 | 58 人 |
| 20,000 円 | 独自配信・録画30日の現実ライン | 75 人 | 77 人 |
| 30,000 円 | スパイク込み安定 | 112 人 | 115 人 |

銀行振込手数料まで含める場合:

| 支援目標 | 必要な手取り + 振込手数料 | 全年齢設定 | R-18 設定 |
| ---: | ---: | ---: | ---: |
| 5,000 円 | 5,200 円 | 20 人 | 20 人 |
| 10,000 円 | 10,200 円 | 38 人 | 39 人 |
| 15,000 円 | 15,200 円 | 57 人 | 59 人 |
| 20,000 円 | 20,200 円 | 75 人 | 78 人 |
| 30,000 円 | 30,300 円 | 113 人 | 116 人 |

FANBOX の自動振込は、振込可能額が 5,000 円未満の場合は翌月以降へ繰り越される。したがって、配信サイトでも月次で安定して受け取るなら、300 円プランでは少なくとも 19-20 人を最初の目標にする。独自配信を Cloudflare Stream で持つなら、録画なしで 38-39 人、30 日アーカイブありで 75-78 人が現実的な目標になる。

## 参考ソース

- Cloudflare Stream pricing: https://developers.cloudflare.com/stream/pricing/
- Cloudflare Stream live: https://developers.cloudflare.com/stream/stream-live/start-stream-live/
- AWS IVS pricing: https://aws.amazon.com/ivs/pricing/
- Mux pricing: https://www.mux.com/pricing
- Livepeer Studio pricing: https://livepeer.studio/pricing
- Bunny CDN pricing: https://bunny.net/pricing/cdn/
- Bunny Stream pricing: https://bunny.net/pricing/stream/
- pixivFANBOX handling fees: https://fanbox.pixiv.help/hc/en-us/articles/360003726293-How-much-is-the-handling-fees
- pixivFANBOX payouts: https://fanbox.pixiv.help/hc/en-us/articles/360005114953-How-and-when-can-Creators-receive-their-pledges
