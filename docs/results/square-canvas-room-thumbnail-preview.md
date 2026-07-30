# 1000 x 1000 canvas / room thumbnail Preview検証

更新日: 2026-07-30

状態: Preview Exit criteria通過

## 配備

| 項目 | 結果 |
| --- | --- |
| Preview D1 | `0018`〜`0020`適用、未適用0 |
| Realtime | `b254ae6e-30e9-45b7-a1d9-a3f4a2ad7f59`、100% |
| Snapshot | `9077fe4c-9fbc-4ba6-ba9e-7e0e22184184`、100% |
| Web | `7e3e3278-bfc7-40e1-8c2f-a6df1e19c754`、100% |
| thumbnail R2 | `koge-room-thumbnails-preview` |

## Snapshot縦切り

限定した`^snapshot-probe-[a-f0-9]{16}$` roomを使い、
Queue → Snapshot Worker → R2 → DO manifest → 公開read endpointを確認した。

| 項目 | 結果 |
| --- | --- |
| canvas generation | 2 |
| snapshot width / height | 1000 / 1000 |
| decoded RGBA | 4,000,000 bytes |
| sample object | 6,181 bytes |
| object hash | manifestと一致 |
| RGBA hash | manifestと一致 |
| snapshot base / ready sequence | 3 / 3 |
| replay tail | 0 events |

50,000-eventのfull snapshotと、各5,001-eventのincremental snapshotを
3ルームで測定した。

| 項目 | full | incremental 1 | incremental 2 |
| --- | ---: | ---: | ---: |
| target `baseRoomSeq` | 50,001 | 55,002 | 60,003 |
| replay events | 50,001 | 5,001 | 5,001 |
| runtime snapshot bytes | 8,576 | 8,581 | 8,584 |
| thumbnail bytes | 11,479 | 12,330 | 12,799 |
| 3ルームのobject hash一致 | 100% | 100% | 100% |
| 3ルームのRGBA hash一致 | 100% | 100% | 100% |

2回目のincremental snapshotの3回は、wall timeが6,570〜7,055ms、
CPU timeが1,949〜2,360msだった。1回目はwall timeが6,091〜7,426ms、
CPU timeが2,041〜2,410msだった。

2026-07-29T18:28:00Z〜18:42:00ZのWorker Analyticsは4 samples /
12 requests、全sample `success`、errors 0だった。最大P999 memoryは
57,551,210 bytes（54.9 MiB、128 MiB制限の42.9%）で、残りは73.1 MiB
（57.1%）。30% headroomの上限93,952,409 bytesを36,401,199 bytes
下回ったため、Preview resource gateをpassとする。

## Thumbnail縦切り

public / activeの一時projectionを使い、通常Snapshotの同じRGBAから生成した。

| 項目 | 結果 |
| --- | --- |
| format | PNG |
| width / height | 512 / 512 |
| sample object | 8,230 bytes |
| D1 projection | `baseRoomSeq` 6 → 9 → 12へ前進 |
| ETag | 200後の条件付きrequestで304 |
| card | natural 512 x 512、rendered 279.5 x 279.5 |
| stale version | 404 |
| unlisted | 404 |

初回検証ではR2 metadataの`public, immutable`が共有CDNへ残り、unlisted変更後も
cache HITになる問題を検出した。R2 PUTからpublic cache metadataを削除し、
endpointへ`CDN-Cache-Control: no-store`を追加した。修正後はCloudflare
`BYPASS`となり、同一version URLがunlisted変更後に404へ変わることを確認した。

旧サムネイル削除は、D1が直前に指したkeyだけでなくroom prefixを列挙し、現在より
古いsequenceをすべて削除する方式へ強化した。Wrangler CLIの`r2 object get`は削除後も
古いbytesを返す場合があったが、実際のWorker bindingからの`list`と`head`では、
各ルームとも最新の`60003.png`だけが存在し、`50001.png`と`55002.png`は存在しなかった。
アプリケーションの実行経路では旧objectが見えないことを確認した。

## 5分初回trigger

次の2条件を各3ルームで確認した。

| 条件 | 結果 |
| --- | --- |
| 開始後5分までに描画あり | 5分時点で各1 job、`baseRoomSeq = 3` |
| 5分時点で未描画 | pollingせず`waiting_for_stroke` |
| 期限後の最初の確定stroke | 各1 job、`baseRoomSeq = 3` |
| 2本目のstroke | job ID不変、重複job 0 |

