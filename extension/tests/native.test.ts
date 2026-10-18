import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { endpointsFor, hostMatches, listEndpoints, parseEnv, providersRoots, readEndpoint } from '../src/native.ts';

const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-native-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 造一份桌宠的目录：`<root>/companion`（botDir）与 `<root>/providers/<名字>`。 */
function layout(endpoints: Array<{ name: string; baseUrl: string; secret: string; key: string }>): { botDir: string; root: string } {
  const root = tmp();
  const botDir = join(root, 'companion');
  mkdirSync(botDir, { recursive: true });
  for (const e of endpoints) {
    const dir = join(root, 'providers', e.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ kind: 'openai-responses-compat', baseUrl: e.baseUrl, secret: e.secret }));
    writeFileSync(join(dir, '.env'), `${e.secret}=${e.key}\n`);
  }
  return { botDir, root };
}

describe('.env 解析', () => {
  it('KEY=VALUE、引号、注释、CRLF、空行都能吃', () => {
    const env = parseEnv(['# 注释', '', 'A=1', 'B="two words"', "C='three'", 'D=', 'E = 4 ', 'NOEQUALS'].join('\r\n'));
    expect(env).toEqual({ A: '1', B: 'two words', C: 'three', D: '', E: '4' });
  });
});

describe('桌宠端点（原生凭证）', () => {
  it('providers 目录在 botDir 旁边与里面都认', () => {
    const { botDir, root } = layout([{ name: 'CommandCode', baseUrl: 'https://api.commandcode.ai/provider/v1', secret: 'K', key: 'key-1' }]);
    expect(providersRoots(botDir)).toEqual([join(root, 'providers'), join(botDir, 'providers')]);
    expect(listEndpoints(botDir).map((e) => e.name)).toEqual(['CommandCode']);
  });

  it('读出一个端点：变量名、baseUrl、密钥都取到', () => {
    const { botDir, root } = layout([{ name: 'CommandCode', baseUrl: 'https://api.commandcode.ai/provider/v1', secret: 'CORTICO_KEY_COMMANDCODE', key: 'user_abcdef123456' }]);
    const endpoint = readEndpoint(join(root, 'providers', 'CommandCode'));
    expect(endpoint).not.toBeNull();
    expect(endpoint!.name).toBe('CommandCode');
    expect(endpoint!.secretName).toBe('CORTICO_KEY_COMMANDCODE');
    expect(endpoint!.key).toBe('user_abcdef123456');
    expect(endpoint!.baseUrl).toContain('commandcode.ai');
  });

  it('不像端点、没写 secret、.env 缺那一行：都不会炸，密钥算空', () => {
    const root = tmp();
    const botDir = join(root, 'companion');
    mkdirSync(botDir, { recursive: true });
    expect(readEndpoint(botDir)).toBeNull(); // 没有 config.json

    const bare = join(root, 'providers', 'bare');
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, 'config.json'), '{ 半截 json');
    expect(readEndpoint(bare)).toBeNull(); // config 坏了

    const noSecret = join(root, 'providers', 'noSecret');
    mkdirSync(noSecret, { recursive: true });
    writeFileSync(join(noSecret, 'config.json'), JSON.stringify({ kind: 'coo', baseUrl: 'https://api.deepseek.com' }));
    writeFileSync(join(noSecret, '.env'), 'OTHER=x\n');
    const endpoint = readEndpoint(noSecret)!;
    expect(endpoint.secretName).toBe('');
    expect(endpoint.key).toBe('');
  });

  it('只挑指向这一家的端点', () => {
    const { botDir } = layout([
      { name: 'CommandCode', baseUrl: 'https://api.commandcode.ai/provider/v1', secret: 'K1', key: 'k1' },
      { name: 'CommandCode-2', baseUrl: 'https://api.commandcode.ai/provider/v1', secret: 'K2', key: 'k2' },
      { name: 'deepseek', baseUrl: 'https://api.deepseek.com', secret: 'K3', key: 'k3' },
    ]);
    const ours = endpointsFor(botDir, 'commandcode.ai');
    expect(ours.map((e) => e.name)).toEqual(['CommandCode', 'CommandCode-2']);
    expect(listEndpoints(botDir).length).toBe(3);
    expect(hostMatches('https://api.commandcode.ai/provider/v1', 'commandcode.ai')).toBe(true);
    expect(hostMatches('https://api.deepseek.com', 'commandcode.ai')).toBe(false);
    expect(hostMatches('不是 URL', 'commandcode.ai')).toBe(false);
  });
});
