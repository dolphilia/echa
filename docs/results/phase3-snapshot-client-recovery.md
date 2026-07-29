# Phase 3 Stage D: Snapshot client recovery

日付: 2026-07-27  
状態: shadow modeのsnapshot + tail + live recovery成立  
Cloudflare Workers plan: Paid

## 実装した復元経路

1. WebSocket接続時にclientがrenderer version、last applied roomSeq、snapshot利用可否を送る。
2. room Durable Objectが互換性のあるcurrent manifestを選ぶ。
3. Durable Objectが60秒・1回限りの256-bit read tokenを発行し、SHA-256だけをSQLiteへ保存する。
4. serverはR2 keyを除いたpublic manifestとread tokenをWebSocketで送る。
5. Browserはrealtime Worker endpointへ`Authorization: KogeSnapshot {token}`で取得する。
6. realtime Workerがtokenを原子的に消費し、private R2 objectをstreamする。
7. Browserはcontent length、object SHA-256、KGS1 header、codec / renderer / canvas version、RGBA SHA-256を検証する。
8. 検証済みRGBAをBrowser WASM renderer sessionへ読み込む。
9. serverが`baseRoomSeq`より後のtailを送り、その後のlive eventも同じ直列処理queueで適用する。
10. snapshot取得・検証・decode・適用のどこかが失敗した場合、白紙状態へ戻し、snapshotを無効化して`lastRoomSeq = 0`から自動再接続する。

R2 object keyはWebSocket message、URL、client manifestのいずれにも含めない。read tokenはURL queryへ入れずAuthorization headerだけで渡し、再利用は拒否する。

## 検証

`npm run check`:

- lint: pass
- typecheck: pass
- Realtime Worker: 10 tests pass
- Snapshot Worker: 2 tests pass
- Protocol: 13 tests pass
- Renderer: 2 tests pass
- event-log benchmark tools: 8 tests pass
- renderer fixture tools: 1 test pass

統合テストでは次を確認した。

- snapshot offerがR2 keyを含まない
- offerがtail / readyより先に送られる
- snapshot read tokenは64桁hexで、保存時はhash化される
- private R2 objectが`Cache-Control: private, no-store`でstreamされる
- tokenの初回利用は200、2回目は403
- Browser WASM sessionへRGBAを読み込み、そのpixel列を維持できる
- shared codecがencode / decodeでlossless round-tripする

## Cloudflare preview

- Realtime Worker version: `9b5ad6d2-1961-4ea7-868d-f1ce9117e186`
- Snapshot Worker version: `e31b1ed5-55a4-44c1-b461-4416a57ae0e6`
- Web Worker version: `93b178d1-ecf1-48f9-a2cf-98965d840b1e`

既存probe roomのcurrent snapshot:

- room: `snapshot-probe-202607270002abcd`
- job: `2be779c1-a4cf-4276-ab2e-75782929fbf6`
- base roomSeq: 0
- object: 2,428 bytes

preview BrowserからWebSocket接続し、CORS preflight、1回限りtoken付きGET、R2 object 2,428 bytesの200 response、`ready roomSeq = 0`までを確認した。Nodeによる独立probeでもsnapshot offerとobject取得を確認した。

## 既知の残作業

- 今回のpreview実画面は空canvas snapshotで経路を確認した。次はdrawing eventを含むsnapshotについて、full replayとのRGBA hash一致を測る。
- tailが存在するsnapshot、recovery中にlive eventが到着するケース、破損object / version不一致 / R2失敗を自動E2E化する。
- previous snapshot fallbackとcompactionは未実装。
- Web deploy直後にvinextのHTMLが直前のversioned asset参照を返す時間帯が観測された。今回必要なsnapshot client codeは直前versionにも含まれていたため検証を妨げなかったが、Phase 7までにcache invalidation / deployment verification手順を固定する。

## 判断

Stage Dのshadow recoveryは成立した。snapshot採用Gate Bはまだ通過扱いにしない。次はStage Eとして、10k / 50k / 100k eventのfull replay比較、非空snapshot hash一致、障害注入、previous fallback、compaction安全性を測定する。
