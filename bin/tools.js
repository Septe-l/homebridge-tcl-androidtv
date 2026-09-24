#!/usr/bin/env node
'use strict';

// 設定用ヘルパー: テレビの状態・入力ID・アプリ一覧を表示する
// 使い方: tcl-androidtv-tools <host> [inputs|apps|power|focus]

const { AdbClient } = require('../src/adb');
const {
  parsePowerState,
  parseFocusedPackage,
  parseTvInputIds,
  parseHdmiInputIds,
  parseCurrentTvInputId,
} = require('../src/tv');

async function main() {
  const [host, cmd = 'inputs'] = process.argv.slice(2);
  if (!host) {
    console.error('usage: tcl-androidtv-tools <host[:port]> [inputs|apps|power|focus]');
    process.exit(1);
  }
  const [h, port] = host.split(':');
  const adb = new AdbClient({ host: h, port: port || 5555, timeout: 10000 });
  console.log(await adb.connect());

  switch (cmd) {
    case 'inputs': {
      const dump = await adb.shell('dumpsys tv_input');
      const hdmi = parseHdmiInputIds(dump);
      const portOf = new Map([...hdmi].map(([port, id]) => [id, port]));
      const current = parseCurrentTvInputId(dump);
      console.log('TV input IDs (config の tvInputId に指定できます):');
      parseTvInputIds(dump).forEach((id) => {
        const port = portOf.has(id) ? `HDMI ${portOf.get(id)}` : '';
        console.log(`  ${port.padEnd(7)} ${id}${id === current ? '  <- 視聴中' : ''}`);
      });
      break;
    }
    case 'apps': {
      const out = await adb.shell('pm list packages');
      out.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean).sort()
        .forEach((p) => console.log(`  ${p}`));
      break;
    }
    case 'power':
      console.log(parsePowerState(await adb.shell('dumpsys power')) ? 'ON' : 'OFF');
      break;
    case 'focus':
      console.log(parseFocusedPackage(await adb.shell('dumpsys window windows')));
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
