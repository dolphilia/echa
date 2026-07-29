# 0011: 共有境界を含むproduction配備を協調配備にする

更新日: 2026-07-29

状態: 採用

## 背景

Webのroom provisioning payloadからfieldを削除した一方、同じprotocol versionを使う
Realtimeのconsumerはそのfieldを必須としていた。Webだけが先にproductionへ配備され、
Realtime healthは正常でもService Bindingの初期化requestが400となり、新規roomが
`REALTIME_INIT_FAILED`になった。

Worker単体のhealthはbindingの存在や起動状態を確認できるが、Worker間payloadの
意味的互換性までは確認しない。

## 判断

- `packages/protocol`、room provisioning、ticket、WebSocket、snapshot、renderer、
  D1 migration、Worker bindingを変更した場合はWeb単独配備を禁止する。
- 全体配備はD1 → Realtime → Snapshot → Webの順に行う。
- 共有payloadを変更するときは、consumerを旧・新形式の両方に対応させて先に配備し、
  producerを後から切り替えるexpand / contractを基本とする。
- 後方互換にできない変更はprotocol versionを上げ、明示的に拒否・移行できるようにする。
- 各段階でactive versionを記録し、次へ進む前にhealthとbindingを確認する。
- Web配備後はHTTP healthだけで完了とせず、認証済み利用者による実room作成、自動開始、
  入室、描画、chat、復帰を必須smokeとする。
- 新しいprovisioning失敗が1件でも発生した場合は配備を停止し、新しいversionを重ねず
  room作成停止とrollbackを判断する。

## 結果

UIだけの変更はWeb単独で配備できる。一方、共有境界を含む変更は時間がかかっても
配備順と互換期間を明示でき、healthだけでは見逃すWorker間不整合を実利用者経路で
検出できる。

実行手順の正本は
[`../setup/production-deployment.md`](../setup/production-deployment.md)とする。
