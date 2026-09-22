#!/usr/bin/env node
/*
 * End-to-end test of the MCP bridge against a local fake gateway.
 *
 * No real gateway, no API key, no Work credits are involved. It proves the parts
 * that only exist at runtime: tool dispatch, PowerShell array binding, UTF-8
 * round-tripping, the task lifecycle (submit -> wait -> download), and the
 * rule that an unfinished wait is reported as running rather than as a failure.
 *
 *   node mcp/integration-test.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { startFakeGateway } from './fake-gateway.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwork-it-'));
const API_KEY = 'test-key-only';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const firstFrame = path.join(TMP, '首帧 first.png');
const secondFrame = path.join(TMP, "it's-second.png");
fs.writeFileSync(firstFrame, PNG_1X1);
fs.writeFileSync(secondFrame, PNG_1X1);

let passed = 0;
let failed = 0;
const allReplyText = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` -> ${String(detail).slice(0, 240)}` : ''}`);
  }
}

function rpc(id, method, params) {
  return params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params };
}

/**
 * Drive one phase: a fresh bridge process, file-redirected stdio (no pipes),
 * sequential requests. Returns { replies, errors, text }.
 */
function phase(label, messages, env) {
  return new Promise((resolve, reject) => {
    const base = path.join(TMP, `${label}-${Date.now().toString(36)}`);
    const inPath = `${base}.in`;
    const outPath = `${base}.out`;
    const errPath = `${base}.err`;
    fs.writeFileSync(inPath, `${messages.map((m) => JSON.stringify(m)).join('\n')}\n`);
    const inFd = fs.openSync(inPath, 'r');
    const outFd = fs.openSync(outPath, 'w');
    const errFd = fs.openSync(errPath, 'w');
    const child = spawn(process.execPath, [SERVER], {
      stdio: [inFd, outFd, errFd],
      cwd: HERE,
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    child.on('error', reject);
    child.on('close', (code) => {
      for (const fd of [inFd, outFd, errFd]) { try { fs.closeSync(fd); } catch { /* closed */ } }
      const lines = fs.readFileSync(outPath, 'utf8').replace(/^\uFEFF/, '').split('\n').filter((l) => l.trim());
      const stderrText = fs.readFileSync(errPath, 'utf8');
      const replies = new Map();
      const errors = new Map();
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.result !== undefined) replies.set(parsed.id, parsed.result);
          if (parsed.error !== undefined) errors.set(parsed.id, parsed.error);
        } catch {
          check(`${label}: every stdout line is JSON`, false, line.slice(0, 120));
        }
      }
      const text = [...replies.values()].map((r) => (typeof r?.content?.[0]?.text === 'string' ? r.content[0].text : JSON.stringify(r ?? null))).join('\n');
      allReplyText.push(text);
      for (const file of [inPath, outPath, errPath]) { try { fs.rmSync(file, { force: true }); } catch { /* tmp */ } }
      resolve({ replies, errors, text, stderrText, code });
    });
  });
}

