# 描画入力仕様

更新日: 2026-08-02

## モバイル入力

- 「指で描く」は初期状態で有効とする。
- 有効時の1本指は選択中のツール、2本指はpan / zoom / rotationに使う。
- 無効時の1本指は何もしない。2本指gestureとペン入力は利用できる。
- 2本指gestureを開始した場合、進行中のstrokeまたはスポイト操作をcancelする。

## スポイト

- 選択直後からドーナツ型previewを表示する。
- 初期位置は同じclientで最後に描画したcanvas座標とし、まだ描画していない場合は
  canvas中央を使う。画面外へはみ出す場合はworkspace内へ寄せる。
- mouse / pen / touchのpointer downでは色を確定せず、previewを表示してpointerを
  captureする。
- pointer move中は取得候補の色と拡大表示を更新する。
- pointer up時の位置から色を取得し、直前のブラシまたは消しゴムへ戻る。
- pointer cancelでは色を変更しない。

## カラーダイアログ

- Safariを含め、ダイアログ内のラベル、現在色、picker、tab、buttonを文字選択や
  touch calloutの対象にしない。
- HEX入力だけは文字編集と選択を許可する。
