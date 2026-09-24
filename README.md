# homebridge-tcl-androidtv

TCL の Android TV（65X10 で動作確認済み）を、ネットワーク ADB を使って HomeKit から操作する Homebridge プラグインです。

- 電源オン／オフ（状態は `dumpsys power` で取得）
- 入力の切り替え
  - HDMI 1〜3
  - 放送（地デジ・BS・CS）とワンタッチ選局（1〜12）
  - アプリの起動（YouTube、Netflix など）
  - 任意の adb shell コマンド
- ホームアプリの音量スライダー（音量を直接指定。オフでミュート）
- iOS のコントロールセンターにあるリモコン（十字キー・戻る・再生／一時停止・音量ボタン）
- テレビ側で操作したときも、電源・入力・音量をホームアプリに反映

## 準備

### 1. テレビ側

1. 「設定 → デバイス設定 → 端末情報」を開き、「ビルド」を 7 回押して開発者向けオプションを有効にします。
2. 「設定 → デバイス設定 → 開発者向けオプション」で **USB デバッグ** をオンにします。
3. **ネットワーク自動待機** をオンにします。オフにすると、スタンバイ中にテレビがネットワークから完全に切れ、HomeKit から電源を入れられなくなります（65X10 では Wake-on-LAN でも起動しません）。
4. ルーターの設定で、テレビの IP アドレスを固定しておくことをおすすめします。

### 2. Homebridge ホスト側

`adb` をインストールします。

```bash
# Debian / Ubuntu / Raspberry Pi OS
sudo apt install adb
```

```bash
# macOS
brew install android-platform-tools
```

#### Docker（homebridge/homebridge イメージ）の場合

コンテナを作り直しても `adb` が入るように、`/homebridge/startup.sh` に次の内容を追加して、コンテナを再起動します。

```bash
if ! command -v adb >/dev/null 2>&1; then
  apt-get update && apt-get install -y adb
fi
```

### 3. テレビに接続を許可する

ADB の鍵は、Homebridge のストレージ（`/var/lib/homebridge/.android/` や、Docker の場合は `/homebridge/.android/`）に保存されます。Homebridge を起動すると、テレビに **「USB デバッグを許可しますか？」** と表示されるので、**「このコンピュータを常に許可」** にチェックを入れて **OK** を選んでください。

> ほかの PC でテレビを許可済みなら、その PC の `~/.android/adbkey` と `adbkey.pub` を上記のフォルダにコピーするだけでも使えます。

## インストール

Homebridge Config UI X の「プラグイン」画面で **`homebridge-tcl-androidtv`** を検索して、インストールします。

コマンドで入れる場合は、次のとおりです。

```bash
npm install -g homebridge-tcl-androidtv
```

## 設定例

設定は Config UI X の画面からも行えます。

```json
{
  "platforms": [
    {
      "platform": "TclAndroidTV",
      "devices": [
        {
          "name": "リビングのテレビ",
          "host": "192.168.1.50",
          "inputs": [
            { "name": "HDMI 1", "type": "hdmi", "hdmiPort": 1 },
            { "name": "HDMI 2", "type": "hdmi", "hdmiPort": 2 },
            { "name": "テレビ放送", "type": "tuner" },
            { "name": "NHK総合", "type": "tuner", "band": "terrestrial", "channel": 1 },
            { "name": "BS日テレ", "type": "tuner", "band": "bs", "channel": 4 },
            { "name": "YouTube", "type": "app", "package": "com.google.android.youtube.tv" },
            { "name": "Netflix", "type": "app", "package": "com.netflix.ninja" }
          ]
        }
      ]
    }
  ]
}
```

### テレビごとの設定

| 項目 | 説明 |
|---|---|
| `host` / `port` | テレビの IP アドレスと ADB ポート（既定値: 5555） |
| `macAddress` | 電源オン時に Wake-on-LAN も送ります（任意） |
| `volumeSlider` | 音量スライダーの表示方法。`fan`（扇風機、既定値）/ `lightbulb`（電球）/ `none`（表示しない） |
| `maxVolume` | スライダーで設定できる音量の上限（1〜100、既定値: 100） |
| `pollInterval` | 状態を取得する間隔（秒、既定値: 5） |
| `wakeTimeout` | 電源オン時に、テレビにつながるまで待つ最大時間（秒、既定値: 20） |
| `adbPath` | `adb` がパスの通っていない場所にある場合に指定します |
| `adbHome` | ADB の鍵の保存先（既定値: Homebridge のストレージ） |

### 入力（`inputs`）の設定

入力は、ここに書いた順番でホームアプリに表示されます。

| `type` | 項目 | 説明 |
|---|---|---|
| `hdmi` | `hdmiPort` | HDMI 番号。対応する入力 ID はテレビから自動で取得します |
| `tuner` | `band` | `terrestrial`（地デジ）/ `bs` / `cs`。省略すると、最後に見ていた放送になります |
| | `channel` | リモコンのワンタッチ選局ボタンの番号（1〜12）。`band` と一緒に指定します |
| `app` | `package` | 起動するアプリのパッケージ名 |
| `command` | `command` | 任意の `adb shell` コマンド |

音量スライダーを **扇風機** として表示しているのは、電球にすると「電気を全部消して」でテレビがミュートされてしまうためです。扇風機の風量が音量、オン／オフがミュートの解除／ミュートに対応します。

### 入力 ID やアプリ名の調べ方

```bash
npx -p homebridge-tcl-androidtv tcl-androidtv-tools 192.168.1.50 inputs   # 入力の一覧（HDMI 番号付き）
npx -p homebridge-tcl-androidtv tcl-androidtv-tools 192.168.1.50 apps     # インストール済みアプリの一覧
npx -p homebridge-tcl-androidtv tcl-androidtv-tools 192.168.1.50 focus    # いま前面にあるアプリ
```

## ホームアプリへの追加

テレビのアクセサリは HomeKit の仕様上、**External Accessory** として公開されます。ブリッジとは別に、次の手順で追加してください。

1. ホームアプリで「＋ → アクセサリを追加 → その他のオプション」を開きます。
2. 表示されたテレビを選び、Homebridge の PIN を入力します。

## 制限事項

- 放送は、どのチャンネルを見ているかまでは検出できません（直前に選んだ放送の入力が表示されます）。
- チャンネルは、ワンタッチ選局ボタン（1〜12）でのみ選べます。3 桁のチャンネル番号の直接入力には対応していません。
- 65X10 では HDMI 4 がテレビ側に入力として登録されておらず、切り替えられません。
- 電源をオフにした直後の約 10 秒は、テレビがネットワークから切れます。その間に電源オンを指示した場合は、つながるまで最大 `wakeTimeout` 秒再試行します。

## ライセンス

MIT
