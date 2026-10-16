// SPDX-License-Identifier: MIT
// No account tokens are read by this program.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const MAX_FRAME = 256 * 1024 * 1024;
const HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const APP = process.env.CODEX_RELAY_APP || '/Applications/ChatGPT.app';
const STORE = process.env.CODEX_RELAY_STATE || path.join(os.homedir(), 'Library/Application Support/Codex Relay');
const STATE_FILE = path.join(STORE, 'state.json');
const SUPPORTED = new Set(['26.1013.31256/20586']);
const DEFAULT_PROMPT = '继续完成之前因额度耗尽而中断的任务，先检查当前进度，再从未完成的部分继续。';
const now = () => Date.now() / 1000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const stable = value => JSON.stringify(canonical(value));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function version() {
  try {
    const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(APP, 'Contents/Info.plist')], { encoding: 'utf8', timeout: 3000 }));
    return `${plist.CFBundleShortVersionString}/${plist.CFBundleVersion}`;
  } catch { throw new Error('未找到 Codex 桌面应用，请先安装并打开。'); }
}
function assertCompatible() {
  const value = version();
  if (!SUPPORTED.has(value)) throw new Error(`Codex ${value} 尚未验证兼容，已暂停自动续跑。`);
  return value;
}
function binary() {
  for (const rel of ['Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', 'Contents/Resources/codex']) {
    const value = path.join(APP, rel);
    if (fs.existsSync(value)) return value;
  }
  throw new Error('未找到桌面端附带的 Codex CLI。');
}

