'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  parsePowerState,
  parseFocusedPackage,
  buildInputCommand,
  parseTvInputIds,
} = require('../src/tv');

test('parsePowerState', () => {
  assert.strictEqual(parsePowerState('  mWakefulness=Awake\n'), true);
  assert.strictEqual(parsePowerState('  mWakefulness=Asleep\n'), false);
  assert.strictEqual(parsePowerState('  mWakefulness=Dozing\n'), false);
  assert.strictEqual(parsePowerState('  mWakefulness=Dreaming\n'), true);
  assert.strictEqual(parsePowerState('Display Power: state=ON'), true);
  assert.strictEqual(parsePowerState('nothing'), null);
});

test('parseFocusedPackage', () => {
  const out = [
    '  mCurrentFocus=Window{a1b2c3 u0 com.google.android.youtube.tv/com.google.android.apps.youtube.tv.activity.ShellActivity}',
    '  mFocusedApp=AppWindowToken{...}',
  ].join('\n');
  assert.strictEqual(parseFocusedPackage(out), 'com.google.android.youtube.tv');
  assert.strictEqual(parseFocusedPackage('mCurrentFocus=null'), null);
});

test('buildInputCommand', () => {
  assert.strictEqual(buildInputCommand({ type: 'hdmi', hdmiPort: 1 }), 'input keyevent 243');
  assert.strictEqual(buildInputCommand({ type: 'hdmi', hdmiPort: 4 }), 'input keyevent 246');
  assert.strictEqual(
    buildInputCommand({ type: 'hdmi', tvInputId: 'com.tcl.tvinput/.TvPassThroughService/HW15' }),
    "am start -a android.intent.action.VIEW -d 'content://android.media.tv/passthrough/com.tcl.tvinput%2F.TvPassThroughService%2FHW15'",
  );
  assert.strictEqual(
    buildInputCommand({ type: 'app', package: 'com.netflix.ninja' }),
    "monkey -p 'com.netflix.ninja' -c android.intent.category.LAUNCHER 1",
  );
  assert.strictEqual(buildInputCommand({ type: 'command', command: 'echo hi' }), 'echo hi');
});

test('parseTvInputIds', () => {
  const out = 'TvInputInfo{id=com.tcl.tvinput/.TvPassThroughService/HW15, pkg=com.tcl.tvinput}\n' +
    'TvInputInfo{id=com.tcl.tvinput/.TvPassThroughService/HW16, pkg=com.tcl.tvinput}';
  assert.deepStrictEqual(parseTvInputIds(out), [
    'com.tcl.tvinput/.TvPassThroughService/HW15',
    'com.tcl.tvinput/.TvPassThroughService/HW16',
  ]);
});

test('buildInputCommand tuner', () => {
  const { buildInputCommand: b } = require('../src/tv');
  assert.strictEqual(
    b({ type: 'tuner', band: 'bs' }),
    "am start -a android.intent.action.VIEW -d 'livetv://tvactivity?KeyEvent=4124' -n com.tcl.tv/.TVActivity",
  );
  assert.strictEqual(
    b({ type: 'tuner', band: 'terrestrial', channel: 4 }),
    "am start -a android.intent.action.VIEW -d 'livetv://tvactivity?KeyEvent=4123' -n com.tcl.tv/.TVActivity && sleep 2 && input keyevent KEYCODE_4",
  );
  assert.match(b({ type: 'tuner', band: 'cs', channel: 12 }), /KeyEvent=4125.*KEYCODE_12$/);
  assert.match(b({ type: 'tuner', band: 'bs', channel: 10 }), /KEYCODE_0$/);
  assert.throws(() => b({ type: 'tuner', band: 'bs', channel: 13 }));
  assert.match(b({ type: 'tuner', tvInputId: 'com.tcl.tvinput/.TDTVInputService/HW1' }), /passthrough\/com\.tcl\.tvinput%2F/);
});

test('parseTunerInputId / parseHdmiInputIds', () => {
  const { parseTunerInputId, parseHdmiInputIds } = require('../src/tv');
  const dump = [
    'TvInputInfo{id=com.tcl.tvinput/.TDTVInputService/HW100, pkg=com.tcl.tvinput}',
    'TvInputInfo{id=com.tcl.tvpassthrough/.TvPassThroughService/HW200, pkg=com.tcl.tvpassthrough}',
    'TvInputHardwareInfo {id=100, type=2, audio_type=1, audio_addr=1, cable_connection_status=0}',
    'TvInputHardwareInfo {id=200, type=9, audio_type=1, audio_addr=1, hdmi_port=2, cable_connection_status=0}',
  ].join('\n');
  assert.strictEqual(parseTunerInputId(dump), 'com.tcl.tvinput/.TDTVInputService/HW100');
  assert.deepStrictEqual([...parseHdmiInputIds(dump)], [[2, 'com.tcl.tvpassthrough/.TvPassThroughService/HW200']]);
});

test('parseMusicVolume', () => {
  const { parseMusicVolume } = require('../src/tv');
  const dump = [
    '- STREAM_MUSIC:',
    '   Muted: true',
    '   Min: 0',
    '   Max: 100',
    '   Current: 2 (speaker): 12, 40000 (hmdi_arc): 100, 40000000 (default): 25',
    '   Devices: speaker',
    '- STREAM_ALARM:',
    '   Current: 2 (speaker): 5',
  ].join('\n');
  assert.deepStrictEqual(parseMusicVolume(dump), { volume: 12, max: 100, muted: true });
});

test('displayOrderTlv', () => {
  const { displayOrderTlv } = require('../src/tv');
  assert.deepStrictEqual(
    [...Buffer.from(displayOrderTlv([1, 2]), 'base64')],
    [1, 4, 1, 0, 0, 0, 0, 0, 1, 4, 2, 0, 0, 0],
  );
});
