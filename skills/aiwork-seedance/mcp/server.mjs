#!/usr/bin/env node
/*
 * AI Work Seedance MCP server (stdio, zero dependency).
 *
 * Thin protocol bridge. Every logical operation is executed by the bundled
 * PowerShell runner (../scripts/aiwork-seedance.ps1), which stays the single
 * implementation of asset upload, idempotency, polling and download, and the
 * only holder of the DPAPI-encrypted API key. This file never reads, prints or
 * forwards the key.
 *
 * Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout (MCP stdio rules).
 * stdout carries protocol messages only; all diagnostics go to stderr.
 *
 * Verified behaviors this bridge depends on (Windows PowerShell 5.1):
 *  - A child script's `exit N` does NOT set $LASTEXITCODE nor the host exit code
 *    when the invocation is the LAST statement of -Command, where it does.
 *  - Array parameters only bind correctly through -Command `@('a','b')`;
 *    -File silently mis-binds comma lists and leaks extra tokens into positionals.
 *  - Output redirected to a file handle is UTF-8 on both stdout and stderr, so
 *    the runner's Chinese messages are read back with the .UTF-8 decoder.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SERVER_INFO = { name: 'aiwork-seedance', title: 'AI Work Seedance', version: '1.0.0' };
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const FALLBACK_PROTOCOL = '2025-06-18';
const JSONRPC = '2.0';

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(HERE, '..', 'scripts', 'aiwork-seedance.ps1');
const POWERSHELL =
  process.env.AIWORK_PS_EXE
  || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const RESOLUTIONS = ['480p', '720p', '1080p', '4k'];
const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
// CreateProcess caps a command line at 32767 characters; keep a wide margin.
const MAX_COMMAND_CHARS = 28000;
const MAX_PROMPT_CHARS = 16000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
// Runner gets to finish its own wait, then this much slack before we kill it.
const WAIT_GRACE_SECONDS = 45;
const DEFAULT_WAIT_SECONDS = 45;
const DEFAULT_GENERATE_WAIT_SECONDS = 540;
const MAX_WAIT_SECONDS = Number(process.env.AIWORK_MCP_MAX_WAIT_SECONDS) || 3600;
const NON_TERMINAL = new Set(['', 'queued', 'pending', 'submitted', 'in_progress', 'in-progress', 'processing', 'running', 'created']);
const SETUP_HINTS = [/未配置\s*AIWORK/i, /install\.cmd/i, /无法解密/, /配置文件无法读取/];

/* ------------------------------- errors ---------------------------------- */

class ValidationError extends Error {}

