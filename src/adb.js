'use strict';

const { execFile } = require('child_process');

/**
 * `adb` コマンドの薄いラッパー。
 * コマンドは直列に実行し、失敗時は一度だけ `adb connect` して再試行する。
 */
class AdbClient {
  constructor({ host, port = 5555, adbPath = 'adb', timeout = 5000, home, log = console }) {
    this.serial = `${host}:${port}`;
    this.adbPath = adbPath;
    this.timeout = timeout;
    this.log = log;
    this.queue = Promise.resolve();
    // adb は $HOME/.android/adbkey を鍵として使う。
    // Docker ではコンテナ再作成で鍵が消えるので、永続化される場所を HOME に指定できるようにする
    this.env = home ? { ...process.env, HOME: home } : undefined;
  }

  _exec(args) {
    return new Promise((resolve, reject) => {
      execFile(this.adbPath, args, { timeout: this.timeout, env: this.env }, (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || stdout || err.message || '').toString().trim();
          reject(new Error(msg || `adb ${args.join(' ')} failed`));
          return;
        }
        resolve(stdout.toString());
      });
    });
  }

  _enqueue(task) {
    const run = this.queue.then(task, task);
    // 失敗してもキューを止めない
    this.queue = run.catch(() => undefined);
    return run;
  }

  async connect() {
    const out = await this._exec(['connect', this.serial]);
    if (/unable|failed|refused|cannot|no route|timed out/i.test(out)) {
      throw new Error(out.trim());
    }
    return out.trim();
  }

  shell(command) {
    return this._enqueue(async () => {
      try {
        return await this._exec(['-s', this.serial, 'shell', command]);
      } catch (e) {
        this.log.debug?.(`adb shell failed (${e.message}), reconnecting to ${this.serial}`);
        await this.connect();
        return this._exec(['-s', this.serial, 'shell', command]);
      }
    });
  }

  keyevent(key) {
    return this.shell(`input keyevent ${key}`);
  }
}

module.exports = { AdbClient };