export class Desktop extends EventEmitter {
  socket = null; pending = new Map(); owners = new Map(); snapshots = new Map(); generations = new Map(); clientId = 'initializing-client';
  header = Buffer.alloc(4); headerBytes = 0; frameLength = 0; frameBytes = 0; chunks = [];
  async connect() {
    assertCompatible();
    const endpoint = path.join(HOME, 'ipc/ipc.sock');
    for (const name of [path.dirname(endpoint), endpoint]) {
      const st = fs.lstatSync(name);
      if (st.uid !== process.getuid() || (st.mode & 0o077) || (name === endpoint ? !st.isSocket() : !st.isDirectory())) throw new Error('Codex 本地通道的权限或所有者不匹配。');
    }
    this.socket = net.createConnection(endpoint);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.socket.destroy(); reject(new Error('连接 Codex 超时。')); }, 5000);
      this.socket.once('connect', () => { clearTimeout(timer); resolve(); });
      this.socket.once('error', e => { clearTimeout(timer); reject(e); });
    });
    this.socket.on('data', bytes => this.consume(bytes));
    this.socket.on('error', () => {});
    this.socket.on('close', () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex 连接已断开。')); }
      this.pending.clear(); this.snapshots.clear(); this.owners.clear();
      this.emit('disconnected');
    });
    const reply = await this.request('initialize', { clientType: 'codex-relay' }, 0);
    this.clientId = reply.result?.clientId;
    if (typeof this.clientId !== 'string') throw new Error('Codex 初始化响应不兼容。');
  }
  send(message) {
    if (!this.socket || this.socket.destroyed) throw new Error('Codex 连接已断开。');
    const data = Buffer.from(JSON.stringify(message));
    if (data.length > MAX_FRAME) throw new Error('请求过大。');
    const header = Buffer.alloc(4); header.writeUInt32LE(data.length);
    this.socket.write(Buffer.concat([header, data]));
  }
  consume(data) {
    let offset = 0;
    while (offset < data.length) {
      if (!this.frameLength) {
        const size = Math.min(4 - this.headerBytes, data.length - offset);
        data.copy(this.header, this.headerBytes, offset, offset + size); this.headerBytes += size; offset += size;
        if (this.headerBytes < 4) return;
        this.frameLength = this.header.readUInt32LE(0); this.headerBytes = 0;
        if (!this.frameLength || this.frameLength > MAX_FRAME) { this.close(); return; }
      }
      const size = Math.min(this.frameLength - this.frameBytes, data.length - offset);
      this.chunks.push(data.subarray(offset, offset + size)); this.frameBytes += size; offset += size;
      if (this.frameBytes < this.frameLength) return;
      const bytes = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.frameLength);
      this.chunks = []; this.frameBytes = 0; this.frameLength = 0;
      let msg; try { msg = JSON.parse(bytes.toString()); } catch { this.close(); return; }
      this.message(msg);
    }
  }
  message(msg) {
    if (msg.type === 'client-discovery-request') {
      this.send({ type: 'client-discovery-response', requestId: msg.requestId, response: { canHandle: false } });
    } else if (msg.type === 'request') {
      this.send({ type: 'response', requestId: msg.requestId, resultType: 'error', error: 'unsupported-by-codex-relay' });
    } else if (msg.type === 'response') {
      const pending = this.pending.get(msg.requestId);
      if (!pending) return;
      this.pending.delete(msg.requestId); clearTimeout(pending.timer);
      if (msg.resultType !== 'success' || msg.method !== pending.method) {
        const e = new Error(msg.error === 'no-client-found' ? '请在 Codex 中打开这个任务，等待会话连接。' : 'Codex 未接受请求，等待检查会话状态。');
        e.code = msg.error; pending.reject(e);
      } else pending.resolve(msg);
    } else if (msg.type === 'broadcast' && msg.method === 'thread-stream-state-changed') {
      const p = msg.params, id = p?.conversationId;
      if (p?.hostId !== 'local' || this.owners.get(id) !== msg.sourceClientId) return;
      this.generations.set(id, (this.generations.get(id) || 0) + 1);
      if (msg.version !== 11) { this.snapshots.delete(id); this.emit(`snapshot:${id}`, new Error('Codex 状态协议版本已变化。')); return; }
      if (p.change?.type === 'snapshot' && p.change.conversationState?.id === id) {
        this.snapshots.set(id, p.change.conversationState);
        this.emit(`snapshot:${id}`, null, p.change.conversationState);
      } else this.snapshots.delete(id);
    }
  }
  request(method, params, version, target, timeout = 12000) {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Codex 响应超时。')); }, timeout);
      this.pending.set(requestId, { resolve, reject, timer, method });
      try { this.send({ type: 'request', requestId, sourceClientId: this.clientId, method, params, version, timeoutMs: timeout, ...(target ? { targetClientId: target } : {}) }); }
      catch (e) { clearTimeout(timer); this.pending.delete(requestId); reject(e); }
    });
  }
  follow(id, enabled) {
    const owner = this.owners.get(id);
    if (owner) this.send({ type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId: this.clientId, targetClientIds: [owner], version: 1, params: { hostId: 'local', conversationId: id, following: enabled } });
  }
  async snapshot(id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('会话 ID 格式不正确。');
    const reply = await this.request('thread-owner-discovery', { hostId: 'local', conversationId: id }, 1);
    if (typeof reply.handledByClientId !== 'string') throw new Error('无法确认会话所有者。');
    this.owners.set(id, reply.handledByClientId);
    this.follow(id, false); this.snapshots.delete(id);
    const result = new Promise((resolve, reject) => {
      const event = `snapshot:${id}`;
      const listener = (error, state) => { clearTimeout(timer); this.off(event, listener); error ? reject(error) : resolve(state); };
      const timer = setTimeout(() => { this.off(event, listener); reject(new Error('等待任务状态同步超时。')); }, 12000);
      this.on(event, listener);
    });
    this.follow(id, true);
    return result;
  }
  async resume(id, expected, messageId, prompt, guard, onDispatch) {
    assertCompatible();
    const state = await this.snapshot(id);
    if (assess(state).action !== 'resume' || fingerprint(state) !== expected) throw new Error('发送前任务状态已变化，已取消本次续跑。');
    const generation = this.generations.get(id);
    await delay(75); // Let already-queued IPC events invalidate the snapshot.
    if (this.generations.get(id) !== generation || this.snapshots.get(id) !== state || !guard()) throw new Error('任务已变化或监控已暂停，已取消本次续跑。');
    // No await between this durable intent and dispatch. Uncertainty never retries.
    onDispatch();
    const reply = await this.request('thread-follower-start-turn', { conversationId: id, turnStart: { request: { threadId: id, clientUserMessageId: messageId, input: [{ type: 'text', text: prompt, text_elements: [] }] }, context: { inheritThreadSettings: true } } }, 2, this.owners.get(id), 30000);
    const turnId = reply.result?.result?.turn?.id;
    if (typeof turnId !== 'string' || !turnId) throw new Error('续跑已发送，但结果尚未确认。');
    return turnId;
  }
  close() { this.socket?.destroy(); }
}

