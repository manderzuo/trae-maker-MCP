#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_HELPER = path.resolve(HERE, '../scripts/gateway-config.ps1');
const POWERSHELL = process.env.AIWORK_PS_EXE
  || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalize(baseUrl) {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${psQuote(CONFIG_HELPER)}`,
    `Normalize-AiWorkGatewayBaseUrl -BaseUrl ${psQuote(baseUrl)}`,
  ].join('; ');
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || `PowerShell exited ${result.status}`);
  return result.stdout.replace(/^\uFEFF/, '').trim();
}

function getDefaultBaseUrl() {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${psQuote(CONFIG_HELPER)}`,
    'Get-AiWorkDefaultGatewayBaseUrl',
  ].join('; ');
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || `PowerShell exited ${result.status}`);
  return result.stdout.replace(/^\uFEFF/, '').trim();
}

const cases = [
  ['migrates the legacy public host', 'https://www.gemstory.cn/v1', 'https://api.gemstory.cn/v1'],
  ['migrates legacy admin URL to the API path', 'https://www.gemstory.cn/admin', 'https://api.gemstory.cn/v1'],
  ['adds the API path to the canonical host root', 'https://api.gemstory.cn', 'https://api.gemstory.cn/v1'],
  ['preserves unrelated custom gateways', 'https://gateway.example.net/custom/v1', 'https://gateway.example.net/custom/v1'],
  ['does not rewrite lookalike hostnames', 'https://www.gemstory.cn.attacker.example/v1', 'https://www.gemstory.cn.attacker.example/v1'],
];

assert.equal(getDefaultBaseUrl(), 'https://api.gemstory.cn/v1', 'the installer default points to the official public API');
console.log('PASS installer default points to the official public API');

for (const [label, input, expected] of cases) {
  assert.equal(normalize(input), expected, label);
  console.log(`PASS ${label}`);
}

console.log(`\nAll ${cases.length} gateway URL checks passed.`);
