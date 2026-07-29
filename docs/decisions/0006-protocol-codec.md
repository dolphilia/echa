# ADR 0006: protocol v1はMessagePackと数値wire opcodeを使う

日付: 2026-07-27  
状態: 採用

## 判断

- WebSocketのbinary wire codecにMessagePackを使う。
- binary wireの`op`は`stroke.begin=0`、`stroke.append=1`、`stroke.end=2`、`stroke.cancel=3`とする。
- TypeScript内の論理eventとJSON debug codecでは文字列opcodeを維持する。
- frame decode後に数値opcodeを論理opcodeへ戻し、共通runtime validatorを必ず通す。
- application frame上限は64KiBを維持し、decode前にbyte数で拒否する。
- CBORはproduction dependencyから外し、再測定可能なdev dependencyとしてだけ残す。

## 理由

10分fixtureの4,112 eventsでは、数値opcode MessagePackが507,808 bytesで最小だった。CBORより約3.4%、JSONより約21.5%小さい。Browser向けgzip bundleもMessagePackが5,918 bytes、CBORが10,711 bytesであり、処理時間はいずれも1 iteration 10ms未満だった。

実測は[`../results/phase1-codec-benchmark.md`](../results/phase1-codec-benchmark.md)を参照する。

## 影響

- codec選択は閉じるが、event field keyの全面数値化は行わない。
- schema evolutionは論理eventのfield名でreviewできる。
- protocol versionを変えずにwire opcode mappingだけを変更してはならない。
- renderer結果はcodec変換の前後で同一fixtureを再生して確認する。
