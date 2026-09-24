'use strict';

const { AdbClient } = require('./adb');
const {
  parsePowerState,
  parseFocusedPackage,
  buildInputCommand,
  parseHdmiInputIds,
  parseCurrentTvInputId,
  parseTunerInputId,
  parseMusicVolume,
  displayOrderTlv,
  sendWakeOnLan,
} = require('./tv');

const PLUGIN_NAME = 'homebridge-tcl-androidtv';
const PLATFORM_NAME = 'TclAndroidTV';

const DEFAULT_INPUTS = [
  { name: 'HDMI 1', type: 'hdmi', hdmiPort: 1 },
  { name: 'HDMI 2', type: 'hdmi', hdmiPort: 2 },
  { name: 'HDMI 3', type: 'hdmi', hdmiPort: 3 },
  { name: 'HDMI 4', type: 'hdmi', hdmiPort: 4 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setConfiguredName(service, Characteristic, name) {
  // iOS 16 以降は ConfiguredName がないとサービス名が表示されないことがある
  if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
    service.addOptionalCharacteristic(Characteristic.ConfiguredName);
  }
  service.setCharacteristic(Characteristic.ConfiguredName, name);
}

class TclAndroidTvPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    this.api.on('didFinishLaunching', () => {
      for (const device of this.config.devices || []) {
        if (!device.host) {
          this.log.error('devices[].host が設定されていません。スキップします。');
          continue;
        }
        try {
          new TelevisionAccessory(this, device);
        } catch (e) {
          this.log.error(`${device.name || device.host} の初期化に失敗しました: ${e.message}`);
        }
      }
    });
  }

  // テレビはExternal Accessoryとして公開するためキャッシュは使わない
  configureAccessory() {}
}

class TelevisionAccessory {
  constructor(platform, device) {
    this.platform = platform;
    this.log = platform.log;
    this.api = platform.api;
    this.device = device;

    const { Service, Characteristic, Categories, uuid } = this.api.hap;
    this.Characteristic = Characteristic;

    this.name = device.name || 'TCL TV';
    this.inputs = (device.inputs && device.inputs.length ? device.inputs : DEFAULT_INPUTS).map(
      (input, i) => ({ ...input, identifier: i + 1 }),
    );
    this.pollInterval = Math.max(2, Number(device.pollInterval) || 5) * 1000;

    this.adb = new AdbClient({
      host: device.host,
      port: device.port || 5555,
      adbPath: device.adbPath || 'adb',
      timeout: (Number(device.timeout) || 5) * 1000,
      // ADB の鍵を Homebridge のストレージ (<storage>/.android/adbkey) に保存する
      home: device.adbHome || this.api.user.storagePath(),
      log: this.log,
    });

    this.state = {
      active: false,
      activeIdentifier: this.inputs[0]?.identifier ?? 1,
      volume: 0,
      muted: false,
    };
    this.busyUntil = 0;

    const accessory = new this.api.platformAccessory(
      this.name,
      uuid.generate(`${PLUGIN_NAME}:${device.host}`),
      Categories.TELEVISION,
    );
    this.accessory = accessory;

    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'TCL')
      .setCharacteristic(Characteristic.Model, device.model || '65X10')
      .setCharacteristic(Characteristic.SerialNumber, device.host);

    // --- Television ---
    const tv = accessory.addService(Service.Television, this.name);
    this.tvService = tv;
    tv.setCharacteristic(Characteristic.ConfiguredName, this.name);
    tv.setCharacteristic(
      Characteristic.SleepDiscoveryMode,
      Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE,
    );

    tv.getCharacteristic(Characteristic.Active)
      .onGet(() => (this.state.active ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE))
      .onSet((value) => this.setPower(value === Characteristic.Active.ACTIVE));

    tv.getCharacteristic(Characteristic.ActiveIdentifier)
      .onGet(() => this.state.activeIdentifier)
      .onSet((value) => this.setInput(value));

    tv.getCharacteristic(Characteristic.RemoteKey).onSet((value) => this.sendRemoteKey(value));

    tv.getCharacteristic(Characteristic.PowerModeSelection).onSet(() =>
      this.run(() => this.adb.keyevent('KEYCODE_SETTINGS')),
    );

