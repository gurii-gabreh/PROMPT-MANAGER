# PROMPT MANAGER ローカル生成サーバー

Claude Proプランの `claude` CLIを使って、プロンプト生成を自動化するためのローカルサーバーです。
Googleスプレッドシートへの読み書きは行いません（それは今まで通り `index.html` → GAS が担当します）。
このサーバーの役割は「テキストを受け取り、`claude -p` で生成し、結果を返す」だけです。

## 事前準備

- Node.js がインストールされていること（`node -v` で確認）
- `claude` コマンドがPATH上で使えること、Claude Proアカウントでログイン済みであること
  （画像→文字列取得の処理で既に使っているものと同じログイン状態でOK）

## 起動方法

以下のどちらかで起動してください。

```bash
cd local-server
node server.js
```

またはFinderで `start-server.command` をダブルクリック。

起動すると `http://localhost:5678` で待ち受けます。**このターミナル（またはウィンドウ）は開いたままにしてください。**
GitHub Pagesの `index.html` はこのURLに直接リクエストを送ります。

## 停止方法

- アプリ側で生成完了後に出る「ターミナルを停止しますか？」でOKを押すと自動的に終了します。
- 手動で止めたい場合はターミナルで `Ctrl + C`。

## エンドポイント

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/health` | 起動確認（index.htmlが生成前に自動でチェックします） |
| POST | `/generate` | `{targetAI, requirement, candidates}` を受け取り、生成結果を返す |
| POST | `/shutdown` | サーバーを終了する |

## ポート変更

デフォルトは `5678` です。変更したい場合：

```bash
PORT=6000 node server.js
```

その場合、index.htmlの設定（⚙️）にある「ローカル生成サーバー URL」も `http://localhost:6000` に合わせて変更してください。
