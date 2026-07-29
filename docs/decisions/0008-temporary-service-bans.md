# 0008: service BANは一時・subject単位・管理者解除可能にする

- 状態: 採用
- 決定日: 2026-07-29

## 決定

MVPのservice-level BANは永久BANにせず、24時間、7日、30日の3段階とする。
既定は7日。Cloudflare Accessで認証された管理者だけが、接続中roomのmemberを
起点に理由付きで適用・解除できる。

対象identityはBetter Auth user IDまたはguest session IDとする。IPアドレス、
User-Agent、生email、Accessの生`sub`はBAN identityや監査記録へ保存しない。

適用時は次を行う。

1. 専用`service_bans`行と`moderation_actions`をD1へ保存する。
2. 同一subjectの新規room作成と全roomのticket発行を拒否する。
3. D1上の稼働中membershipを最大25 roomまで解決し、DOのticket、未確定stroke、
   WebSocket connectionを失効する。
4. 解除は別の一意なaction ID、管理者内部ID、理由、時刻を同じ行へ記録する。

BANとservice BANのmoderation actionは、有効期間終了後も180日保持し、
scheduled maintenanceで削除する。管理画面では有効なBANと直近30日の解除記録を
表示する。

## 理由

- 永久BANより誤操作やidentity再利用の影響を限定できる。
- userとguestで同じ入場fenceを使え、connection IDの変更では回避できない。
- IPを長期identityにしないため、プライバシーと誤BANの範囲を抑えられる。
- Access保護、理由、冪等性、解除履歴により少人数運用でも追跡できる。

## 制約

- guestはcookie削除で新しいguest sessionを取得できるため、service BANだけを
  bot対策に使わない。rate limit、room BAN、通報、必要時のemergency controlを
  組み合わせる。
- 1回の管理操作で即時切断する既存membershipは25 roomまで。新規ticketは件数に
  関係なく拒否する。
- 公開前に、利用者が到達できる異議申立て窓口と運用担当者を確定し、
  プライバシー告知へ180日の監査保持を記載する。