export class ReadOnlyServer {
  process = null; pending = new Map(); counter = 0; buffer = '';
  async connect() {
    this.process = spawn(binary(), ['app-server', '--stdio'], { env: { ...process.env, CODEX_HOME: HOME }, stdio: ['pipe', 'pipe', 'ignore'] });
    this.process.on('error', () => this.close());
    this.process.on('exit', () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('额度查询进程已退出。')); }
      this.pending.clear(); this.process = null;
    });
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', data => {
      this.buffer += data;
      if (this.buffer.length > 32 * 1024 * 1024) { this.close(); return; }
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
        let reply; try { reply = JSON.parse(line); } catch { continue; }
        if (reply.method) continue;
        const pending = this.pending.get(reply.id); if (!pending) continue;
        this.pending.delete(reply.id); clearTimeout(pending.timer);
        reply.error ? pending.reject(new Error('额度或任务查询失败，请检查 Codex 登录和网络。')) : pending.resolve(reply.result);
      }
    });
    await this.request('initialize', { clientInfo: { name: 'codex_relay', version: '0.1.1' }, capabilities: { experimentalApi: true } });
    this.process.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  }
  request(method, params) {
    if (!['initialize', 'account/rateLimits/read', 'thread/list', 'thread/read', 'thread/turns/list'].includes(method)) throw new Error('只读连接拒绝写操作。');
    return new Promise((resolve, reject) => {
      if (!this.process || this.process.stdin.destroyed) return reject(new Error('只读查询进程不可用。'));
      const id = ++this.counter;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('额度或任务查询超时。')); }, 25000);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error('查询连接已断开。')); }
      });
    });
  }
  close() { this.process?.kill(); }
}

