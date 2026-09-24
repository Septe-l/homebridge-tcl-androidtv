'use strict';

const dgram = require('dgram');

// KEYCODE_TV_INPUT_HDMI_1 = 243 ... HDMI_4 = 246
const HDMI_KEYCODE_BASE = 243;

// TCL 独自の放送切替キー。adb の input keyevent では効かないため、
// リモコン押下時と同じく TV アプリへ livetv:// URI で渡す
const BAND_KEYCODES = { terrestrial: 4123, bs: 4124, cs: 4125 };

/** ワンタッチ選局ボタン (1〜12) のキーコード */
function channelKeycode(n) {
  const num = Number(n);
  if (num >= 1 && num <= 9) {
    return `KEYCODE_${num}`;
  }
  if (num === 10) {
    return 'KEYCODE_0';
  }
  if (num === 11 || num === 12) {
    return `KEYCODE_${num}`;
  }
  throw new Error(`channel は 1〜12 で指定してください: ${n}`);
}

/** `dumpsys power` の出力から画面が点いているか判定する */
function parsePowerState(dumpsys) {
  const wake = /mWakefulness=(\w+)/.exec(dumpsys);
  if (wake) {
    // Dreaming はスクリーンセーバー表示中 (画面は点いている)
    return wake[1] === 'Awake' || wake[1] === 'Dreaming';
  }
  const display = /Display Power: state=(\w+)/.exec(dumpsys);
  if (display) {
    return display[1] === 'ON';
  }
  return null;
}

