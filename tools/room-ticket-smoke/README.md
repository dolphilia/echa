# Room ticket smoke

previewまたはproduction相当環境で、公開roomのguest viewerについて次を確認する。

1. ticket発行APIがopaque tokenを返す。
2. WebSocket upgradeが`101`で成功する。
3. 同じtokenの再利用が`401`で拒否される。

```bash
npm run smoke:room-ticket -- \
  --app-origin https://preview.koge.app \
  --realtime-origin https://realtime-preview.koge.app \
  --room <32-character-public-slug>
```

生ticket、cookie、内部guest IDは標準出力へ出さない。
