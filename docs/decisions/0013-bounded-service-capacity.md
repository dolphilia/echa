# 0013: 管理可能なサービス利用上限と公開範囲ポリシーを設ける

更新日: 2026-07-30

状態: 採用、local実装済み、preview検証前

## 背景

運用状況に応じて、サイト全体の同時開催room数と、新しく作成するroomの
participant / viewer数を管理画面から絞りたい。これは負荷試験で確定した安全上限を
引き上げる機能ではなく、コード側のhard limit内で運用上限を下げる機能である。

従来はD1へparticipant 20、viewer 100を固定保存していた一方、Realtimeの総接続
hard limitは20だった。表示上のrole limitと実際の接続上限が一致していなかった。

## 判断

- 初期のサイト同時開催上限を20 roomとする。
- 新規roomの初期値をparticipant 10、viewer 10とする。
- participantは1〜20、viewerは0〜19で設定できる。
- participantとviewerの設定値の合計は常に20以下とする。
- 20を超える設定は管理UI、Web API、D1 CHECK、protocol validationの各境界で拒否する。
- 20接続を超える拡張は今回行わず、将来のRealtime負荷試験と別decisionを必須とする。
- 設定変更は新規roomにだけ適用し、既存roomの利用者を退出させない。
- room作成時の設定値をD1 projectionとroom Durable Objectへ固定保存する。
- サイト同時開催数はD1の条件付きINSERT内で数え、同時requestでも上限を超えない。
- role別入室数はroom Durable Objectを正とし、D1の人数projectionだけで許可しない。
- participant枠にはowner用の1席を予約し、owner自身も接続後はparticipant数へ含める。
- 再接続は同一actorの既存接続を置き換え、追加の席を消費しない。
- 既存のparticipant 20 / viewer 100 roomは終了まで再接続・再初期化可能な互換経路を
  維持するが、総接続hard limit 20は引き続き適用する。
- 管理変更はCloudflare Access認証、idempotency key、変更理由、監査actionを必須とする。
- 管理者は新規roomを公開roomだけに制限できる。初期値では制限しない。
- 公開room限定時は新規room画面から公開範囲の選択と招待リンク限定の説明を外し、
  client送信値も`public`へ固定する。
- UIを迂回した`unlisted`作成は、room INSERTと同じD1条件内で拒否する。
- 公開room限定への変更は既存roomへ遡及せず、既存のunlisted roomと同一作成requestの
  provisioning再試行を維持する。

## 結果

管理者は安全上限を上書きせず、運用上必要な範囲へ同時開催数とroom別人数を縮小できる。
理論上の最大同時入室数は
`live_room_limit × (participant_limit + viewer_limit)`として確認できる。

サイト全体でrole別の実接続合計を別途制限する仕組みは採用しない。必要になった場合は、
全roomを束ねる予約・lease調整の負荷と障害境界を別途検討する。