    // --- Input sources ---
    for (const input of this.inputs) {
      const src = accessory.addService(
        Service.InputSource,
        input.name,
        `input-${input.identifier}`,
      );
      src
        .setCharacteristic(Characteristic.Identifier, input.identifier)
        .setCharacteristic(Characteristic.ConfiguredName, input.name)
        .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
        .setCharacteristic(Characteristic.InputSourceType, this.inputSourceType(input))
        .setCharacteristic(
          Characteristic.CurrentVisibilityState,
          Characteristic.CurrentVisibilityState.SHOWN,
        );
      tv.addLinkedService(src);
    }
    // ホームアプリでの入力の並び順を設定順に固定する
    tv.setCharacteristic(
      Characteristic.DisplayOrder,
      displayOrderTlv(this.inputs.map((i) => i.identifier)),
    );

    // --- Speaker (iOSリモートの音量ボタン用) ---
    const speaker = accessory.addService(Service.TelevisionSpeaker);
    speaker
      .setCharacteristic(Characteristic.Mute, false)
      .setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.RELATIVE);
    speaker.getCharacteristic(Characteristic.Mute)
      .onGet(() => this.state.muted)
      .onSet((value) => this.setMute(value));
    speaker.getCharacteristic(Characteristic.VolumeSelector).onSet((value) =>
      this.run(() =>
        this.adb.keyevent(
          value === Characteristic.VolumeSelector.INCREMENT ? 'KEYCODE_VOLUME_UP' : 'KEYCODE_VOLUME_DOWN',
        ),
      ),
    );
    tv.addLinkedService(speaker);
    this.speakerService = speaker;

    this.setupVolumeSlider(accessory);

    this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
    this.log.info(`${this.name} (${device.host}) を公開しました。ホームアプリで「アクセサリを追加」から個別にペアリングしてください。`);

    this.startPolling();
  }

  /**
   * ホームアプリに音量スライダーを出す (TelevisionSpeaker はホームアプリに表示されないため)。
   * 既定は扇風機 (回転速度=音量、オフ=ミュート)。電球だと「電気を全部消して」でミュートされてしまう。
   */
  setupVolumeSlider(accessory) {
    const { Service, Characteristic } = this.api.hap;
    const kind = this.device.volumeSlider || 'fan';
    if (kind === 'none') {
      return;
    }
    this.maxVolume = Math.min(100, Math.max(1, Number(this.device.maxVolume) || 100));
    const name = `${this.name} 音量`;

    if (kind === 'lightbulb') {
      const svc = accessory.addService(Service.Lightbulb, name, 'volume');
      svc.getCharacteristic(Characteristic.On)
        .onGet(() => this.volumeOn())
        .onSet((v) => this.setMute(!v));
      svc.getCharacteristic(Characteristic.Brightness)
        .onGet(() => this.state.volume)
        .onSet((v) => this.setVolume(v));
      this.volumeService = svc;
      this.volumeOnChar = Characteristic.On;
      this.volumeLevelChar = Characteristic.Brightness;
    } else {
      const svc = accessory.addService(Service.Fanv2, name, 'volume');
      svc.getCharacteristic(Characteristic.Active)
        .onGet(() => (this.volumeOn() ? 1 : 0))
        .onSet((v) => this.setMute(v !== 1));
      svc.getCharacteristic(Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        .onGet(() => this.state.volume)
        .onSet((v) => this.setVolume(v));
      this.volumeService = svc;
      this.volumeOnChar = Characteristic.Active;
      this.volumeLevelChar = Characteristic.RotationSpeed;
    }
    setConfiguredName(this.volumeService, Characteristic, name);
  }

  volumeOn() {
    return this.state.active && !this.state.muted;
  }

  async setVolume(value) {
    const volume = Math.min(this.maxVolume ?? 100, Math.max(0, Math.round(value)));
    this.log.info(`${this.name}: 音量を ${volume} に設定`);
    this.state.volume = volume;
    await this.run(async () => {
      if (this.state.muted) {
        await this.adb.keyevent('KEYCODE_VOLUME_MUTE');
        this.state.muted = false;
      }
      await this.adb.shell(`media volume --stream 3 --set ${volume}`);
    });
    if (volume !== value) {
      // 上限で丸めた値をスライダーに反映する
      setTimeout(() => this.volumeService?.updateCharacteristic(this.volumeLevelChar, volume), 100);
    }
  }

  async setMute(mute) {
    if (mute === this.state.muted) {
      return;
    }
    this.log.info(`${this.name}: ミュート${mute ? 'オン' : 'オフ'}`);
    this.state.muted = mute;
    await this.run(() => this.adb.keyevent('KEYCODE_VOLUME_MUTE'));
  }

  inputSourceType(input) {
    const T = this.Characteristic.InputSourceType;
    switch (input.type) {
      case 'hdmi':
        return T.HDMI;
      case 'app':
        return T.APPLICATION;
      case 'tuner':
        return T.TUNER;
      default:
        return T.OTHER;
    }
  }

  /** HomeKit の set ハンドラから呼ぶ。失敗はログに出して HomeKit へは通信エラーとして返す */
  async run(fn) {
    try {
      return await fn();
    } catch (e) {
      this.log.error(`${this.name}: ${e.message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async queryPower() {
    const out = await this.adb.shell('dumpsys power');
    return parsePowerState(out);
  }

  async setPower(on) {
    this.busyUntil = Date.now() + 8000;
    this.log.info(`${this.name}: 電源${on ? 'オン' : 'オフ'}`);
    this.state.active = on;

    await this.run(async () => {
      if (on) {
        await this.wakeUp();
      } else {
        await this.adb.keyevent('KEYCODE_SLEEP');
      }
      // WAKEUP/SLEEP が効かない機種向けに、状態が変わらなければ POWER トグルで補う。
      // TCL はスタンバイ移行直後に数秒ネットワークが切れるので、確認の失敗は無視する。
      await sleep(2500);
      try {
        const current = await this.queryPower();
        if (current !== null && current !== on) {
          this.log.debug(`${this.name}: 状態が変化しないため KEYCODE_POWER を送信`);
          await this.adb.keyevent('KEYCODE_POWER');
        }
      } catch (e) {
        this.log.debug(`${this.name}: 電源状態の確認に失敗 (${e.message})`);
      }
    });
  }

  /** KEYCODE_WAKEUP を送る。接続できなければ WoL を送りつつ一定時間リトライする */
  async wakeUp() {
    const deadline = Date.now() + (Number(this.device.wakeTimeout) || 20) * 1000;
    for (;;) {
      try {
        await this.adb.keyevent('KEYCODE_WAKEUP');
        return;
      } catch (e) {
        if (Date.now() > deadline) {
          throw e;
        }
        if (this.device.macAddress) {
          sendWakeOnLan(this.device.macAddress, this.device.broadcastAddress).catch((err) =>
            this.log.debug(`WoL送信失敗: ${err.message}`),
          );
        }
        await sleep(2000);
      }
    }
  }

  async setInput(identifier) {
    const input = this.inputs.find((i) => i.identifier === identifier);
    if (!input) {
      return;
    }
    this.busyUntil = Date.now() + 8000;
    this.log.info(`${this.name}: 入力を「${input.name}」に切り替え`);
    this.state.activeIdentifier = identifier;

    await this.run(async () => {
      const on = await this.queryPower().catch(() => false);
      if (on === false) {
        await this.wakeUp();
        this.state.active = true;
        this.tvService.updateCharacteristic(this.Characteristic.Active, this.Characteristic.Active.ACTIVE);
        await sleep(Number(this.device.wakeDelay ?? 3) * 1000);
      }
      await this.resolveTvInputIds();
      await this.adb.shell(buildInputCommand(input));
    });
  }

  /**
   * hdmiPort だけ指定された HDMI 入力と、band なしのチューナー入力に、テレビから取得した input ID を割り当てる。
   * TCL は HDMI キーコードが効かないため passthrough URI で切り替える必要がある。
   */
  async resolveTvInputIds() {
    if (this.tvInputsResolved) {
      return;
    }
    const dump = await this.adb.shell('dumpsys tv_input');
    this.tunerInputId = parseTunerInputId(dump);
    for (const input of this.inputs) {
      if (input.type === 'tuner' && !input.band && !input.tvInputId && this.tunerInputId) {
        input.tvInputId = this.tunerInputId;
      }
    }
    const map = parseHdmiInputIds(dump);
    for (const input of this.inputs.filter((i) => i.type === 'hdmi' && !i.tvInputId)) {
      const id = map.get(Number(input.hdmiPort) || 1);
      if (id) {
        input.tvInputId = id;
        this.log.debug(`${this.name}: ${input.name} -> ${id}`);
      } else {
        this.log.warn(`${this.name}: HDMI ${input.hdmiPort} の input ID が見つかりません。キーコードで切り替えます。`);
      }
    }
    this.tvInputsResolved = true;
  }

  async sendRemoteKey(value) {
    const K = this.Characteristic.RemoteKey;
    const map = {
      [K.REWIND]: 'KEYCODE_MEDIA_REWIND',
      [K.FAST_FORWARD]: 'KEYCODE_MEDIA_FAST_FORWARD',
      [K.NEXT_TRACK]: 'KEYCODE_MEDIA_NEXT',
      [K.PREVIOUS_TRACK]: 'KEYCODE_MEDIA_PREVIOUS',
      [K.ARROW_UP]: 'KEYCODE_DPAD_UP',
      [K.ARROW_DOWN]: 'KEYCODE_DPAD_DOWN',
      [K.ARROW_LEFT]: 'KEYCODE_DPAD_LEFT',
      [K.ARROW_RIGHT]: 'KEYCODE_DPAD_RIGHT',
      [K.SELECT]: 'KEYCODE_DPAD_CENTER',
      [K.BACK]: 'KEYCODE_BACK',
      [K.EXIT]: 'KEYCODE_HOME',
      [K.PLAY_PAUSE]: 'KEYCODE_MEDIA_PLAY_PAUSE',
      [K.INFORMATION]: 'KEYCODE_MENU',
    };
    const key = map[value];
    if (key) {
      await this.run(() => this.adb.keyevent(key));
    }
  }

  startPolling() {
    const tick = async () => {
      try {
        await this.poll();
      } finally {
        this.pollTimer = setTimeout(tick, this.pollInterval);
      }
    };
    tick();
  }

  async poll() {
    if (Date.now() < this.busyUntil) {
      return; // 操作直後は状態が安定しないのでスキップ
    }
    const C = this.Characteristic;
    let active = false;
    try {
      active = (await this.queryPower()) === true;
    } catch (e) {
      // 電源オフで接続できない場合はオフ扱い
      if (this.state.active) {
        this.log.debug(`${this.name}: 状態取得に失敗 (${e.message})`);
      }
    }

    if (active !== this.state.active) {
      this.state.active = active;
      this.tvService.updateCharacteristic(C.Active, active ? C.Active.ACTIVE : C.Active.INACTIVE);
      this.updateVolumeOn();
    }
    if (!active) {
      return;
    }

    try {
      const pkg = parseFocusedPackage(await this.adb.shell('dumpsys window windows'));
      let match = pkg && this.inputs.find((i) => i.type === 'app' && i.package === pkg);
      if (!match) {
        // 前面がアプリ入力でなければ、TV 入力セッション (HDMI・放送) を確認する
        await this.resolveTvInputIds();
        const current = parseCurrentTvInputId(await this.adb.shell('dumpsys tv_input'));
        if (current) {
          match = this.inputs.find((i) => i.type === 'hdmi' && i.tvInputId === current);
          if (!match && current === this.tunerInputId) {
            // 放送中。どのチャンネルかは取れないので、直前に選んだ放送入力を優先する
            const last = this.inputs.find((i) => i.identifier === this.state.activeIdentifier);
            match = last?.type === 'tuner' ? last : this.inputs.find((i) => i.type === 'tuner');
          }
        }
      }
      if (match && match.identifier !== this.state.activeIdentifier) {
        this.state.activeIdentifier = match.identifier;
        this.tvService.updateCharacteristic(C.ActiveIdentifier, match.identifier);
      }
    } catch (e) {
      this.log.debug(`${this.name}: 前面アプリの取得に失敗 (${e.message})`);
    }

    await this.pollVolume();
  }

  async pollVolume() {
    try {
      const vol = parseMusicVolume(await this.adb.shell('dumpsys audio'));
      if (!vol) {
        return;
      }
      const volume = Math.round((vol.volume / vol.max) * 100);
      if (volume !== this.state.volume) {
        this.state.volume = volume;
        this.volumeService?.updateCharacteristic(this.volumeLevelChar, volume);
      }
      if (vol.muted !== this.state.muted) {
        this.state.muted = vol.muted;
        this.speakerService.updateCharacteristic(this.Characteristic.Mute, vol.muted);
      }
      this.updateVolumeOn();
    } catch (e) {
      this.log.debug(`${this.name}: 音量の取得に失敗 (${e.message})`);
    }
  }

  updateVolumeOn() {
    if (!this.volumeService) {
      return;
    }
    const on = this.volumeOn();
    this.volumeService.updateCharacteristic(this.volumeOnChar, this.volumeOnChar === this.Characteristic.On ? on : on ? 1 : 0);
  }
}

module.exports = { PLUGIN_NAME, PLATFORM_NAME, TclAndroidTvPlatform };