function payload(result) {
  const text = result?.content?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

const common = { AIWORK_API_KEY: API_KEY };

/* --------------------------- gateway: immediate done --------------------------- */

const ready = await startFakeGateway({ pollsBeforeComplete: 0, apiKey: API_KEY });
const busy = await startFakeGateway({ pollsBeforeComplete: 100000, apiKey: API_KEY });

try {
  console.log(`fake gateways: ready=${ready.baseUrl} busy=${busy.baseUrl}`);

  console.log('\n1. handshake + doctor against a live gateway');
  const p1 = await phase('doctor', [
    rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'it', version: '0' } }),
    rpc(2, 'tools/list'),
    rpc(3, 'tools/call', { name: 'seedance_doctor', arguments: {} }),
  ], { ...common, AIWORK_GATEWAY_BASE_URL: ready.baseUrl });
  check('bridge answered initialize', p1.replies.get(1)?.capabilities?.tools !== undefined);
  check('7 tools listed', p1.replies.get(2)?.tools?.length === 7, p1.replies.get(2)?.tools?.length);
  const doctor = payload(p1.replies.get(3));
  check('doctor ok', doctor.ok === true, JSON.stringify(doctor).slice(0, 200));
  check('doctor reports the gateway', String(doctor.gateway).startsWith('http://127.0.0.1:'), doctor.gateway);
  check('health payload surfaced', doctor.health?.status === 'ok', JSON.stringify(doctor.health));
  check('no task created by doctor', ready.requests.every((r) => !String(r.path).includes('/videos/generations')));

  console.log('\n2. submit with two local images (array binding through the whole chain)');
  const p2 = await phase('submit', [
    rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'it', version: '0' } }),
    rpc(2, 'tools/call', {
      name: 'seedance_submit',
      arguments: {
        prompt: '一只猫在弹钢琴，暖色聚光灯，镜头缓慢推进',
        image_paths: [firstFrame, secondFrame],
        duration: 6,
        resolution: '1080p',
        ratio: '9:16',
        idempotency_key: 'it-fixed-key-001',
      },
    }),
  ], { ...common, AIWORK_GATEWAY_BASE_URL: ready.baseUrl });
  const submit = payload(p2.replies.get(2));
  check('submit returned a task_id', submit.task_id === 'video-fake-001', JSON.stringify(submit).slice(0, 200));
  check('idempotency key echoed', submit.idempotency_key === 'it-fixed-key-001', submit.idempotency_key);
  const assetPosts = ready.requests.filter((r) => r.path === '/v1/assets');
  check('both images uploaded as separate assets', assetPosts.length === 2, assetPosts.length);
  const genPosts = ready.requests.filter((r) => r.path === '/v1/videos/generations');
  check('exactly one generation POST (no double charge)', genPosts.length === 1, genPosts.length);
  check('Idempotency-Key header sent', genPosts[0]?.idempotencyKey === 'it-fixed-key-001', genPosts[0]?.idempotencyKey);
  check('all gateway calls carried a Bearer token', ready.requests.every((r) => r.authorizationPresent), JSON.stringify(ready.requests.map((r) => [r.path, r.authorizationPresent])));
  check('gateway received both asset ids', JSON.stringify(ready.state.submittedPayload?.image_asset_ids) === '["asset-1","asset-2"]', JSON.stringify(ready.state.submittedPayload?.image_asset_ids));
  check('CJK prompt survived the round trip', ready.state.submittedPayload?.prompt === '一只猫在弹钢琴，暖色聚光灯，镜头缓慢推进', ready.state.submittedPayload?.prompt);
  check('duration/resolution/ratio passed through', ready.state.submittedPayload?.duration === 6 && ready.state.submittedPayload?.resolution === '1080p' && ready.state.submittedPayload?.ratio === '9:16', JSON.stringify(ready.state.submittedPayload));
  const uploaded = ready.state.assets;
  check('gateway saw both upload bodies', uploaded.length === 2, uploaded.length);
  check('CJK filename survived', uploaded.some((a) => a.filename === '首帧 first.png'), JSON.stringify(uploaded.map((a) => a.filename)));
  check("apostrophe filename survived", uploaded.some((a) => a.filename === "it's-second.png"), JSON.stringify(uploaded.map((a) => a.filename)));
  check('mime type derived from extension', uploaded.every((a) => a.mime_type === 'image/png'), JSON.stringify(uploaded.map((a) => a.mime_type)));
  check('uploaded bytes are byte-identical to the source', uploaded.every((a) => Buffer.from(a.data_base64 ?? '', 'base64').equals(PNG_1X1)));

  console.log('\n3. wait on a finished task');
  const p3 = await phase('wait-ready', [
    rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'it', version: '0' } }),
    rpc(2, 'tools/call', { name: 'seedance_wait', arguments: { task_id: 'video-fake-001', timeout_seconds: 20, interval_seconds: 1 } }),
  ], { ...common, AIWORK_GATEWAY_BASE_URL: ready.baseUrl });
  const waited = payload(p3.replies.get(2));
  check('wait reports finished', waited.finished === true && waited.status === 'completed', JSON.stringify(waited).slice(0, 200));
  check('wait exposes the content url', String(waited.content_url).includes('/content'), waited.content_url);

  console.log('\n4. download writes the MP4 and reports its size');
  const target = path.join(TMP, 'out', '成品 video.mp4');
  const p4 = await phase('download', [
    rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'it', version: '0' } }),
    rpc(2, 'tools/call', { name: 'seedance_download', arguments: { task_id: 'video-fake-001', output_path: target } }),
  ], { ...common, AIWORK_GATEWAY_BASE_URL: ready.baseUrl });
  const downloaded = payload(p4.replies.get(2));
  check('download reported completed', downloaded.status === 'completed', JSON.stringify(downloaded).slice(0, 200));
  check('mp4 exists on disk', fs.existsSync(downloaded.local_path ?? target));
  const bytesOnDisk = fs.existsSync(target) ? fs.readFileSync(target) : Buffer.alloc(0);
  check('no .part residue', !fs.existsSync(`${target}.part`));
  check('downloaded bytes match the gateway', bytesOnDisk.length > 12 && bytesOnDisk.subarray(4, 8).toString('latin1') === 'ftyp', `${bytesOnDisk.length} bytes`);
  check('size_bytes matches the file', downloaded.size_bytes === bytesOnDisk.length, `${downloaded.size_bytes} vs ${bytesOnDisk.length}`);

  console.log('\n5. a long-running task must NOT look like a failure');
  const p5 = await phase('wait-busy', [
    rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'it', version: '0' } }),
    rpc(2, 'tools/call', { name: 'seedance_wait', arguments: { task_id: 'video-fake-001', timeout_seconds: 6, interval_seconds: 2 } }),
  ], { ...common, AIWORK_GATEWAY_BASE_URL: busy.baseUrl });
  const busyWait = payload(p5.replies.get(2));
  check('unfinished wait is not an error', p5.replies.get(2)?.isError !== true, JSON.stringify(p5.replies.get(2)).slice(0, 200));
  check('unfinished wait sets finished=false', busyWait.finished === false, JSON.stringify(busyWait).slice(0, 200));
  check('unfinished wait keeps task_id', busyWait.task_id === 'video-fake-001', busyWait.task_id);
  check('unfinished wait forbids resubmission', /不要重新提交/.test(busyWait.note ?? ''), busyWait.note);
  check('the busy gateway saw no new generation', busy.requests.filter((r) => r.path === '/v1/videos/generations').length === 0);

  console.log('\n6. generate orchestrates submit -> wait -> download');
  const genTarget = path.join(TMP, 'gen.mp4');
  const p6 = await phase('generate', [
    rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'it', version: '0' } }),
    rpc(2, 'tools/call', { name: 'seedance_generate', arguments: { prompt: '海浪拍打礁石，慢动作', output_path: genTarget, timeout_seconds: 30, interval_seconds: 1 } }),
  ], { ...common, AIWORK_GATEWAY_BASE_URL: ready.baseUrl });
  const generated = payload(p6.replies.get(2));
  check('generate completed', generated.status === 'completed' && generated.finished === true, JSON.stringify(generated).slice(0, 200));
  check('generate downloaded the file', fs.existsSync(genTarget));
  check('generate reused the task id', generated.task_id === 'video-fake-001', generated.task_id);
  check('generate sent a fresh idempotency key', genPosts.length === 1 && ready.state.idempotencyKeys.length === 2 && ready.state.idempotencyKeys[1] !== 'it-fixed-key-001', JSON.stringify(ready.state.idempotencyKeys));

  const p6Default = await phase('generate-default-download', [
    rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'it', version: '0' } }),
    rpc(2, 'tools/call', { name: 'seedance_generate', arguments: { prompt: '默认下载测试', timeout_seconds: 30, interval_seconds: 1 } }),
  ], { ...common, AIWORK_GATEWAY_BASE_URL: ready.baseUrl, USERPROFILE: TMP });
  const generatedDefault = payload(p6Default.replies.get(2));
  check('generate without output_path downloads by default', generatedDefault.finished === true && fs.existsSync(generatedDefault.local_path ?? ''), JSON.stringify(generatedDefault).slice(0, 200));
  check('default destination is Downloads', String(generatedDefault.local_path).startsWith(path.join(TMP, 'Downloads')), generatedDefault.local_path);
  check('no media URL is exposed as final result', !('content_url' in generatedDefault), JSON.stringify(generatedDefault).slice(0, 200));

  console.log('\n7. concurrent status calls');
  const p7 = await phase('concurrent', [
    rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'it', version: '0' } }),
    rpc(2, 'tools/call', { name: 'seedance_status', arguments: { task_id: 'video-fake-001' } }),
    rpc(3, 'tools/call', { name: 'seedance_status', arguments: { task_id: 'video-fake-001' } }),
    rpc(4, 'tools/call', { name: 'seedance_status', arguments: { task_id: 'video-nope' } }),
  ], { ...common, AIWORK_GATEWAY_BASE_URL: ready.baseUrl });
  check('both concurrent calls answered', p7.replies.has(2) && p7.replies.has(3), `${[...p7.replies.keys()].join(',')}`);
  check('replies carry their own ids', payload(p7.replies.get(2)).task_id === 'video-fake-001');
  check('unknown task still answers', p7.replies.has(4), JSON.stringify([...p7.replies.keys()]));

  console.log('\n8. secret hygiene');
  check('API key never appears in any reply', !allReplyText.join('\n').includes(API_KEY));
  check('no Authorization header text in replies', !/Authorization|Bearer\s/i.test(allReplyText.join('\n')));
} finally {
  await ready.stop();
  await busy.stop();
  for (const file of fs.readdirSync(TMP)) {
    try { fs.rmSync(path.join(TMP, file), { force: true, recursive: true }); } catch { /* tmp */ }
  }
}

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