class RunnerError extends Error {
  constructor(message, { taskId = null, action = null, needsSetup = false } = {}) {
    super(message);
    this.name = 'RunnerError';
    this.taskId = taskId;
    this.action = action;
    this.needsSetup = needsSetup;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------ arg validation ----------------------------- */

function takeString(args, name, { required = false, maxLength = 4000 } = {}) {
  const value = args?.[name];
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${name} 不能为空。`);
    return '';
  }
  if (typeof value !== 'string') throw new ValidationError(`${name} 必须是字符串。`);
  if (value.includes('\0')) throw new ValidationError(`${name} 含有非法空字符。`);
  const text = value.trim();
  if (!text) {
    if (required) throw new ValidationError(`${name} 不能为空。`);
    return '';
  }
  if (text.length > maxLength) throw new ValidationError(`${name} 超过 ${maxLength} 字符上限。`);
  return text;
}

function takeInt(args, name, { min, max, def }) {
  const value = args?.[name];
  if (value === undefined || value === null || value === '') return def;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(num)) throw new ValidationError(`${name} 必须是整数。`);
  if (num < min || num > max) throw new ValidationError(`${name} 必须在 ${min}-${max} 之间。`);
  return num;
}

function takeEnum(args, name, allowed, def) {
  const value = args?.[name];
  if (value === undefined || value === null || value === '') return def;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new ValidationError(`${name} 只能是 ${allowed.join(' / ')} 之一。`);
  }
  return value;
}

function takeList(args, name, { maxLength = 1000, maxItems = 16 } = {}) {
  const value = args?.[name];
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of items) {
    if (typeof item !== 'string') throw new ValidationError(`${name} 必须是字符串数组。`);
    if (item.includes('\0')) throw new ValidationError(`${name} 含有非法空字符。`);
    const text = item.trim();
    if (!text) continue;
    if (text.length > maxLength) throw new ValidationError(`${name} 单项超过 ${maxLength} 字符上限。`);
    out.push(text);
  }
  if (out.length > maxItems) throw new ValidationError(`${name} 最多 ${maxItems} 项。`);
  return out;
}

/* --------------------- PowerShell command construction -------------------- */

// A PowerShell single-quoted literal is inert: $, `, &, |, ( ) and " carry no
// meaning inside it, so doubling ' is the only escaping the values need.
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function psArray(values) {
  return `@(${values.map(psQuote).join(', ')})`;
}

function buildCommand(action, params) {
  const parts = [`& ${psQuote(RUNNER)}`, `-Action ${psQuote(action)}`];
  for (const [flag, value] of params) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(flag)) throw new Error(`internal: bad parameter flag ${flag}`);
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      parts.push(`-${flag} ${psArray(value)}`);
    } else if (typeof value === 'number') {
      if (!Number.isInteger(value)) throw new ValidationError(`-${flag} 必须是整数。`);
      parts.push(`-${flag} ${value}`);
    } else {
      parts.push(`-${flag} ${psQuote(value)}`);
    }
  }
  // The runner invocation must stay the last statement: that is what makes a
  // non-zero process exit code observable (see the header notes).
  const command = `$ErrorActionPreference='Stop'; ${parts.join(' ')}`;
  if (command.length > MAX_COMMAND_CHARS) {
    throw new ValidationError(`参数总长度超过 ${MAX_COMMAND_CHARS} 字符，请缩短提示词或减少素材数量。`);
  }
  return command;
}

/* ------------------------------- runner I/O -------------------------------- */

function log(message) {
  process.stderr.write(`[aiwork-mcp] ${message}\n`);
}

function readUtf8(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

function tailText(value, limit = 800) {
  const text = String(value ?? '').replace(/\r/g, '').trim();
  if (!text) return '';
  return text.length <= limit ? text : `…${text.slice(-limit)}`;
}

function parseRunnerJson(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (isPlainObject(parsed)) return parsed;
    return { value: parsed };
  } catch {
    // tolerate a warning line before the JSON payload
  }
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines.slice(index).join('\n').trim();
    if (!candidate.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // keep scanning backwards for the first balanced object
    }
  }
  return null;
}

function classifyRunnerFailure(stderrText, stdoutText, code, action) {
  const message = tailText(stderrText) || tailText(stdoutText) || `PowerShell runner 以退出码 ${code} 结束，且没有输出可解析的结果。`;
  const needsSetup = SETUP_HINTS.some((pattern) => pattern.test(message));
  const hint = needsSetup
    ? ' 请先在本机运行 install.cmd 配置 AI Work 网关地址与 API Key（Key 以 Windows DPAPI 加密保存），再用 seedance_doctor 复测。'
    : '';
  return new RunnerError(`${message}${hint}`, { action });
}

/**
 * Invoke one runner action in a child PowerShell.
 *
 * Child output goes to temp files instead of pipes: the values are read back
 * after exit, which keeps the bridge working in environments where spawning a
 * child with piped stdio is denied, and avoids any console codepage guesswork
 * (a redirected handle is UTF-8).
 */