連続入力が5分境界をまたいだ際、Queue send完了前に複数の判定が走って初回jobが
重複する競合を検出した。Queue awaitより前にDO SQLiteへjob予約を同期記録するよう
修正し、20並列判定でもjob 1件となる自動試験を追加した。

## Cleanup

5分triggerの6ルームは終了後にD1 projection、runtime snapshot、thumbnailがすべて
0となり、cleanup Queue / DLQも0になった。

終了とthumbnail publishが競合した場合、条件付きD1更新が失敗しても同じkeyという
理由だけで暫定objectを残せる競合を検出した。終了済み・非公開・不在を明示的な
非適格状態として暫定objectを削除し、room cleanupではprefix配下の全thumbnailを
削除するよう修正した。

50,000 / 5,000-event測定用の3ルームも最終browser確認後に終了し、各room prefixを
実際のWorker bindingから列挙した。D1 projection、runtime snapshot、thumbnailは
すべて0、cleanup Queue / DLQも0だった。関連room・session・accountが0であることを
確認してから、合成user `snapshot_probe_owner`も削除した。

## Browser表示

PlaywrightのChromium、Firefox、WebKitで同一の自動試験を実施した。

| 項目 | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| card画像 | 512 x 512 | 512 x 512 | 512 x 512 |
| card形状 | 正方形 | 正方形 | 正方形 |
| canvas | 1000 x 1000 | 1000 x 1000 | 1000 x 1000 |
| RGBA hash | Workerと一致 | Workerと一致 | Workerと一致 |
| 500px viewport | 横overflowなし | 横overflowなし | 横overflowなし |
| console / page error | 0 | 0 | 0 |

コールド入室時、初回snapshot適用後にReactがbase canvas DOMを差し替える短い再同期を
検出した。新しいcanvasのref接続時にcanonical sessionの現在画素を即時転写するよう
修正した。差し替え後も2秒以内にWorkerと同じRGBA hashへ復帰することを確認した。
WebKit試験はSafari相当の自動coverageであり、production smokeでは実Safariでも確認する。

## 自動試験

2026-07-30のPreview修正後に次を再実行した。

```text
npm run check
git diff --check
```

Realtime 67、Snapshot 13、Web 69、Protocol 30を含む全試験がpassした。
最終再実行ではRealtime 12 files / 67 testsを含めwarningなしでpassし、process
exit codeも0だった。

追加の完了監査で、次の境界試験も明示的に追加した。

- 960 x 640 / canvas generation 1のsnapshot offer拒否
- thumbnail feature flag停止時のendpoint fail-closed
- 5分前の通常snapshot commitによる初回taskの`satisfied`化
- 期限時点のactive strokeを途中生成せず、`stroke.end`後に1 jobだけ生成

これらを含めた最終の全体試験件数は、Production配備直前に再記録する。

## Exit criteria監査

| Exit criteria | 状態 | 証拠 |
| --- | --- | --- |
| canvas / snapshot / downloadが1000 x 1000 | pass | protocol、renderer、download試験、Preview復元 |
| Browser / Worker RGBA hash 100%一致 | pass | 3 benchmark room × 3 browser engine |
| 描画済みpublic roomにthumbnail生成 | pass | 通常・5分triggerのD1 / R2確認 |
| 未描画時はpollingせず最初のstrokeで1回 | pass | Preview 3件、20並列重複排除試験 |
| 一覧requestでreplay / encodeしない | pass | D1 projection + private R2 readだけの実装 |
| thumbnail失敗時もsnapshotを維持 | pass | committed `.kgs`からのthumbnail-only retry試験 |
| 古いjobでprojectionを巻き戻さない | pass | 条件付きUPDATE、旧object自己修復試験 |
| unlisted / closed / runtime `.kgs`非公開 | pass | 404 / CDN BYPASS / private binding検証 |
| Worker制限へ30%以上の余裕 | pass | P999 54.9 MiB、headroom 57.1%、errors 0 |
| 終了後にsnapshot / thumbnailを残さない | pass | 5分trigger 6件 + 負荷測定3件で残存0 |
| production協調配備 / rollback再現 | **未実施** | Preview gate通過後にrunbook実行 |

## 未完了

- 実Safariによる最終production smoke
- Preview Exit criteria通過後のproduction協調配備
