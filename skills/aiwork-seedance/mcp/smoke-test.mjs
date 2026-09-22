#!/usr/bin/env node
/*
 * Offline self-test for the AI Work Seedance MCP bridge.
 *
 * It creates no video task, spends no Work credits and opens no gateway
 * connection: with no %APPDATA%\AIWork config present, `seedance_doctor`
 * exercises the real spawn/file-UTF-8/error-classification path and must come
 * back as an actionable isError result. Uses file redirection on every stdio
 * handle so it also runs where spawning a child with pipes is denied.
 *
 *   node mcp/smoke-test.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildCommand, parseRunnerJson, psQuote, publicTools } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.mjs');

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
  }
}

/* ------------------------------- pure checks ------------------------------- */

console.log('1. PowerShell command construction');
check('single quote is doubled', psQuote("C:\\a').b") === "'C:\\a'').b'");
const injected = buildCommand('submit', [
  ['Prompt', "hi'); Write-Output 'PWNED; $('whoami')`"],
  ['ImagePath', ['C:\\a b.png', "C:\\it's.png", 'C:\\x & y | z.png']],
  ['Duration', 8],
]);
check('command keeps the runner as the last statement', injected.includes("& '") && !injected.endsWith(';'));
check(
  'injected quote stays inside a literal',
  injected.includes("'hi''); Write-Output ''PWNED; $(''whoami'')`'"),
  injected.slice(injected.indexOf('-Prompt'), injected.indexOf('-Duration')),
);
check('array binds as a PowerShell array literal', injected.includes("-ImagePath @('"));
check('numeric param is unquoted', injected.includes('-Duration 8'));
const sneaky = buildCommand('submit', [['Prompt', "line1'; Exit-PowerShell; ('line2"]]);
check('newline + quote breakout stays literal', sneaky.includes("'line1''; Exit-PowerShell; (''line2'"));
check('params are never duplicated', (sneaky.match(/ -Prompt /g) ?? []).length === 1);
let overflow = null;
try {
  buildCommand('submit', [['Prompt', 'x'.repeat(16000)], ['ImagePath', Array.from({ length: 16 }, (_, i) => `C:\\frames\\${'y'.repeat(1500)}-${i}.png`)]]);
} catch (error) {
  overflow = error;
}
check('oversized command line refused before spawn', overflow !== null, 'no throw');

console.log('\n2. runner output parsing');
check('plain JSON parses', parseRunnerJson('{"a":1}').a === 1);
check('leading warning line is skipped', parseRunnerJson('WARNING: something\n{"a":2}').a === 2);
check('non-JSON returns null', parseRunnerJson('boom: not json') === null);
check('empty returns null', parseRunnerJson('   ') === null);

console.log('\n3. tool catalog shape');
const tools = publicTools();
check('seven tools exposed', tools.length === 7, `got ${tools.length}`);
check('every tool has description + inputSchema', tools.every((t) => t.description && t.inputSchema?.type === 'object'));
check('tool names are snake_case and unique', new Set(tools.map((t) => t.name)).size === tools.length && tools.every((t) => /^seedance_[a-z_]+$/.test(t.name)));
check('only read-only tools claim readOnlyHint', tools.filter((t) => t.annotations?.readOnlyHint).every((t) => ['seedance_doctor', 'seedance_status', 'seedance_wait'].includes(t.name)));

/* ------------------------------ protocol probe ----------------------------- */

console.log('\n4. stdio handshake against the real bridge');

const base = path.join(os.tmpdir(), `aiwork-smoke-${process.pid}`);
const inPath = `${base}.in`;
const outPath = `${base}.out`;
const errPath = `${base}.err`;
const messages = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'seedance_doctor', arguments: { timeout_seconds: 5 } } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'seedance_status', arguments: { task_id: '' } } },
  { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'seedance_download', arguments: { task_id: 'video-x', output_path: 'relative\\nope.mp4' } } },
  { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'seedance_submit', arguments: { prompt: 'a cat', duration: 99 } } },
  { jsonrpc: '2.0', id: 7, method: 'bogus/method' },
  { jsonrpc: '2.0', id: 8, method: 'ping' },
];
for (const handle of [inPath, outPath, errPath]) { try { fs.rmSync(handle, { force: true }); } catch { /* fresh */ } }
fs.writeFileSync(inPath, `${messages.map((m) => JSON.stringify(m)).join('\n')}\n`);