export function latestTurn(state) {
  if (state.turnHistory?.kind === 'canonical') {
    const hist = state.turnHistory.history, tail = hist?.islands?.at(-1);
    if (tail?.newerBoundary?.status !== 'exhausted') throw new Error('最新任务历史尚未同步。');
    const turn = hist?.entitiesByKey?.[tail.entries?.at(-1)?.value];
    if (!turn || typeof turn !== 'object') throw new Error('无法读取最新任务轮次。');
    return turn;
  }
  const turn = state.turns?.at(-1);
  if (!turn || typeof turn !== 'object') throw new Error('任务尚无可验证的轮次。');
  return turn;
}
export function assess(state) {
  const result = (action, label, turn) => ({ action, label, turnId: turn?.turnId || turn?.id });
  if (state.hostId !== 'local' || state.ephemeral !== false) return result('stop', '仅支持本机持久会话');
  if (state.resumeState !== 'resumed') return result('wait', '等待会话加载');
  if (!Array.isArray(state.requests)) return result('wait', '等待审批状态同步');
  const queued = state.queuedFollowUps;
  if (state.requests.length || state.threadGoalResumeConfirmation || (queued && (!Array.isArray(queued) || queued.length))) return result('attention', '等待你处理审批、输入或排队消息');
  if (state.threadGoal && state.threadGoal.status !== 'active') return result('attention', '任务目标已暂停或结束');
  const runtime = state.threadRuntimeStatus;
  if (runtime?.type === 'active') return result(!Array.isArray(runtime.activeFlags) || runtime.activeFlags.length ? 'attention' : 'wait', !Array.isArray(runtime.activeFlags) || runtime.activeFlags.length ? '等待你处理审批或输入' : '执行中 · 持续监控');
  if (!['idle', 'systemError'].includes(runtime?.type)) return result('wait', '等待运行状态同步');
  let turn; try { turn = latestTurn(state); } catch (e) { return result('wait', e.message); }
  if (turn.status === 'inProgress') return result('wait', '执行中 · 状态同步', turn);
  if (turn.status === 'completed') return result('finished', '本轮已完成 · 不触发续跑', turn);
  if (turn.status === 'interrupted') return result('stopped', '手动停止 · 不触发续跑', turn);
  const info = turn.error?.codexErrorInfo;
  if (turn.status === 'failed' && ['usageLimitExceeded', 'UsageLimitExceeded'].includes(info)) return result('resume', '额度耗尽 · 等待恢复', turn);
  return result('attention', '其他错误 · 请在 Codex 检查', turn);
}
export function fingerprint(state) {
  const data = {};
  for (const k of ['id', 'hostId', 'cwd', 'latestModel', 'latestReasoningEffort', 'latestCollaborationMode', 'currentPermissions', 'latestThreadSettings', 'threadGoal', 'threadGoalResumeConfirmation', 'requests', 'queuedFollowUps', 'threadRuntimeStatus', 'resumeState']) data[k] = state[k] ?? null;
  data.turn = latestTurn(state);
  return createHash('sha256').update(stable(data)).digest('hex');
}
export function quotaStatus(raw, timestamp = now()) {
  const buckets = raw.rateLimitsByLimitId;
  const quota = buckets && Object.keys(buckets).length ? buckets.codex : raw.rateLimits;
  if (!quota || (quota.limitId && quota.limitId !== 'codex')) return { ready: false, label: '未找到 Codex 额度桶' };
  if (raw.ordinaryUsageAllowed === false || (buckets && Object.keys(buckets).length > 1)) return { ready: false, quota, label: '账户存在其他额度限制或多个额度桶，需要确认任务归属' };
  const blocked = [];
  if (quota.spendControlReached || quota.individualLimit != null || ![null, undefined, 'rate_limit_reached'].includes(quota.rateLimitReachedType)) return { ready: false, quota, label: '账户存在其他限制，请在 Codex 检查' };
  if (!quota.primary) return { ready: false, quota, label: '额度数据尚未同步' };
  for (const window of [quota.primary, quota.secondary].filter(Boolean)) {
    const { usedPercent: used, resetsAt: reset, windowDurationMins: duration } = window;
    if (![used, reset, duration].every(v => typeof v === 'number' && Number.isFinite(v)) || used < 0 || used > 100 || reset <= 0 || duration <= 0) return { ready: false, quota, label: '额度数据不完整' };
    if (used >= 100) blocked.push(reset);
    else if (reset <= timestamp) return { ready: false, quota, label: '等待刷新重置后的额度' };
  }
  if (blocked.length) return { ready: false, quota, next: Math.max(...blocked) + 15, label: '额度耗尽，等待实际重置' };
  if (quota.rateLimitReachedType) return { ready: false, quota, label: '服务仍标记额度耗尽' };
  return { ready: true, quota, label: '额度可用' };
}