function runRunner(action, params, { timeoutSeconds = 120 } = {}) {
  return new Promise((resolve, reject) => {
    let command;
    try {
      command = buildCommand(action, params);
    } catch (error) {
      reject(error instanceof ValidationError || error instanceof RunnerError ? error : new ValidationError(String(error.message ?? error)));
      return;
    }
    const base = path.join(os.tmpdir(), `aiwork-mcp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    const outPath = `${base}.out`;
    const errPath = `${base}.err`;
    let outFd = -1;
    let errFd = -1;
    let settled = false;
    let timer = null;
    let child = null;
    let spawnError = null;

    const closeHandles = () => {
      if (outFd >= 0) { try { fs.closeSync(outFd); } catch { /* already closed */ } outFd = -1; }
      if (errFd >= 0) { try { fs.closeSync(errFd); } catch { /* already closed */ } errFd = -1; }
    };
    const removeFiles = () => {
      for (const file of [outPath, errPath]) {
        try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
      }
    };
    const kill = () => {
      try { if (child && !child.killed) child.kill('SIGKILL'); } catch { /* already gone */ }
    };
    // Single exit point: the output files are read before any error is built, so
    // the runner's own diagnosis always reaches the caller.
    const settle = (handle) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      closeHandles();
      const stdout = readUtf8(outPath);
      const stderr = readUtf8(errPath);
      removeFiles();
      handle(stdout, stderr);
    };

    try {
      outFd = fs.openSync(outPath, 'w');
      errFd = fs.openSync(errPath, 'w');
    } catch (error) {
      closeHandles();
      removeFiles();
      reject(new RunnerError(`无法创建 runner 输出临时文件：${error.message}`, { action }));
      return;
    }

    try {
      child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        cwd: path.dirname(RUNNER),
        stdio: ['ignore', outFd, errFd],
        windowsHide: true,
        env: process.env,
      });
    } catch (error) {
      settle(() => reject(new RunnerError(`无法启动 PowerShell（${POWERSHELL}）：${error.message}`, { action })));
      return;
    }

    const deadlineMs = (timeoutSeconds + WAIT_GRACE_SECONDS) * 1000;
    timer = setTimeout(() => {
      kill();
      settle((stdout, stderr) => reject(new RunnerError(
        [
          `runner 超过 ${Math.round(deadlineMs / 1000)} 秒未返回，已终止本地进程。`,
          tailText(stderr) || tailText(stdout) ? `最后输出：${tailText(stderr) || tailText(stdout)}` : '',
          '网关侧任务可能仍在运行：请用 seedance_status 查询原 task_id，切勿重复提交。',
        ].filter(Boolean).join(' '),
        { action },
      )));
    }, deadlineMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.on('error', (error) => {
      spawnError = error;
      kill();
      settle(() => reject(new RunnerError(`无法执行 PowerShell runner：${error.message}（${POWERSHELL}）`, { action })));
    });
    child.on('close', (code) => {
      if (settled) {
        kill();
        return;
      }
      settle((stdout, stderr) => {
        if (spawnError) {
          reject(new RunnerError(`无法执行 PowerShell runner：${spawnError.message}（${POWERSHELL}）`, { action }));
          return;
        }
        if (code === 0) {
          const payload = parseRunnerJson(stdout);
          if (payload) {
            resolve(payload);
            return;
          }
        }
        reject(classifyRunnerFailure(stderr, stdout, code, action));
      });
    });
  });
}

/* ------------------------------ task helpers ------------------------------- */

function taskState(task) {
  return String(task?.status ?? '').trim().toLowerCase();
}

function unwrapTask(payload) {
  if (!isPlainObject(payload)) return {};
  if (isPlainObject(payload.task)) return payload.task;
  if (isPlainObject(payload.data)) {
    return isPlainObject(payload.data.task) ? payload.data.task : payload.data;
  }
  return payload;
}

function contentUrlOf(task) {
  for (const key of ['content_url', 'video_url', 'resource_uri']) {
    const value = task?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function errorOf(task) {
  if (!isPlainObject(task)) return null;
  const nested = isPlainObject(task.error) ? task.error.message : task.error;
  return nested ?? (typeof task.message === 'string' ? task.message : null) ?? null;
}

async function fetchStatus(taskId, ctx) {
  const raw = await ctx.run('status', [['TaskId', taskId]], 90);
  const task = unwrapTask(raw);
  return {
    task_id: taskId,
    status: taskState(task) || 'unknown',
    progress: task?.progress ?? null,
    content_url: contentUrlOf(task),
    error: errorOf(task),
    detail: task,
  };
}

function submitParams(args) {
  return [
    ['Prompt', takeString(args, 'prompt', { required: true, maxLength: MAX_PROMPT_CHARS })],
    ['Duration', takeInt(args, 'duration', { min: 2, max: 15, def: 5 })],
    ['Resolution', takeEnum(args, 'resolution', RESOLUTIONS, '720p')],
    ['Ratio', takeEnum(args, 'ratio', RATIOS, '16:9')],
    ['ImagePath', takeList(args, 'image_paths')],
    ['VideoPath', takeList(args, 'video_paths')],
    ['ImageAssetId', takeList(args, 'image_asset_ids', { maxLength: 200 })],
    ['VideoAssetId', takeList(args, 'video_asset_ids', { maxLength: 200 })],
    ['IdempotencyKey', takeString(args, 'idempotency_key', { maxLength: 200 })],
  ];
}

// Local asset upload happens inside the runner's submit, so a submission needs
// a materially larger budget than a status poll.
const SUBMIT_BUDGET_SECONDS = 300;

async function submitOnce(params, ctx) {
  const result = await ctx.run('submit', params, SUBMIT_BUDGET_SECONDS);
  const taskId = String(result?.task_id ?? result?.id ?? '').trim();
  if (!taskId) {
    throw new RunnerError('网关未返回任务 ID。请先用 seedance_doctor 检查网关与额度；不要盲目重试扣费提交。', { action: 'submit' });
  }
  return { taskId, idempotencyKey: result?.idempotency_key ?? null, status: String(result?.status ?? 'submitted') };
}

/* -------------------------------- tool handlers ---------------------------- */

async function callDoctor(args, ctx) {
  const params = [];
  const base = takeString(args, 'gateway_base_url', { maxLength: 300 });
  if (base) params.push(['GatewayBaseUrl', base]);
  const timeoutSeconds = takeInt(args, 'timeout_seconds', { min: 5, max: 300, def: 60 });
  const result = await ctx.run('doctor', params, timeoutSeconds);
  return {
    ok: true,
    checked_at: new Date().toISOString(),
    gateway: result?.gateway ?? null,
    health: result?.health ?? null,
    model_count: result?.model_count ?? null,
    note: '网关可达且凭据可用；本调用未创建任务、未消耗积分。',
  };
}

async function callUpload(args, ctx) {
  const assetPath = takeString(args, 'path', { required: true, maxLength: 1000 });
  const result = await ctx.run('upload', [['AssetPath', assetPath]], 180);
  const assetId = result?.asset_id ?? result?.id ?? null;
  if (!assetId) throw new RunnerError('网关未返回素材 ID。', { action: 'upload' });
  return { asset_id: String(assetId), source_path: assetPath };
}

async function callSubmit(args, ctx) {
  const params = submitParams(args);
  const { taskId, idempotencyKey, status } = await submitOnce(params, ctx);
  return {
    task_id: taskId,
    status,
    idempotency_key: idempotencyKey,
    note: '任务已提交（本次调用只提交一次）。用 seedance_wait 或 seedance_status 跟进，completed 后 seedance_download 下载。',
  };
}

async function callStatus(args, ctx) {
  const taskId = takeString(args, 'task_id', { required: true, maxLength: 200 });
  const { detail, ...rest } = await fetchStatus(taskId, ctx);
  return rest;
}

async function callWait(args, ctx) {
  const taskId = takeString(args, 'task_id', { required: true, maxLength: 200 });
  const timeoutSeconds = Math.min(
    takeInt(args, 'timeout_seconds', { min: 5, max: MAX_WAIT_SECONDS, def: DEFAULT_WAIT_SECONDS }),
    MAX_WAIT_SECONDS,
  );
  const intervalSeconds = takeInt(args, 'interval_seconds', { min: 1, max: 30, def: 3 });
  const params = [['TaskId', taskId], ['TimeoutSeconds', timeoutSeconds], ['IntervalSeconds', intervalSeconds]];
  try {
    const task = unwrapTask(await ctx.run('wait', params, timeoutSeconds));
    return {
      task_id: taskId,
      status: taskState(task) || 'completed',
      finished: true,
      content_url: contentUrlOf(task),
      progress: task?.progress ?? null,
      detail: task,
    };
  } catch (error) {
    // A wait that ran out of budget is not a task failure. Re-check once so a
    // completed job is never reported as pending, and a running job is reported
    // as running rather than as an error that would invite a resubmission.
    const recheck = await ctx.recheck(taskId).catch(() => null);
    if (recheck && recheck.status !== 'unknown') {
      if (NON_TERMINAL.has(recheck.status)) {
        return {
          task_id: taskId,
          status: recheck.status,
          finished: false,
          waited_seconds: timeoutSeconds,
          note: `已等待 ${timeoutSeconds} 秒仍未完成，任务未被丢弃。请再次调用 seedance_wait 继续等待；不要重新提交。`,
        };
      }
      return {
        task_id: taskId,
        status: recheck.status,
        finished: recheck.status === 'completed',
        content_url: recheck.content_url,
        error: recheck.error,
        detail: recheck.detail,
      };
    }
    throw error;
  }
}

async function callDownload(args, ctx) {
  const taskId = takeString(args, 'task_id', { required: true, maxLength: 200 });
  const outputPath = takeString(args, 'output_path', { maxLength: 1000 });
  if (outputPath && !path.isAbsolute(outputPath)) {
    throw new ValidationError(`output_path 必须是绝对路径（例如 ${path.resolve('.')}\\result.mp4）。`);
  }
  const params = [['TaskId', taskId]];
  if (outputPath) params.push(['OutputPath', outputPath]);
  const result = await ctx.run('download', params, 600);
  const destination = String(result?.download_path ?? outputPath);
  let sizeBytes = null;
  try { sizeBytes = fs.statSync(destination).size; } catch { /* the runner's own path is authoritative */ }
  return {
    task_id: taskId,
    status: 'completed',
    local_path: destination,
    size_bytes: sizeBytes,
  };
}

async function callGenerate(args, ctx) {
  const params = submitParams(args);
  const outputPath = takeString(args, 'output_path', { maxLength: 1000 });
  const timeoutSeconds = Math.min(
    takeInt(args, 'timeout_seconds', { min: 10, max: MAX_WAIT_SECONDS, def: DEFAULT_GENERATE_WAIT_SECONDS }),
    MAX_WAIT_SECONDS,
  );
  const intervalSeconds = takeInt(args, 'interval_seconds', { min: 1, max: 30, def: 3 });
  const submitted = await submitOnce(params, ctx);
  const waited = await callWait({ task_id: submitted.taskId, timeout_seconds: timeoutSeconds, interval_seconds: intervalSeconds }, ctx);
  if (!waited.finished) {
    return {
      task_id: submitted.taskId,
      status: waited.status,
      finished: false,
      idempotency_key: submitted.idempotencyKey,
      note: `任务仍在进行（本次已等待 ${timeoutSeconds} 秒）。继续用 seedance_wait 跟进；同一 idempotency_key 重发本调用也安全，但不要用新键重新提交。`,
    };
  }
  if (waited.status !== 'completed') {
    return {
      task_id: submitted.taskId,
      status: waited.status,
      finished: true,
      error: waited.error ?? null,
      note: '任务已结束但未成功，没有生成视频文件。',
    };
  }
  const downloaded = await callDownload({ task_id: submitted.taskId, ...(outputPath ? { output_path: outputPath } : {}) }, ctx);
  return { ...downloaded, finished: true, status: 'completed', idempotency_key: submitted.idempotencyKey };
}

/* ------------------------------- tool catalog ------------------------------ */

const generationProperties = {
  prompt: { type: 'string', maxLength: MAX_PROMPT_CHARS, description: '视频生成提示词（必填）。' },
  image_paths: {
    type: 'array',
    items: { type: 'string' },
    description: '本地首帧/参考图的显式绝对路径。绝不扫描目录，未列出的文件不会被上传。',
  },
  video_paths: {
    type: 'array',
    items: { type: 'string' },
    description: '本地参考视频的显式绝对路径（网关单文件上限 32 MiB）。',
  },
  image_asset_ids: { type: 'array', items: { type: 'string' }, description: 'seedance_upload 返回的图片素材 ID，复用可避免重复上传。' },
  video_asset_ids: { type: 'array', items: { type: 'string' }, description: 'seedance_upload 返回的视频素材 ID。' },
  duration: { type: 'integer', minimum: 2, maximum: 15, default: 5, description: '时长（秒），默认 5。' },
  resolution: { type: 'string', enum: RESOLUTIONS, default: '720p', description: '分辨率，默认 720p。' },
  ratio: { type: 'string', enum: RATIOS, default: '16:9', description: '画幅比例，默认 16:9。' },
  idempotency_key: {
    type: 'string',
    maxLength: 200,
    description: '幂等键。重试同一请求必须复用同一个键以避免二次扣费；缺省时由 runner 生成 GUID。',
  },
};

const generationSchema = {
  type: 'object',
  properties: generationProperties,
  required: ['prompt'],
  additionalProperties: false,
};

const TOOLS = [
  {
    name: 'seedance_doctor',
    title: '检查网关与凭据',
    description: '只读检查 /health 和鉴权后的 /v1/models：验证网关、Key 和模型可用，不创建任务、不消耗积分。首次生成前或连接报错后必须先调用。',
    inputSchema: {
      type: 'object',
      properties: {
        gateway_base_url: {
          type: 'string',
          maxLength: 300,
          description: '可选覆盖（例如本地 http://127.0.0.1:8787/v1）；缺省使用 %APPDATA%\\AIWork\\seedance-skill.json。',
        },
        timeout_seconds: { type: 'integer', minimum: 5, maximum: 300, default: 60 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: callDoctor,
  },
  {
    name: 'seedance_upload',
    title: '上传单个素材',
    description: '上传一个显式指定的本地图片/视频，返回 asset_id 供多次生成复用（POST /v1/assets）。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', maxLength: 1000, description: '待上传文件的绝对路径。' } },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: callUpload,
  },
  {
    name: 'seedance_submit',
    title: '提交生成任务',
    description: '提交一次 Seedance 生成任务并立即返回 task_id（会消耗 Work 积分）。只提交一次：跟进请用 wait/status，不要因等待而重复调用。',
    inputSchema: generationSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: callSubmit,
  },
  {
    name: 'seedance_status',
    title: '查询任务状态',
    description: '单次查询任务状态，不等待、无副作用、不计费。',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', maxLength: 200, description: 'seedance_submit 返回的任务 ID。' } },
      required: ['task_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: callStatus,
  },
  {
    name: 'seedance_wait',
    title: '等待任务完成',
    description: '轮询等待任务结束。等待超时不是错误：返回 finished=false 与当前状态，请再次调用续等。默认上限 45 秒，以适配 MCP 客户端 60 秒的默认工具超时。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', maxLength: 200 },
        timeout_seconds: { type: 'integer', minimum: 5, maximum: MAX_WAIT_SECONDS, default: DEFAULT_WAIT_SECONDS, description: '本次最多等待秒数。' },
        interval_seconds: { type: 'integer', minimum: 1, maximum: 30, default: 3 },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: callWait,
  },
  {
    name: 'seedance_download',
    title: '下载成品视频',
    description: '仅在任务 completed 后下载 MP4；未提供 output_path 时保存到本机 Downloads（先写 .part 再改名）。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', maxLength: 200 },
        output_path: { type: 'string', maxLength: 1000, description: '可选的本地绝对路径；省略时保存到 Downloads。' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: callDownload,
  },
  {
    name: 'seedance_generate',
    title: '提交、等待并下载',
    description: '按 submit → wait → download 编排；默认保存到本机 Downloads。等待超时返回 finished=false 并保留 task_id，可安全续等。调用方须把 toolCallTimeoutMs 设为 timeout_seconds+60 秒以上。',
    inputSchema: {
      type: 'object',
      properties: {
        ...generationProperties,
        output_path: { type: 'string', maxLength: 1000, description: '可选：完成后的绝对路径；省略时保存到 Downloads。' },
        timeout_seconds: { type: 'integer', minimum: 10, maximum: MAX_WAIT_SECONDS, default: DEFAULT_GENERATE_WAIT_SECONDS },
        interval_seconds: { type: 'integer', minimum: 1, maximum: 30, default: 3 },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: callGenerate,
  },
];

const TOOL_INDEX = new Map(TOOLS.map((tool) => [tool.name, tool]));

/* -------------------------------- protocol --------------------------------- */

const inFlight = new Map();
let stdinClosed = false;

// A client may close stdin while a call is still running (the runner can take
// minutes). Writing a reply into a closed pipe is impossible, but abandoning an
// in-flight call right after it was submitted would lose a charged task_id, so
// exit only once the last request has settled (bounded by the linger below).
function maybeExit() {
  if (stdinClosed && inFlight.size === 0) process.exit(0);
}

function onStdinEnd() {
  if (stdinClosed) return;
  stdinClosed = true;
  if (inFlight.size > 0) {
    log(`stdin closed with ${inFlight.size} request(s) in flight; lingering up to 30s`);
    setTimeout(() => process.exit(0), 30000);
  }
  maybeExit();
}

function send(message) {
  const payload = `${JSON.stringify(message)}\n`;
  process.stdout.write(payload, (error) => {
    if (error) log(`stdout write failed: ${error.message}`);
  });
}

function reply(id, result) {
  send({ jsonrpc: JSONRPC, id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: JSONRPC, id: id ?? null, error: { code, message } });
}

function publicTools() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: `${tool.title}。${tool.description}`,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }));
}

function errorText(error) {
  if (error instanceof ValidationError) return `参数不合法：${error.message}`;
  if (error instanceof RunnerError) {
    return error.taskId ? `${error.message}（task_id=${error.taskId}）` : error.message;
  }
  return `AI Work MCP 内部错误：${error?.message ?? String(error)}`;
}

function textResult(text, isError) {
  return { content: [{ type: 'text', text }], isError };
}

async function executeTool(id, name, rawArgs) {
  const tool = TOOL_INDEX.get(name);
  if (!tool) {
    reply(id, textResult(`Unknown tool: ${name}`, true));
    return;
  }
  let args;
  try {
    args = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
    if (!isPlainObject(args)) throw new ValidationError('arguments 必须是 JSON 对象。');
  } catch (error) {
    reply(id, textResult(errorText(error), true));
    return;
  }
  const abort = { cancelled: false };
  inFlight.set(id, { name, abort });
  const ctx = {
    abort,
    run: (action, params, timeoutSeconds) => runRunner(action, params, { timeoutSeconds }),
    recheck: (taskId) => fetchStatus(taskId, ctx),
  };
  try {
    const value = await tool.handler(args, ctx);
    if (abort.cancelled) return;
    reply(id, textResult(JSON.stringify(value), false));
  } catch (error) {
    if (abort.cancelled) return;
    log(`tools/call ${name} failed: ${error?.message ?? error}`);
    reply(id, textResult(errorText(error), true));
  } finally {
    inFlight.delete(id);
    maybeExit();
  }
}

function onMessage(message) {
  if (Array.isArray(message) || !isPlainObject(message)) {
    replyError(message?.id ?? null, ERR_INVALID_REQUEST, 'MCP stdio 不支持 JSON-RPC 批量消息。');
    return;
  }
  const { id, method, params } = message;
  const isRequest = method !== undefined && id !== undefined && id !== null;
  if (method === undefined) {
    if (isRequest) replyError(id, ERR_INVALID_REQUEST, 'Invalid Request: missing method');
    return;
  }
  switch (method) {
    case 'initialize': {
      const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
      reply(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : FALLBACK_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'AI Work Seedance 视频生成。顺序：seedance_doctor 确认网关 → seedance_submit 提交一次 → seedance_wait/status 跟进 → completed 后 seedance_download 下载。等待超时不等于失败，绝不因等待而用新键重新提交。',
      });
      return;
    }
    case 'notifications/initialized':
      return;
    case 'notifications/cancelled': {
      const entry = inFlight.get(params?.requestId);
      if (entry) {
        entry.abort.cancelled = true;
        log(`cancel requested for ${String(params?.requestId)} (${entry.name})`);
      }
      return;
    }
    case 'ping':
      if (isRequest) reply(id, {});
      return;
    case 'tools/list': {
      if (!isRequest) return;
      // Single page, no cursor: the catalog is fixed at startup.
      reply(id, { tools: publicTools() });
      return;
    }
    case 'tools/call': {
      if (!isRequest) return;
      const name = typeof params?.name === 'string' ? params.name : '';
      void executeTool(id, name, params?.arguments);
      return;
    }
    default:
      if (isRequest) replyError(id, ERR_METHOD_NOT_FOUND, `Method not found: ${method}`);
      return;
  }
}

/* -------------------------------- transport -------------------------------- */

function drainLines(chunk, state, handle) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  if (state.buffer.length > MAX_LINE_BYTES) {
    log(`stdin exceeded ${MAX_LINE_BYTES} bytes; dropping buffer`);
    state.buffer = Buffer.alloc(0);
    return;
  }
  let index = state.buffer.indexOf(0x0a);
  while (index !== -1) {
    let end = index;
    if (end > 0 && state.buffer[end - 1] === 0x0d) end -= 1;
    const line = state.buffer.subarray(0, end).toString('utf8').trim();
    state.buffer = state.buffer.subarray(index + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        replyError(null, ERR_PARSE, 'Parse error');
      }
    }
    index = state.buffer.indexOf(0x0a);
  }
}

function main() {
  if (!fs.existsSync(RUNNER)) log(`runner not found: ${RUNNER}`);
  if (!fs.existsSync(POWERSHELL)) log(`powershell not found: ${POWERSHELL} (set AIWORK_PS_EXE to override)`);
  const state = { buffer: Buffer.alloc(0) };
  process.stdin.on('data', (chunk) => drainLines(chunk, state, onMessage));
  process.stdin.on('error', (error) => log(`stdin error: ${error.message}`));
  process.stdin.on('end', onStdinEnd);
  process.stdin.on('close', onStdinEnd);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  process.on('uncaughtException', (error) => log(`uncaught: ${error?.stack ?? error}`));
  process.on('unhandledRejection', (reason) => log(`unhandled rejection: ${reason}`));
  log(`ready (runner=${RUNNER}, powershell=${POWERSHELL}, node=${process.version})`);
}

export {
  TOOLS,
  ValidationError,
  RunnerError,
  buildCommand,
  parseRunnerJson,
  psArray,
  psQuote,
  publicTools,
  runRunner,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
