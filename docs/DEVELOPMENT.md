# 開発と確認の手順

BetterDuet を開発し、実際の DUET で確かめるための手順をまとめます。人が手で行う手順と、AI エージェントが人の手を借りずに行う手順の両方を書いています。開発の進め方（仕様から始める）は [CONTRIBUTING.md](../CONTRIBUTING.md) と [仕様書](spec/README.md) を参照してください。

最終更新: 2026-10-19

## 現在の状態

- v0.1.0：仕様の全要件を実装済み。CORE-005（最新のタブでのダウンロード）は 2026-10-19 に実機で確認し、Implemented にした
- 2026-10-17 に v0.1.0 を GitHub Releases で公開した
- 確かめきれていないことは [product.md](spec/product.md) の「確かめきれていないこと」にある

## 自動テスト

```bash
node --test tests/*.test.js
for f in extension/*.js extension/content/*.js; do node --check "$f"; done
```

| テスト | 対象 |
|---|---|
| `tests/core.test.js` | `core.js` の純粋な関数（送信の判定、履歴、着地先、ログアウトの判定など） |
| `tests/early-hook.test.js` | `early-hook.js` を `node:vm` で動かし、送信の横取り、書き換え、タイムアウト、ログアウトの待ち合わせ、`popstate` を確かめる |
| `tests/rules.test.js` | `rules.json` の遮断と例外の範囲 |
| `tests/manifest.test.js` | 権限、ホスト権限、参照しているファイルの存在 |

Service Worker（`background.js`）は `chrome.*` に依存するため、自動テストがありません。変えたときは、偽の `chrome` オブジェクトを使った使い捨ての検証スクリプトをリポジトリの外で書いて動かすか、実機で確かめてください。

## 実機での確認（人が行う場合）

1. `chrome://extensions/` でデベロッパー モードをオンにし、「パッケージ化されていない拡張機能を読み込む」で `extension` フォルダを選ぶ
2. SSO ポータルから DUET を開く
3. コードを変えたら、`chrome://extensions/` で BetterDuet の再読み込みボタンを押す。開いている DUET のタブには古いスクリプトが残るので、SSO ポータルから開き直す

確認の観点は、各仕様の「受け入れ条件」と「確認の記録」の表です。次の順で行うと、セッションを壊す操作を最後に回せます。

GUARD-001 → CORE-001/003 → TAB-001 → TAB-002 → TAB-003 → TAB-004 → BACK-001〜004 → GUARD-002 → GUARD-003 → NOTICE-001/002 → CORE-006 と TAB-005（ログアウト。最後に行う）

> [!WARNING]
> 登録やアンケートの送信など、DUET 側のデータを変える操作はしないでください。最新のタブでダウンロードのボタンを押すと、実際にファイルが保存されます。

## 実機での確認（AI エージェントが行う場合）

2026-10-17 の実装では、Claude Code が人の手を借りずに実機確認まで行いました。そのときの手順と、はまった点です。

### 道具

| 道具 | 使いどころ |
|---|---|
| Claude in Chrome（`mcp__claude-in-chrome__*`） | 利用者の Chrome（DUET にログインしているプロフィール）でタブを開き、ページの中で JavaScript を実行する。DUET の確認の大半はこれで行う |
| `tools/chrome-ext.ps1` | `chrome://extensions` の操作（読み込み、再読み込み、オン・オフ、状態の表示）。Claude in Chrome は `chrome://` のページに触れないため、Windows の UI Automation で操作する |
| PowerShell からの本物の入力 | Chrome の「戻る」ボタン、Alt+←、確認ダイアログの OK は、本物のマウスやキーの入力でないと動かない。`SetCursorPos`／`mouse_event`／`keybd_event` を使う |
| `experiments/probe` | DUET の通信を記録する検証用の拡張機能。新しい挙動を調べるときに一時的にオンにする（ふだんはオフ） |

```powershell
pwsh tools/chrome-ext.ps1 -Action status -Name BetterDuet
pwsh tools/chrome-ext.ps1 -Action reload -Name BetterDuet
pwsh tools/chrome-ext.ps1 -Action load -Path C:\Users\<user>\dev\BetterDuet\extension
pwsh tools/chrome-ext.ps1 -Action disable -Name "BetterDuet Probe"
```

### はまった点

