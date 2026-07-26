# Event log measurement tools

お絵描きルームの event log 上限を実測で決めるための、外部依存を持たない測定ツールです。

現時点では次の範囲を測定できます。

- モックアップ上の実操作から raw stroke fixture を記録
- raw stroke を `stroke.begin` / `stroke.append` / `stroke.end` へ変換
- 接続内の`clientSeq`とserver側の`roomSeq`を付与
- 指定event数または推定wire byte数までevent logを増幅
- JSON byte数とMessagePack相当の推定byte数を集計
- ブラウザのCanvas 2Dでevent logをcold replay
- replay時間、最初の描画までの時間、最大処理slice、Long Taskを記録

Durable Object、SQLite、WebSocket転送はまだ実装していないため、このツールだけではサーバーCPU時間や実ネットワーク転送時間は測れません。

## 必要環境

- Node.js 20以降
- Canvas 2DとES Modulesに対応したブラウザ

npm packageのインストールは不要です。

## 1. 実操作を記録する

リポジトリルートからサーバーを起動します。

```sh
npm --prefix tools/event-log-benchmark run serve
```

次のURLを開きます。

```text
http://127.0.0.1:4173/prototypes/v2/drawing-room/?measure=1
```

右下に表示される「描画測定レコーダー」で次の操作を行います。

1. 「記録開始」を押す
2. ブラシ、低濃度ブラシ、消しゴム、単点、高速線などを描く
3. 「記録停止」を押す
4. 「書き出す」からJSONを保存する

通常のモックアップ表示ではレコーダーUIは表示されません。`?measure=1` を付けた場合だけ表示されます。

raw fixtureは、Pointer Eventそのものではなく、キャンバス論理座標へ変換したstrokeと相対時刻を保存します。

## 2. Event logを生成する

### 記録したfixtureを1回だけ解析する

実際に記録した1分間を繰り返さず、そのままeventへ変換して集計します。

```sh
npm --prefix tools/event-log-benchmark run analyze-raw -- \
  /absolute/path/to/echa-raw-strokes.json
```

バッチ条件を変更した比較もできます。

```sh
npm --prefix tools/event-log-benchmark run analyze-raw -- \
  /absolute/path/to/echa-raw-strokes.json \
  --append-interval-ms 33 \
  --max-points-per-append 20
```

単回変換したevent logも保存する場合:

```sh
npm --prefix tools/event-log-benchmark run analyze-raw -- \
  /absolute/path/to/echa-raw-strokes.json \
  --output-event-log tmp/recorded-single-pass.json
```

この解析では次を出力します。

- 記録全体とアクティブ描画の時間・比率
- begin / append / end / cancel数
- 正確なevent数
- 平均points/stroke、平均・最大points/append
- 記録時間あたりとアクティブ描画時間あたりのevent・point数
- JSON容量とMessagePack相当の推定容量

`npm --prefix`で実行したときの相対パスは
`tools/event-log-benchmark/` を基準に解決されます。ダウンロードしたfixtureには絶対パスを指定するのが確実です。

以下のevent log増幅は、単回解析とは別の負荷試験用です。

サンプルfixtureから10,000 event以上を生成します。

```sh
npm --prefix tools/event-log-benchmark run generate -- \
  --output tmp/event-log-10000.json \
  --target-events 10000
```

記録したfixtureを使う場合:

```sh
npm --prefix tools/event-log-benchmark run generate -- \
  --input /path/to/echa-raw-strokes.json \
  --output tmp/recorded-event-log.json \
  --target-events 50000 \
  --actors 5
```

推定MessagePack容量も条件にできます。

```sh
npm --prefix tools/event-log-benchmark run generate -- \
  --output tmp/event-log-4mib.json \
  --target-events 1000 \
  --target-bytes 4MiB
```

生成はstrokeの途中で止めないため、指定event数を少し超えることがあります。

## 3. Event logを集計する

```sh
npm --prefix tools/event-log-benchmark run summarize -- \
  tmp/event-log-10000.json
```

主な出力:

- `eventCount`
- `strokeCount`
- `actorCount`
- `pointCount`
- `eventsByType`
- `jsonBytes`
- `estimatedMessagePackBytes`
- `largestEstimatedEventBytes`
- `averageEstimatedEventBytes`

`estimatedMessagePackBytes` は、現在のevent schemaを標準的なMessagePack最小表現で符号化した場合の見積もりです。wire library採用後は、実際のencoderが返すbyte数へ置き換えます。

## 4. ブラウザでcold replayを測る

サーバー起動後、次を開きます。

```text
http://127.0.0.1:4173/tools/event-log-benchmark/web/
```

測定条件:

- Event数
- actor数
- Yield budget
- raw fixture JSON

最初は次の順に測定します。

1. 1,000 events
2. 10,000 events
3. 50,000 events
4. 100,000 events

測定結果はJSONとして書き出せます。

URLパラメータによる自動実行も可能です。

```text
http://127.0.0.1:4173/tools/event-log-benchmark/web/?events=10000&actors=3&yield=8&autorun=1
```

ブラウザコンソールから直近結果を確認できます。

```js
window.__lastBenchmarkResult
```

## 指標の意味

| 指標 | 意味 |
| --- | --- |
| `replayDurationMs` | 全eventの適用にかかった時間 |
| `firstDrawingMs` | 再生開始から最初の確定strokeが見えるまで |
| `maxSliceMs` | ブラウザへ制御を返す間に連続実行した最大時間 |
| `longTaskCount` | Long Tasks APIが検出した50ms以上の処理 |
| `longestLongTaskMs` | 最長Long Task |
| `processedPoints` | Canvas再生で処理したpoint数 |
| `unfinishedStrokes` | ログ末尾に未完了strokeが残っていないか |

## 比較時の注意

- 同じブラウザ、端末、電源設定で3回以上測り、中央値と最大値を比較する
- DevToolsを開いた状態と閉じた状態を混在させない
- バックグラウンドタブでは測らない
- fixture、event数、actor数、yield budgetを結果と一緒に保存する
- JSON byte数を本番wire byte数として扱わない

## テスト

```sh
npm --prefix tools/event-log-benchmark test
```

## 次に追加する測定

実サービスの同期基盤を作る段階で、同じevent schemaとfixtureを使って次を追加します。

- Durable Objects SQLiteへのbulk seedと読み出し
- WebSocketのchunk転送
- 複数クライアントの同時復帰
- 復帰中のlive stroke遅延
- WebSocket切断後のresume
- D1/DOのCPU時間、wall time、保存量
