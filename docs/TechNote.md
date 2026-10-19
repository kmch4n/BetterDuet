# BetterDuet 技術ノート

BetterDuet の実装が、どのファイルで、どういう仕組みで動いているかをまとめた文書です。何をすべきかは [仕様書](spec/README.md) が決め、DUET 側の挙動は [duet-platform.md](spec/duet-platform.md) に記録しています。この文書はその間をつなぐ、実装の地図です。

最終更新: 2026-10-19

## 先に知っておくこと

DUET のサーバーは、セッションごとに「現在の画面」を1つだけ持っています。これに合わない要求を1回でも受けると、セッションを丸ごと捨てます。合わない要求とは、画面の URL への GET と、古い画面のフォームからの POST です（E-002、E-003）。BetterDuet の仕組みはすべて、この制約を利用者から隠すためにあります。

- **最新の画面を1か所で覚える**：Service Worker が、最後に正常に表示された画面と、その画面のフォームの形（送信先と hidden 項目）を持つ
- **送信を1本の列に並べる**：DUET への POST は、Service Worker が1つずつ順番に送る
- **GET を DUET に届けない**：`declarativeNetRequest` で、画面としての GET を着地ページに付け替える
- **壊れても入り直す**：入場ページを `fetch` で取り直して、新しいセッションを作る

## ファイルの役割

| ファイル | 動く場所 | 役割 |
|---|---|---|
| `extension/manifest.json` | — | 権限（`storage`、`declarativeNetRequest`、DUET のホストだけ）、スクリプトの注入順 |
| `extension/rules.json` | Chrome | GET の遮断（ID 1、redirect）と、SSO の往復用の例外（ID 2、allow、`urlFilter`） |
| `extension/core.js` | どこでも | 純粋な関数と定数。画面 ID の表、お知らせの文言、送信の判定、「戻る」の履歴の計算など。Node のテストからも読み込む |
| `extension/background.js` | Service Worker | 最新の画面の記録、送信の列（ジョブ）、各メッセージの処理 |
| `extension/content/early-hook.js` | ページ（MAIN world、`document_start`） | DUET のスクリプトより先に動き、`form.submit()`、`popstate`、Alt+←、ログアウトの XHR を横取りする |
| `extension/content/page.js` | DUET の画面（ISOLATED） | 画面の読み込みを Service Worker に知らせる。横取りした送信を Service Worker に回して結果を early-hook に返す。タブの記録、「戻る」、お知らせ帯の表示 |
| `extension/content/nav.js` | DUET の画面と着地ページ | Service Worker とのやり取り（keepalive 付き）、計画どおりのフォーム送信、入り直しの手順 |
| `extension/content/landing.js` | 着地ページ | 付け替えられたタブで、開き直す画面を決めて開く |
| `extension/content/links.js` | DUET の画面 | `openUrl` で外部の URL を開くリンクを、新しいタブで開く普通のリンクに書き換える（LINK-001/002）。DUET には何も送らない |
| `extension/content/notice.js` | DUET の画面と着地ページ | お知らせ帯の描画 |
| `extension/content/tokens.css`、`notice.css` | DUET の画面と着地ページ | DUET に合わせたデザイントークンと、帯・着地ページの見た目 |

メッセージの形式（Service Worker との要求と返答、MAIN と ISOLATED の間のメッセージ）は [docs/plan/implementation-plan.md](plan/implementation-plan.md) の §6.3 と §7.1 に表でまとめています。コードを変えるときは、その表も合わせて直してください。

## 主な流れ

### 普通の送信（CORE-003、CORE-004）

1. DUET のスクリプトが `form.submit()` を呼ぶ。early-hook がこれを止め、`__link_clicked__` の値とリンクの `onclick` をその場で控える（DUET は送信の直後にこれらを消すため）
2. page.js が、この画面の世代番号（`pageGen`）と、フォーム ID、アクション名だけを Service Worker に送る。`form1` の入力値は送らない
3. Service Worker が順番待ちのあと判定する：最新の画面なら「そのまま送る」、古い画面の共通フォームなら「最新の形に書き換えて送る」、古い画面の `form1` なら「止める」
4. early-hook が判定どおりに本物の送信をする。止めたときは、DUET が無効にしたリンクと二重送信防止のフラグ（`mMOnceTimeFlg`）を元に戻す
5. 次の画面が読み込まれると、page.js が `page:loaded` を送り、Service Worker が最新の画面を更新して、列の次の送信に進む

ダウンロードは画面が移らないため、送ってから3秒で終わったものとみなします（CORE-005）。

### GET の遮断と着地ページ（GUARD-001、GUARD-002）

`/gakusei/html/` への画面としての GET は、Chrome の中で `/betterduet-landing?from=<元のパス>` に付け替えられます。DUET にはそのパスがないので 404 が返るだけで、セッションは無事です。landing.js が 404 の中身を隠し、次の順で開く画面を決めます。

1. `from` が入場ページなら、SSO ポータルからの入場として扱い、ホーム（セッションがなければ「お知らせ」）を開く
2. タブの `sessionStorage` に記録があれば、その画面の戻り先のメニュー画面を開く。再読み込み、Chrome によるタブの破棄、タブの複製では、この記録が引き継がれる
3. どちらもなければホームを開く

### 入り直し（GUARD-003、GUARD-004）

