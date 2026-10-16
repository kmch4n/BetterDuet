# 実験用のコード

DUET の挙動を確かめるためのコードです。配布する拡張機能（`extension/`）とは別物で、仕様の対象でもありません。ここで確かめた結果は [docs/spec/duet-platform.md](../docs/spec/duet-platform.md) の観察ログに記録します。

## probe

DUET とのやり取りを記録し、送信を止める実験ができる検証用の拡張機能です。

- 記録するのは、リクエストの種類、メソッド、URL のパスだけです。クエリ、送信内容、Cookie の値は記録しません
- DUET のページのスクリプトから `postMessage` で操作できます。タブの再読み込みや複製もできてしまうため、検証のときだけ読み込み、終わったら削除してください

読み込み方:

1. `chrome://extensions/` でデベロッパー モードをオンにする
2. 「パッケージ化されていない拡張機能を読み込む」から `experiments/probe` フォルダを選ぶ

ページからの呼び出し方:

```js
const probe = (cmd, args) =>
    new Promise((resolve) => {
        const id = Math.random();
        addEventListener("message", function handler(e) {
            if (e.data?.__probe === "res" && e.data.id === id) {
                removeEventListener("message", handler);
                resolve(e.data.res);
            }
        });
        postMessage({ __probe: "req", id, cmd, args }, "*");
    });

await probe("getLog");
```

コマンドの一覧は `probe/background.js` の `handlers` を参照してください。
