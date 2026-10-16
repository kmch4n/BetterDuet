# リリース手順

メンテナー向けの手順です。配布は [GitHub Releases](https://github.com/kmch4n/BetterDuet/releases) だけで行います。

## 1. バージョンを上げる

バージョンは `MAJOR.MINOR.PATCH` で表します。

| 上げる桁 | 目安 |
|---|---|
| MINOR | 新機能の追加、目立つ見た目の変更 |
| PATCH | 不具合の修正、小さな改善 |

`extension/manifest.json` の `version` を書き換えます。

リリースに含める要件が、[仕様書](spec/README.md)ですべて `Implemented` になっていることを確かめます。`Accepted` のまま残っている要件があれば、実装が終わっていないか、状態の更新を忘れています。

テストを実行して、すべて通ることを確かめます。

```bash
node --test tests/*.test.js
```

## 2. コミットしてタグを付ける

```bash
git commit -am "[🔖] Release vX.Y.Z"
git tag vX.Y.Z
git push origin main vX.Y.Z
```

## 3. 配布用の zip を作る

`extension` フォルダの**中身**を、フォルダごとではなく直下に入れて zip にします。`_metadata` は Chrome が自動で作るフォルダなので含めません。

```bash
cd extension
zip -r ../BetterDuet_vX.Y.Z.zip . -x "_metadata/*"
```

PowerShell 7 の場合:

```powershell
Get-ChildItem extension -Exclude _metadata | Compress-Archive -DestinationPath BetterDuet_vX.Y.Z.zip
```

> [!WARNING]
> Windows PowerShell 5.1 の `Compress-Archive` は、zip 内のパスの区切りに `\` を使うことがあり、展開する環境によってはフォルダの構造が崩れます。PowerShell 7 か `zip` コマンドを使ってください。

作った zip を展開し、`chrome://extensions/` から読み込んで動くことを確かめます。

## 4. リリースを作る

下の書式でリリースノートを `notes.md` に書き、リリースを作ります。

```bash
gh release create vX.Y.Z BetterDuet_vX.Y.Z.zip --title vX.Y.Z --notes-file notes.md
```

## リリースノートの書式

- タイトルはバージョン名だけにする（例: `v1.8.3`）
- 本文はすべて日本語で書き、絵文字は使わない
- 利用者から見た変化だけを書く。実装の説明、コミットの一覧、インストール手順は書かない
- 見出しは次の3つから、当てはまるものだけを使う
  - `## 新機能`: できるようになったこと
  - `## 改善`: 見た目や使い勝手の変更、仕様の変更
  - `## 不具合の修正`: 直した問題
- 1項目を1行で、「〜しました」で終える

例:

```markdown
## 新機能
- 教材の動画を常にミュートで再生する設定を追加しました

## 改善
- コースページの目次が、読んでいる回に合わせて自動で開くようになりました

## 不具合の修正
- 問題をコピーしたときに、問題文の1行目しかコピーされない問題を修正しました
```
