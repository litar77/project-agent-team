import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

// One protocol connection. Never reconnect/replay a mutating request implicitly.
export class RpcChannel extends EventEmitter {
  constructor({ timeoutMs = 20000, maxLineBytes = 4 * 1024 * 1024 } = {}) {
    super();
    this.timeoutMs = timeoutMs; this.maxLineBytes = maxLineBytes;
    this.pending = new Map(); this.sequence = 0; this.buffer = Buffer.alloc(0);
    this.stderr = ''; this.closed = false;
  }
  consume(chunk) {
    if (this.failed || this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.includes(10)) {
      const end = this.buffer.indexOf(10);
      if (end > this.maxLineBytes) return this.fail(new Error('RPC_LINE_LIMIT'));
      const line = this.buffer.subarray(0, end).toString('utf8'); this.buffer = this.buffer.subarray(end + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { return this.fail(new Error('RPC_INVALID_JSON')); }
      if (message.method) {
        this.emit(message.id === undefined ? 'notification' : 'request', message);
      } else {
        const pending = this.pending.get(message.id);
        if (!pending) { this.emit('lateResponse', message); continue; }
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) {
          const error = new Error(`RPC_REJECTED ${message.error.code}: ${message.error.message}`);
          error.rejected = true; pending.reject(error);
        } else pending.resolve(message.result);
      }
    }
    if (this.buffer.length > this.maxLineBytes) this.fail(new Error('RPC_LINE_LIMIT'));
  }
  fail(error) {
    if (this.failed) return;
    this.failed = error;
    this.buffer = Buffer.alloc(0);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.emit('fault', error);
  }
  write(value) {
    if (this.closed || this.failed) throw this.failed || new Error('APP_SERVER_CLOSED');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  request(method, params) {
    if (this.closed || this.failed) return Promise.reject(this.failed || new Error('APP_SERVER_CLOSED'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Timeout means the result is UNKNOWN, not that the server did nothing.
        reject(new Error(`RPC_UNKNOWN_TIMEOUT ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async initialize() {
    const result = await this.request('initialize', {
      clientInfo: { name: 'project_agent_team', title: 'Project Agent Team Team', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized', params: {} }); return result;
  }
  respond(id, result) { this.write({ id, result }); }
  reject(id, message) { this.write({ id, error: { code: -32601, message } }); }
  async close() {
    if (this.closed) return;
    this.child.stdin.end();
    const exited = new Promise(resolve => this.child.once('close', resolve));
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
    clearTimeout(timer);
    if (!this.closed) {
      this.child.kill(); // only our owned direct child; no sweeping process/descendant kill
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
      clearTimeout(timer);
    }
    if (!this.closed) throw new Error('APP_SERVER_CLOSE_UNKNOWN');
  }
}