- **Chrome のプロフィールを間違えない**：DUET にログインしているのは「Univ」と名付けたプロフィール。Claude in Chrome に複数の Chrome がつながっているときは、利用者に選んでもらう
- **タブグループのタブを閉じない**：Claude in Chrome のタブグループは、タブを閉じたり利用者がタブを出し入れしたりすると外れることがある。外れたら新しいグループを作り、必要なタブを移してもらうか、新しく開く
- **`chrome://extensions` のウィンドウを前面に出す**：裏に隠れている間は、UI Automation でボタンを押しても何も起きず、状態も古いまま読める。`tools/chrome-ext.ps1` は最初に前面に出す
- **フォルダ選択のダイアログを開いたままにしない**：「読み込む」のダイアログが残ると、管理画面全体が止まり、オン・オフも効かなくなる。ボタンは名前（「フォルダーの選択」）とクラス（`Button`）で探す。ID の `1` だけで探すと、一覧の項目を押してしまう
- **画面の拡大率は 200%**：PowerShell からマウスを動かすときは `SetProcessDpiAwarenessContext(-4)` を先に呼び、物理ピクセルで指定する
- **`chrome://extensions` は画面キャプチャで真っ黒に写ることがある**：状態は `tools/chrome-ext.ps1 -Action status` で読む
- **Claude in Chrome から送るキー入力では、Chrome の「戻る」は動かない**：Alt+← は `keybd_event` で送る。対象のタブを前面にするには、UI Automation でタブを選び、ページの `document.visibilityState` が `visible` になったことを確かめる
- **DUET の確認ダイアログ（`confirm`）**：Claude in Chrome の JavaScript 実行を止めてしまう。ボタンには `focus()` だけをして、本物の Enter で押す
- **個人情報を出力に出さない**：DUET の画面には氏名、学生番号、成績、科目名がある。ページの文字を取得するときは、画面名（パンくず）やエラーの有無など、必要な項目に絞る。ツールが「Cookie/query string data」として出力を止めることがあるので、そのときは値ではなくハッシュや長さだけを出す
- **前面化のために Alt を押すと、ページが「操作済み」になる**：`SetForegroundWindow` を通すために Alt を1回押す手がよく使われるが、Chrome がすでに前面にあると、そのキーがページに届いて `navigator.userActivation.hasBeenActive` が true になる。ページを操作していない状態を確かめる実験（E-031）では、Chrome が前面にないときだけ Alt を押す
- **ダウンロードのあとは別のウィンドウが前面に出ることがある**：2026-10-19 の確認では、ダウンロードのたびに Explorer の「Downloads」が前面に出て、本物のキー入力がそちらに送られた。キーを送る直前に `GetForegroundWindow` で Chrome が前面かを確かめる
- **DUET はボタンの上の Enter を自分で処理する**：LOGOUT ボタンに `focus()` して Enter を送っても押されない。ボタンは本物のマウスで押し、確認ダイアログの OK だけを Enter で押す
- **どのタブが前面かは `visibilityState` では分からない**：Claude in Chrome のタブグループのタブは、裏にあっても `visible` を返すことがある。`requestAnimationFrame` の1秒あたりの回数（前面は約60、裏は約30）で見分ける。UI Automation でタブを選ぶときは、Claude in Chrome がタブを作った直後だと、そのタブがまだ選ばれていないことがある
- **「デバッグを開始しました」の帯が消えると、ページの位置がずれる**：画面の座標でクリックするときは、直前に撮った画面で位置を確かめる
- **セッションを壊す実験は、拡張機能を使わずに行える**：`fetch` で DUET のページを GET すると、セッションが壊れる（遮断ルールは `main_frame` しか対象にしないため）

### DUET の見た目を測り直す

NOTICE-002 の表の値は、Claude in Chrome で DUET の画面を開き、`getComputedStyle` で次の要素を測ったものです。

- ホームの `#contents div.block`、その `h3`、`div.content`、`ul.data li`、`ul.data li a`
- 授業評価アンケートの `p.message`（説明文の枠）と `input[type=button]`（検索ボタン）
- 入力欄の `span.required`（「必須」バッジ。画像 `required_icon.png`）

## 新しい挙動を調べるとき

1. `experiments/probe` を一時的にオンにする（`tools/chrome-ext.ps1 -Action enable -Name "BetterDuet Probe"`）。BetterDuet と同時に動かすと `addEventListener` の差し替えがぶつかるため、調べる内容によっては BetterDuet をオフにする
2. 調べた結果は、[duet-platform.md](spec/duet-platform.md) の観察ログに `E-NNN` として、日付、手順、結果を書く。本文も更新する
3. 終わったらプローブをオフに戻す