export class Monitor {
  constructor({ desktopFactory = () => new Desktop(), serverFactory = () => new ReadOnlyServer(), stateFile = STATE_FILE, output = value => process.stdout.write(JSON.stringify(value) + '\n'), compatible = assertCompatible } = {}) {
    this.desktopFactory = desktopFactory; this.serverFactory = serverFactory; this.stateFile = stateFile; this.output = output; this.compatible = compatible;
    this.data = { schema: 1, enabled: true, prompt: DEFAULT_PROMPT, watches: {}, events: [] };
    try { this.data = { ...this.data, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; }
    catch (e) { if (e.code !== 'ENOENT') { this.data.enabled = false; this.loadError = '配置文件损坏，已暂停监控。请保留文件并检查。'; } }
    if (this.data.schema !== 1 || !this.data.watches || typeof this.data.watches !== 'object' || Array.isArray(this.data.watches) || !Array.isArray(this.data.events) || typeof this.data.prompt !== 'string' || Object.values(this.data.watches).some(w => !w || typeof w !== 'object')) {
      this.data = { schema: 1, enabled: false, prompt: DEFAULT_PROMPT, watches: {}, events: [] };
      this.loadError = '配置文件格式不兼容，已暂停监控。请保留文件并检查。';
    }
    this.tasks = new Map(); this.desktop = null; this.server = null; this.error = this.loadError || ''; this.connected = false; this.quota = null; this.quotaAt = 0; this.listAt = 0; this.busy = false; this.generation = 0; this.closed = false;
  }
  save() {
    if (this.loadError) throw new Error(this.loadError);
    const dir = path.dirname(this.stateFile); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = this.stateFile + '.' + randomUUID() + '.tmp';
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.data, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.stateFile);
    const parent = fs.openSync(dir, 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  }
  log(message) {
    this.data.events.push({ at: Date.now(), message });
    this.data.events = this.data.events.slice(-150);
    this.save();
  }
  publish() {
    const values = new Map(this.tasks);
    for (const [id, w] of Object.entries(this.data.watches)) if (!values.has(id)) values.set(id, { id, title: w.title || id, label: '等待读取任务' });
    const tasks = [...values.values()].map(t => ({ ...t, watched: !!this.data.watches[t.id]?.enabled, label: this.data.watches[t.id]?.enabled ? (this.data.watches[t.id].label || t.label || '等待检查') : (t.label || '未监控') }));
    tasks.sort((a, b) => Number(b.watched) - Number(a.watched) || (b.updatedAt || 0) - (a.updatedAt || 0));
    this.output({ type: 'state', connected: this.connected, enabled: this.data.enabled, prompt: this.data.prompt, error: this.error, quota: this.quota, tasks, events: this.data.events, description: this.connected ? '每 30 秒检查所选任务；额度每 60 秒刷新。额度恢复后逐一复核并续跑。' : '请保持 Codex 桌面端与本应用运行。断线后会自动重连。' });
  }
  async ensureConnections() {
    this.compatible();
    if (!this.server?.process) { this.server?.close(); this.server = this.serverFactory(); await this.server.connect(); }
    if (!this.desktop) {
      const desktop = this.desktopFactory();
      desktop.on?.('disconnected', () => { if (this.desktop === desktop) { this.desktop = null; this.connected = false; this.quotaAt = 0; this.publish(); } });
      try { await desktop.connect(); this.desktop = desktop; } catch (e) { desktop.close(); throw e; }
    }
    this.connected = true;
  }
  async list() {
    let cursor = null, pages = 0;
    const values = new Map();
    do {
      const result = await this.server.request('thread/list', { limit: 100, archived: false, sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'], sortKey: 'updated_at', sortDirection: 'desc', modelProviders: [], useStateDbOnly: true, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.data)) throw new Error('任务列表格式不兼容。');
      for (const t of result.data) {
        if (!t.id || t.ephemeral) continue;
        values.set(t.id, { id: t.id, title: t.name || t.preview?.split('\n')[0]?.slice(0, 120) || '未命名任务', updatedAt: t.updatedAt, cwd: t.cwd, label: '未监控' });
      }
      cursor = result.nextCursor; pages++;
    } while (cursor && pages < 20 && !this.closed);
    if (cursor) throw new Error('任务列表超过 2000 条，请先在 Codex 归档旧任务。');
    this.tasks = values; this.listAt = now();
  }
  async readQuota(force = false) {
    if (!force && now() - this.quotaAt < 60 && this.quotaRaw) return quotaStatus(this.quotaRaw);
    const raw = await this.server.request('account/rateLimits/read');
    const status = quotaStatus(raw);
    this.quotaRaw = raw; this.quota = status.quota || null; this.quotaAt = now();
    return status;
  }
  async checkTask(id, watch) {
    if (!watch.enabled || !this.data.enabled || this.closed) return;
    const generation = this.generation;
    const stillSelected = () => this.data.watches[id] === watch && watch.enabled && this.data.enabled && generation === this.generation && !this.closed;
    const snapshot = await this.desktop.snapshot(id);
    if (!stillSelected()) return;
    const decision = assess(snapshot);
    const tid = decision.turnId;
    watch.title = this.tasks.get(id)?.title || snapshot.title || watch.title;
    // If a send's reply was lost, a later, different turn resolves it without resending.
    if (watch.dispatch && ['intent', 'uncertain'].includes(watch.dispatch.status)) {
      let latest; try { latest = latestTurn(snapshot); } catch {}
      const latestId = latest?.turnId || latest?.id;
      if (latestId && latestId !== watch.dispatch.sourceTurnId) { watch.dispatch.status = 'observed-new-turn'; this.save(); }
      else { watch.label = '发送结果不确定 · 请在 Codex 检查'; return; }
    }
    watch.label = decision.label;
    if (decision.action !== 'resume' || !tid) return;
    if (watch.processed?.includes(tid)) { watch.label = '本次额度中断已处理 · 不重复发送'; return; }
    if (watch.lastSentAt && Date.now() - watch.lastSentAt < 120000) { watch.label = '再次额度中断 · 两分钟后复查'; return; }
    const cachedQuota = await this.readQuota();
    if (!stillSelected()) return;
    if (!cachedQuota.ready) { watch.label = cachedQuota.next ? `等待额度恢复 · ${new Date(cachedQuota.next * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 后复查` : cachedQuota.label; return; }
    // thread/read does not expose archival state. Refresh the unarchived catalog.
    await this.list();
    if (!stillSelected()) return;
    if (!this.tasks.has(id)) { watch.label = '任务已归档或不可用 · 不续跑'; return; }
    const quota = await this.readQuota(true);
    if (!stillSelected()) return;
    if (!quota.ready) { watch.label = quota.next ? `等待额度恢复 · ${new Date(quota.next * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 后复查` : quota.label; return; }
    const expected = fingerprint(snapshot), messageId = randomUUID();
    let dispatched = false;
    try {
      const turnId = await this.desktop.resume(id, expected, messageId, this.data.prompt, stillSelected, () => {
        watch.dispatch = { sourceTurnId: tid, clientMessageId: messageId, status: 'intent', at: Date.now() };
        watch.processed = [...(watch.processed || []), tid].slice(-500);
        this.save(); dispatched = true;
      });
      const current = this.data.watches[id];
      current.dispatch.status = 'sent'; current.dispatch.turnId = turnId; current.lastSentAt = Date.now();
      current.resumeCount = (current.resumeCount || 0) + 1;
      if (current.enabled) current.label = '已在原会话续跑 · 持续监控';
      this.log(`已续跑「${watch.title}」，累计 ${current.resumeCount} 次。`);
    } catch (e) {
      if (dispatched) {
        watch.dispatch.status = 'uncertain'; watch.label = '发送结果不确定 · 请在 Codex 检查';
        this.log(`「${watch.title}」续跑结果不确定，已停止重发；请检查原会话。`);
      } else { watch.label = e.message; }
    }
  }
  async tick(force = false) {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      if (this.loadError) throw new Error(this.loadError);
      await this.ensureConnections();
      if (force || now() - this.listAt >= 120) await this.list();
      await this.readQuota(force);
      this.error = '';
      this.publish();
      for (const [id, w] of Object.entries(this.data.watches)) {
        if (!w.enabled) continue;
        try { await this.checkTask(id, w); }
        catch (e) {
          w.label = e.message.includes('ENOENT') ? '等待 Codex 重新连接' : e.message;
          if (e.code === 'no-client-found' && w.enabled && this.data.enabled) {
            try { await this.reopenSelected(id, w); } catch { /* Retain watch and retry next cycle. */ }
          }
        }
        finally {
          // Subscribe only during each verification/send, not to an entire log stream.
          try { this.desktop?.follow(id, false); } catch {}
          this.desktop?.snapshots?.delete(id); this.desktop?.owners?.delete(id);
        }
        this.publish();
      }
      this.save();
    } catch (e) {
      this.connected = false;
      this.error = e.message.includes('ENOENT') || e.message.includes('ECONNREFUSED') ? 'Codex 未运行或本地连接不可用；会自动重试。' : e.message;
      if (this.desktop?.socket?.destroyed) this.desktop = null;
    } finally { this.busy = false; this.publish(); }
  }
  async command(message) {
    if (message.command === 'shutdown') { this.close(); return; }
    if (message.command === 'setEnabled') {
      this.generation++; this.data.enabled = message.value === true;
      this.log(this.data.enabled ? '已恢复监控。' : '已暂停全部监控。'); this.publish(); return;
    }
    if (message.command === 'configure') {
      if (typeof message.prompt !== 'string' || !message.prompt.trim() || message.prompt.length > 4000) return;
      this.generation++; this.data.prompt = message.prompt.trim(); this.log('已保存续跑消息。'); this.publish(); return;
    }
    if (message.command === 'watch') {
      const id = message.threadId;
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || (!this.tasks.has(id) && !this.data.watches[id])) return;
      this.generation++;
      const old = this.data.watches[id] || {};
      const title = this.tasks.get(id)?.title || old.title || id;
      this.data.watches[id] = { ...old, title, enabled: message.enabled === true, label: message.enabled ? '等待检查任务状态' : '已取消监控' };
      if (!message.enabled && this.desktop) {
        try { this.desktop.follow(id, false); } catch {}
        this.desktop.owners?.delete(id); this.desktop.snapshots?.delete(id);
      }
      this.log(`${message.enabled ? '开始监控' : '取消监控'}「${title}」。`); this.publish();
      if (message.enabled) void this.tick(true);
      return;
    }
    if (message.command === 'refresh') void this.tick(true);
  }
  async reopenSelected(id, watch) {
    if (watch.lastOpenAt && Date.now() - watch.lastOpenAt < 300000) return;
    const generation = this.generation;
    await this.list();
    if (!this.tasks.has(id)) { watch.label = '任务已归档或不可用 · 不续跑'; return; }
    const history = await this.server.request('thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
    const last = history.data?.[0];
    if (!(last?.status === 'inProgress' || (last?.status === 'failed' && ['usageLimitExceeded', 'UsageLimitExceeded'].includes(last.error?.codexErrorInfo)))) return;
    if (!watch.enabled || !this.data.enabled || this.generation !== generation || this.closed) return;
    watch.lastOpenAt = Date.now(); this.save();
    // Load only this explicitly selected conversation; never choose a latest task.
    execFileSync('/usr/bin/open', ['-g', `codex://threads/${id}`], { timeout: 5000, stdio: 'ignore' });
    watch.label = '正在重新连接原会话 · 下次检查继续';
  }
  close() { this.closed = true; this.generation++; this.desktop?.close(); this.server?.close(); }
}

async function diagnose() {
  const desktop = new Desktop(), server = new ReadOnlyServer();
  try {
    const appVersion = assertCompatible();
    await desktop.connect(); await server.connect();
    const raw = await server.request('account/rateLimits/read');
    const list = await server.request('thread/list', { limit: 10, sourceKinds: ['cli', 'vscode', 'appServer'], sortKey: 'updated_at', modelProviders: [], useStateDbOnly: true });
    const snapshotId = process.env.CODEX_RELAY_PROBE_THREAD;
    let live;
    if (snapshotId) {
      const snapshot = await desktop.snapshot(snapshotId);
      const decision = assess(snapshot);
      live = { runtime: snapshot.threadRuntimeStatus, resumeState: snapshot.resumeState, requests: snapshot.requests?.length, decision: decision.action, label: decision.label, historyKind: snapshot.turnHistory?.kind, hasModel: !!snapshot.latestModel };
    }
    process.stdout.write(JSON.stringify({ ok: true, appVersion, quota: quotaStatus(raw).quota, listedTasks: list.data?.length, live }, null, 2) + '\n');
  } finally { desktop.close(); server.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--diagnose')) {
    diagnose().catch(e => { process.stderr.write(e.message + '\n'); process.exitCode = 1; });
  } else if (!process.argv.includes('--stdio') || Number(process.env.CODEX_RELAY_PARENT_PID) !== process.ppid) {
    process.stderr.write('请打开 Codex Relay.app。只读诊断可使用 --diagnose。\n');
    process.exitCode = 1;
  } else {
    const monitor = new Monitor();
    const input = readline.createInterface({ input: process.stdin });
    input.on('line', line => { try { void monitor.command(JSON.parse(line)).catch(e => { monitor.error = e.message; monitor.publish(); }); } catch {} });
    const timer = setInterval(() => void monitor.tick(), 30000);
    const close = () => { clearInterval(timer); monitor.close(); input.close(); process.exit(0); };
    input.on('close', close); process.on('SIGTERM', close); process.on('SIGINT', close);
    process.stdout.on('error', close);
    monitor.publish(); void monitor.tick(true);
  }
}