DUET のセッションが壊れていても、DUET 側の SSO（Shibboleth）のログインが生きていれば、入場ページ `FB01090G.html` を `fetch` で GET し、`form1:goHome` を POST するだけで、新しいセッションができます（E-010）。拡張機能の知らないところでセッションが生きていた場合は、最初の GET でエラーになるので、もう一度だけ取り直します（E-006）。

DUET のログアウトは、Shibboleth のログインまで終わらせることがあります（E-027）。この場合、入場ページの GET は大学の SSO への他サイトのリダイレクトになり、`fetch` では追えません。そこで、SSO ポータルからの入場に限り、`FB01090G.html?betterduet=sso` に本物の画面遷移をして、DUET に SSO を往復させます。この URL だけは `rules.json` の例外で遮断しません。

### 「戻る」（BACK-001〜004）

early-hook が、DUET の `popstate` の監視を登録させません。「戻る」が押されると、自分の `popstate` の処理で `pushState` し直してから、page.js に知らせます。page.js はタブの履歴（`sessionStorage`）から1つ前のメニュー画面を決め、その画面を開く送信を Service Worker に頼みます。Alt+← は、DUET の keydown の処理に届く前に止め、Chrome 自身の「戻る」として働かせます。

### ログアウト（CORE-006、TAB-005）

DUET のログアウトは、フォーム送信ではなく jQuery の Ajax で `unloadform:closeWindow` を送り、応答のあとすぐタブを閉じます。early-hook はこの XHR を見つけると、Service Worker が「ログアウトした」と記録し終えるまで（最大 0.5 秒）送信を待たせます。待たせないと、通知が届く前にタブが閉じて、ほかのタブが勝手に入り直してしまいます（実機で確認した不具合）。

## 状態の置き場所

| 情報 | 場所 | 中身 |
|---|---|---|
| 最新の画面、世代番号、ログアウト中か、実行中のジョブ | `chrome.storage.session`（キー `betterduet:state`） | フォームの型にはトークンが入るため、ディスクやページから読める場所には置かない |
| タブごとの画面と履歴 | DUET のオリジンの `sessionStorage`（キー `betterduet:tab`） | 画面 ID、タブ ID、履歴だけ |
| 一時的な目印 | 同じく `sessionStorage` | `betterduet:pendingBack`、`betterduet:notice`、`betterduet:revived`、`betterduet:ssoTried` |

Service Worker のキューそのものはメモリにあり、途中で Service Worker が止まると消えます。そのため、実行中のジョブには期限を付けて `storage.session` に残し、起動時に期限切れなら捨てます。待っている側のコンテンツスクリプトは、10秒ごとに port で ping して Service Worker を起こしておきます。

## デザイン（NOTICE-002）

見た目は DUET に合わせます。DUET の実際のスタイルを測った値を `content/tokens.css` に `--bd-*` のトークンとして置き、`notice.css` はトークンだけを使います。BetterE-class の `bec-tokens.css` と同じ方式です。DUET のクラス名は使わず、`bd-` で始まる独自のクラスで同じ見た目を作ります。

DUET の見た目が変わったら、[仕様書の NOTICE-002 の表](spec/architecture.md) にある要素を測り直し、トークンを更新してください。測り方は [DEVELOPMENT.md](DEVELOPMENT.md) にあります。

## つまずきやすい点

- **アドレスバーの URL は画面を表さない**：DUET の URL は、直前に POST した先のパスです。画面の判定には、必ずフォームの `action` の末尾（画面 ID）を使ってください
- **`form.submit()` は送信イベントを出さない**：DUET はほとんどの送信を `form.submit()` で行うため、`submit` イベントの監視だけでは横取りできません。early-hook がプロトタイプを差し替えているのはこのためです
- **送信の直後に DUET が後始末をする**：`__link_clicked__` を空にし、すべてのリンクの `onclick` を `return false` に書き換えます。横取りした送信を止めるときは、これを元に戻す必要があります
- **拡張機能を更新すると、開いているタブのフックだけが残る**：page.js は動かなくなります。early-hook は1.5秒以内に返事がなければフックを外して DUET 本来の送信に任せます（P-5）
- **`openerTabId` は複製元を指さない**（E-023）：複製元の判定は `sessionStorage` の引き継ぎで行います（E-024）
- **`declarativeNetRequest` の例外ルールは `urlFilter` で書いている**：初めは正規表現（`\?` を含む `regexFilter`）の版で拡張機能が有効にならなかった。2026-10-19 に同じ正規表現（`^https://duet\.doshisha\.ac\.jp/gakusei/html/fb/fb010/FB01090G\.html\?betterduet=sso$`）に書き換えて読み込み直すと、エラーなく有効になった。当時の原因は、同じ時期に `chrome://extensions` でフォルダ選択のダイアログが開いたままになっていたことだと考えられる。正規表現の版で例外が実際に効くかまでは試していないので、実機で確かめた `urlFilter` の版のままにしている
- **ISOLATED world から `onclick` 属性を外しても、ページの処理は残る**：DUET が `onclick` 属性で付けた処理は、拡張機能の側で `removeAttribute("onclick")` しても、ページの側の `a.onclick` に残って動いた。links.js は、書き換えたリンクのクリックを `window` の捕捉フェーズで `stopPropagation()` して、DUET の処理まで届かないようにしている
- **DUET の確認ダイアログ（`confirm`）**：ログアウトなどで出ます。自動操作の道具を止めてしまうので、確認するときは本物のキー入力で OK を押します
