# Phase 1 codec benchmark

日付: 2026-07-27  
状態: 中間結果。codec Gateは未確定。

## 入力

- 1人・約10分のraw stroke fixture
- 833 strokes / 16,311 points
- 実`dt`を50ms / 最大12 pointsでbatching
- 4,112 logical events
- encode/decodeは全eventを1 iterationとし、20 iterationsの平均

machine-readable resultは[`phase1-codec-benchmark-2026-07-27.json`](./phase1-codec-benchmark-2026-07-27.json)を参照する。

## 結果

| codec | 合計 | 平均/event | 最大event | encode | decode |
| --- | ---: | ---: | ---: | ---: | ---: |
| JSON | 646,781 B | 157.29 B | 325 B | 6.32 ms | 5.51 ms |
| MessagePack | 507,808 B | 123.49 B | 318 B | 7.00 ms | 5.49 ms |
| CBOR | 525,587 B | 127.82 B | 320 B | 5.32 ms | 5.99 ms |

binary codecではopcodeを`0-3`へ変換し、論理APIとJSONでは文字列を維持した。MessagePackはこのfixtureでJSONより約21.5%、CBORより約3.4%小さい。数値opcodeは文字列opcodeのMessagePack結果から約9.0%削減した。処理時間は3候補とも4,112 eventsあたり10ms未満だった。

Browser ES2022向け単独bundle:

| codec | minified | gzip |
| --- | ---: | ---: |
| JSON helper | 167 B | 136 B |
| MessagePack | 21,212 B | 5,918 B |
| CBOR | 28,848 B | 10,711 B |

machine-readable bundle resultは[`phase1-codec-bundle-benchmark-2026-07-27.json`](./phase1-codec-bundle-benchmark-2026-07-27.json)を参照する。

## 現時点の判断

- JSONはdebug codecとして維持する。
- wire codecはMessagePackを採用する。
- binary wireだけ数値opcodeを使い、論理eventとJSON debug codecは文字列opcodeを使う。
- CBOR実装はproduction exportから外し、測定CLIのdev dependencyだけに残す。
- 最大eventは全候補で64KiB上限から十分遠いが、validatorで上限を必ず強制する。