const inFd = fs.openSync(inPath, 'r');
const outFd = fs.openSync(outPath, 'w');
const errFd = fs.openSync(errPath, 'w');

const child = spawn(process.execPath, [SERVER], { stdio: [inFd, outFd, errFd], cwd: HERE, windowsHide: true });
child.on('error', (error) => {
  console.error(`cannot spawn server: ${error.message}`);
  process.exit(1);
});
child.on('close', (code) => {
  for (const fd of [inFd, outFd, errFd]) { try { fs.closeSync(fd); } catch { /* closed */ } }
  const lines = fs.readFileSync(outPath, 'utf8').replace(/^\uFEFF/, '').split('\n').filter((line) => line.trim());
  const stderrText = fs.readFileSync(errPath, 'utf8');
  for (const file of [inPath, outPath, errPath]) { try { fs.rmSync(file, { force: true }); } catch { /* tmp */ } }

  const replies = new Map();
  const errors = new Map();
  for (const line of lines) {
    let parsed;
    try { parsed = JSON.parse(line); } catch { console.log(`  FAIL  non-JSON stdout line: ${line.slice(0, 80)}`); failed += 1; continue; }
    if (parsed.result !== undefined) replies.set(parsed.id, parsed.result);
    if (parsed.error !== undefined) errors.set(parsed.id, parsed.error);
  }

  const init = replies.get(1);
  check('initialize succeeded over stdio', !!init?.capabilities?.tools, JSON.stringify(init ?? errors.get(1) ?? null).slice(0, 120));
  check('protocol version echoed', init?.protocolVersion === '2025-06-18', init?.protocolVersion);
  check('serverInfo present', init?.serverInfo?.name === 'aiwork-seedance');
  const listed = replies.get(2)?.tools ?? [];
  check('tools/list returns 7 tools', listed.length === 7, `got ${listed.length}`);

  const doctor = replies.get(3);
  const doctorText = doctor?.content?.[0]?.text ?? '';
  check('doctor ran the real runner', !!doctor && doctor.isError === true, `isError=${doctor?.isError}`);
  check('doctor reports no gateway configured', /AIWORK|网关|install\.cmd/i.test(doctorText), doctorText.slice(0, 140));
  check('doctor never leaks a key', !/api_key_protected|Bearer /i.test(doctorText));

  const emptyTask = replies.get(4);
  check('empty task_id rejected locally', emptyTask?.isError === true && /task_id|TaskId/.test(emptyTask?.content?.[0]?.text ?? ''), emptyTask?.content?.[0]?.text);
  const relativePath = replies.get(5);
  check('relative output_path rejected', relativePath?.isError === true && /绝对路径/.test(relativePath?.content?.[0]?.text ?? ''), relativePath?.content?.[0]?.text);
  const badDuration = replies.get(6);
  check('duration=99 rejected before any spend', badDuration?.isError === true && /2-15/.test(badDuration?.content?.[0]?.text ?? ''), badDuration?.content?.[0]?.text);
  check('unknown method returns -32601', errors.get(7)?.code === -32601, JSON.stringify(errors.get(7)));
  check('ping answered with empty result', replies.get(8) && Object.keys(replies.get(8)).length === 0);
  check('server stayed alive for the whole script', code === 0, `exit=${code}`);
  if (stderrText && process.env.AIWORK_MCP_VERBOSE) console.log(`  stderr: ${stderrText.trim().split('\n').slice(0, 8).join(' | ')}`);

  console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
});