/** `dumpsys window` の出力から前面アプリのパッケージ名を取り出す */
function parseFocusedPackage(dumpsys) {
  const lines = dumpsys.split('\n').filter((l) => /mCurrentFocus|mFocusedApp/.test(l));
  for (const line of lines) {
    const m = /\s([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\/[^\s}]+/.exec(line);
    if (m) {
      return m[1];
    }
  }
  return null;
}

/** TvInputInfo の input ID から passthrough チャンネル URI を作る (TvContract.buildChannelUriForPassthroughInput 相当) */
function passthroughUri(inputId) {
  return `content://android.media.tv/passthrough/${encodeURIComponent(inputId)}`;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** 入力設定から実行する adb shell コマンドを組み立てる */
function buildInputCommand(input) {
  switch (input.type) {
    case 'hdmi':
      if (input.tvInputId) {
        return `am start -a android.intent.action.VIEW -d ${shellQuote(passthroughUri(input.tvInputId))}`;
      }
      return `input keyevent ${HDMI_KEYCODE_BASE + (Number(input.hdmiPort) || 1) - 1}`;
    case 'tuner': {
      if (input.band) {
        const code = BAND_KEYCODES[input.band];
        if (!code) {
          throw new Error(`Unknown band: ${input.band}`);
        }
        let cmd = `am start -a android.intent.action.VIEW -d 'livetv://tvactivity?KeyEvent=${code}' -n com.tcl.tv/.TVActivity`;
        if (input.channel) {
          const delay = Number(input.channelDelay ?? 2);
          cmd += ` && sleep ${delay} && input keyevent ${channelKeycode(input.channel)}`;
        }
        return cmd;
      }
      if (input.tvInputId) {
        return `am start -a android.intent.action.VIEW -d ${shellQuote(passthroughUri(input.tvInputId))}`;
      }
      return 'input keyevent KEYCODE_TV';
    }
    case 'app':
      if (input.activity) {
        return `am start -n ${shellQuote(`${input.package}/${input.activity}`)}`;
      }
      return `monkey -p ${shellQuote(input.package)} -c android.intent.category.LAUNCHER 1`;
    case 'command':
      return input.command;
    default:
      throw new Error(`Unknown input type: ${input.type}`);
  }
}

/** dumpsys tv_input から input ID 一覧を取り出す */
function parseTvInputIds(dumpsys) {
  const ids = new Set();
  const re = /TvInputInfo\{id=([^,}\s]+)/g;
  let m;
  while ((m = re.exec(dumpsys))) {
    ids.add(m[1]);
  }
  return [...ids];
}

/**
 * dumpsys tv_input から HDMI 番号 → input ID の対応を作る。
 * TvInputHardwareInfo の id と hdmi_port、input ID 末尾の "/HW<id>" を突き合わせる。
 */
function parseHdmiInputIds(dumpsys) {
  const hwToPort = new Map();
  const hwRe = /TvInputHardwareInfo \{id=(\d+)[^}]*?hdmi_port=(\d+)/g;
  let m;
  while ((m = hwRe.exec(dumpsys))) {
    hwToPort.set(m[1], Number(m[2]));
  }
  const result = new Map();
  for (const id of parseTvInputIds(dumpsys)) {
    const hw = /\/HW(\d+)$/.exec(id);
    if (hw && hwToPort.has(hw[1])) {
      result.set(hwToPort.get(hw[1]), id);
    }
  }
  return result;
}

/** dumpsys tv_input からチューナー (TvInputHardwareInfo type=2) の input ID を取り出す */
function parseTunerInputId(dumpsys) {
  const tunerHw = new Set();
  const hwRe = /TvInputHardwareInfo \{id=(\d+), type=2\b/g;
  let m;
  while ((m = hwRe.exec(dumpsys))) {
    tunerHw.add(m[1]);
  }
  return parseTvInputIds(dumpsys).find((id) => {
    const hw = /\/HW(\d+)$/.exec(id);
    return hw && tunerHw.has(hw[1]);
  }) || null;
}

/** dumpsys audio から STREAM_MUSIC の現在の出力先の音量とミュート状態を取り出す */
function parseMusicVolume(dumpsys) {
  const block = /- STREAM_MUSIC:\n([\s\S]*?)(?:\n- STREAM_|$)/.exec(dumpsys);
  if (!block) {
    return null;
  }
  const muted = /Muted: (true|false)/.exec(block[1]);
  const devices = /Devices: (\S+)/.exec(block[1]);
  const current = /Current: (.*)/.exec(block[1]);
  const max = /Max: (\d+)/.exec(block[1]);
  if (!devices || !current) {
    return null;
  }
  const re = new RegExp(`\\((${devices[1].replace(/[^\w]/g, '\\$&')})\\): (\\d+)`);
  const vol = re.exec(current[1]);
  if (!vol) {
    return null;
  }
  return {
    volume: Number(vol[2]),
    max: max ? Number(max[1]) : 100,
    muted: muted ? muted[1] === 'true' : false,
  };
}

/**
 * Television の DisplayOrder (TLV8) を作る。
 * ホームアプリは入力をこの順で表示する (指定しないと順不同になる)。
 */
function displayOrderTlv(identifiers) {
  const bytes = [];
  identifiers.forEach((id, i) => {
    if (i > 0) {
      bytes.push(0x00, 0x00);
    }
    bytes.push(0x01, 0x04, id & 0xff, (id >> 8) & 0xff, (id >> 16) & 0xff, (id >> 24) & 0xff);
  });
  return Buffer.from(bytes).toString('base64');
}

/** dumpsys tv_input から現在視聴中のセッションの input ID を取り出す (なければ null) */
function parseCurrentTvInputId(dumpsys) {
  const main = /mainSessionToken: (\S+)/.exec(dumpsys);
  if (!main || main[1] === 'null') {
    return null;
  }
  const block = dumpsys.split(/\n(?=\s+android\.os\.Binder@)/).find((b) => b.includes(`sessionToken: ${main[1]}`));
  const m = /inputId: (\S+)/.exec(block || '');
  return m ? m[1] : null;
}

function sendWakeOnLan(mac, broadcast = '255.255.255.255') {
  return new Promise((resolve, reject) => {
    const hex = mac.replace(/[^0-9a-fA-F]/g, '');
    if (hex.length !== 12) {
      reject(new Error(`Invalid MAC address: ${mac}`));
      return;
    }
    const macBuf = Buffer.from(hex, 'hex');
    const packet = Buffer.alloc(6 + 16 * 6, 0xff);
    for (let i = 0; i < 16; i++) {
      macBuf.copy(packet, 6 + i * 6);
    }
    const socket = dgram.createSocket('udp4');
    socket.once('error', (e) => {
      socket.close();
      reject(e);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, 9, broadcast, (e) => {
        socket.close();
        e ? reject(e) : resolve();
      });
    });
  });
}

module.exports = {
  parsePowerState,
  parseFocusedPackage,
  passthroughUri,
  buildInputCommand,
  parseTvInputIds,
  parseHdmiInputIds,
  parseCurrentTvInputId,
  parseTunerInputId,
  parseMusicVolume,
  displayOrderTlv,
  channelKeycode,
  sendWakeOnLan,
};
