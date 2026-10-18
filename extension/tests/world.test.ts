import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QUOTA_DEFAULTS, type QuotaConfigSection } from '../src/config.ts';
import type { SecretBackend } from '../src/accounts.ts';
import { QuotaWorld } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';

const dirs: string[] = [];
const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-world-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 假的秘密存储：形状与 `ctx.storeSecret/secret` 一样，值留在内存里。 */
function fakeSecrets(): SecretBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    read: (name) => store.get(name) ?? '',
    write: (name, value) => {
      store.set(name, value);
    },
  };
}

interface Caught {
  url: string;
  auth: string;
}

/** 线上那天的读数：5 小时窗口 13.2/14、周窗口 5.8/35、本月还剩 54.66。 */
function stubCommandCode(caught: Caught[] = [], opts: { credits?: number; fiveUsed?: number } = {}): void {
  const credits = {
    credits: { monthlyCredits: opts.credits ?? 54.66 },
    windowLimits: {
      fiveHour: { used: opts.fiveUsed ?? 13.2, cap: 14, exceeded: false, resetAt: Date.now() + 42 * 60_000 },
      weekly: { used: 5.8, cap: 35, exceeded: false, resetAt: Date.now() + 3 * 86_400_000 },
    },
  };
  const subscription = { success: true, data: { planId: 'individual-goat', status: 'active', currentPeriodEnd: '2026-10-16T07:45:21.000Z' } };
  const models = {
    data: [{ id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', context_length: 1_000_000, supported_endpoints: ['/chat/completions'] }],
  };
  vi.stubGlobal(
    'fetch',
    (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      caught.push({ url, auth: String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '') });
      const body = url.includes('/models')
        ? models
        : url.includes('/subscriptions')
          ? subscription
          : url.includes('/whoami')
            ? { user: { email: 'test@gmail.com' } }
            : credits;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch,
  );
}

function world(
  overrides: Partial<QuotaConfigSection> = {},
  secrets = fakeSecrets(),
  botDir = home(),
): { world: QuotaWorld; secrets: ReturnType<typeof fakeSecrets>; persist: ReturnType<typeof vi.fn> } {
  // 真的 persist 会写回同一个对象，这里照做：面板保存后 view.config 应当就是新值。
  const cfg: QuotaConfigSection = { ...QUOTA_DEFAULTS, enabled: true, commandcodeKey: 'test-key', hermesHome: home(), ...overrides };
  const persist = vi.fn((patch: Partial<QuotaConfigSection>) => {
    Object.assign(cfg, patch);
  });
  const w = new QuotaWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    dataDir: home(),
    botDir,
    secrets,
    persist,
  });
  return { world: w, secrets, persist };
}

/** 造一份桌宠目录：`<root>/companion`（botDir）+ `<root>/providers/<名字>/{config.json,.env}`。 */
function petWithEndpoints(
  endpoints: Array<{ name: string; key: string; baseUrl?: string }>,
  activeProvider?: string,
): string {
  const root = home();
  const botDir = join(root, 'companion');
  mkdirSync(botDir, { recursive: true });
  for (const endpoint of endpoints) {
    const dir = join(root, 'providers', endpoint.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        kind: 'openai-responses-compat',
        baseUrl: endpoint.baseUrl ?? 'https://api.commandcode.ai/provider/v1',
        secret: 'CORTICO_KEY_COMMANDCODE',
      }),
    );
    writeFileSync(join(dir, '.env'), `CORTICO_KEY_COMMANDCODE=${endpoint.key}\n`);
  }
  writeFileSync(join(botDir, 'config.json'), JSON.stringify({ activeProvider: activeProvider ?? endpoints[0]?.name ?? '' }));
  return botDir;
}

describe('QuotaWorld', () => {
  it('挂载时取数，越过阈值只发一条提醒事件', async () => {
    stubCommandCode();
    const host = new FakeHost();
    const { world: w } = world({ alertPercent: 80 });
    await w.start(host.asHost());

    expect(host.pushed.length).toBe(1);
    const event = host.pushed[0]!;
    expect(event.type).toBe('quota.window');
    expect(event.origin).toBe('internal');
    expect(event.text).toContain('[用量]');
    expect(event.text).toContain('5 小时窗口');
    expect(event.text).toContain('重置');
    expect(event.meta?.window).toBe('fiveHour');

    await w.refresh({ reason: 'poll' });
    await w.refresh({ reason: 'poll', force: true });
    expect(host.pushed.length).toBe(1);
    await w.stop();
  });

  it('关掉提醒、或阈值 0，都只更新读数', async () => {
    stubCommandCode();
    const off = new FakeHost();
    const { world: a } = world({ alerts: false });
    await a.start(off.asHost());
    expect(off.pushed).toEqual([]);
    await a.stop();

    const zero = new FakeHost();
    const { world: b } = world({ alertPercent: 0 });
    await b.start(zero.asHost());
    expect(zero.pushed).toEqual([]);
    await b.stop();
  });

  it('没有密钥：读数是「取不到」，不抛错也不发提醒', async () => {
    vi.stubEnv('COMMANDCODE_API_KEY', '');
    vi.stubEnv('COMMAND_CODE_API_KEY', '');
    const host = new FakeHost();
    const { world: w } = world({ commandcodeKey: '', authFile: join(home(), 'no-such-auth.json') });
    await w.start(host.asHost());
    const view = w.view('zh');
    expect(view.quota.ok).toBe(false);
    expect(view.quota.reason).toContain('no key for commandcode');
    expect(view.key.source).toBe('none');
    expect(host.pushed).toEqual([]);
    expect(w.envPromptVars()['quota.summary']).toContain('取不到');
    await w.stop();
  });

  it('环境提示词、工具、控制台声明都按契约给出', async () => {
    stubCommandCode();
    const { world: w } = world();
    await w.start(new FakeHost().asHost());

    const summary = w.envPromptVars()['quota.summary']!;
    expect(summary).toContain('GOAT');
    expect(summary).toContain('$54.66');
    expect(summary).toContain('5 小时窗口 $13.20/$14.00');

    const toolNames = w.tools().map((tool) => tool.name);
    expect(toolNames).toEqual(['quota_status', 'quota_hermes']);
    const status = await w.tools()[0]!.handler({}, {} as never);
    expect(String(status)).toContain('Command Code 套餐额度');
    const hermes = await w.tools()[1]!.handler({ days: 3 }, {} as never);
    expect(String(hermes)).toContain('Hermes 用量（最近 3 天）');

    const decl = w.console('zh');
    expect(decl.label).toBe('用量额度');
    expect(decl.lamps?.map((l) => l.state)).toEqual(['loading', 'offline']);
    expect(decl.badges?.map((b) => b.label)).toEqual(['套餐', '账号', '5 小时', '本周', '本月余额']);
    expect(decl.panels?.map((p) => p.id)).toEqual(['quota', 'settings']);
    // 不再把配置交给框架的配置页（那边是 400ms 防抖即时保存）
    expect(decl.config ?? []).toEqual([]);
    await w.stop();
  });

  it('面板数据面：state 给读数，refresh 强制重取，未知方法报错', async () => {
    stubCommandCode();
    const { world: w } = world();
    await w.start(new FakeHost().asHost());
    const decl = w.console('zh');
    const state = (await decl.invoke!('quota', 'state', [{ days: 3 }])) as Record<string, any>;
    expect(state.quota.planLabel).toBe('GOAT');
    expect(state.hermes.days).toBe(3);
    expect(state.config.alertPercent).toBe(80);
    expect(state.key.source).toBe('config');
    expect(state.config.source).toBe('commandcode');
    expect(state.sources.find((s: { id: string }) => s.id === 'commandcode').current).toBe(true);
    await expect(decl.invoke!('quota', 'nope', [])).rejects.toThrow('unknown method');
    await expect(decl.invoke!('other', 'state', [])).rejects.toThrow('unknown panel');
    await w.stop();
  });

  it('模型清单取自供应商的模型接口', async () => {
    stubCommandCode();
    const { world: w } = world();
    await w.start(new FakeHost().asHost());
    await w.refresh({ reason: 'panel', force: true });
    const models = w.view('zh').models;
    expect(models.map((m) => m.id)).toEqual(['deepseek/deepseek-v4.1-flash']);
    expect(models[0]?.contextLength).toBe(1_000_000);
    await w.stop();
  });

  it('加账号：先真取一次数，密钥进秘密存储，账号表里只有尾四位', async () => {
    const caught: Caught[] = [];
    stubCommandCode(caught);
    const { world: w, secrets } = world();
    const decl = w.console('zh');
    await w.start(new FakeHost().asHost());

    const after = (await decl.invoke!('quota', 'addAccount', [{ label: '备用', key: 'user_abcdef123456' }])) as Record<string, any>;
    expect(after.accounts.list.length).toBe(1);
    const account = after.accounts.list[0]!;
    expect(account.label).toBe('备用');
    expect(account.keyHint).toBe('••••3456');
    expect(account.email).toBe('test@gmail.com');
    expect(account.planLabel).toBe('GOAT');
    expect(account.active).toBe(true);
    expect(secrets.store.get('QUOTA_COMMANDCODE_1')).toBe('user_abcdef123456');
    // 账号生效后取数用账号里那把 Key，界面上也认得出是哪个账号
    expect(caught.some((c) => c.auth === 'Bearer user_abcdef123456')).toBe(true);
    expect(after.key.accountLabel).toBe('备用');
    await w.stop();
  });

  it('加账号时 Key 不对：抛错，不写账号表也不写秘密存储', async () => {
    vi.stubGlobal(
      'fetch',
      (async () => new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
    );
    const { world: w, secrets } = world();
    const decl = w.console('zh');
    await w.start(new FakeHost().asHost());
    await expect(decl.invoke!('quota', 'addAccount', [{ label: '坏的', key: 'nope' }])).rejects.toThrow(/rejected the key/);
    expect(w.view('zh').accounts.list).toEqual([]);
    expect(secrets.store.size).toBe(0);
    await w.stop();
  });

  it('切账号与删账号：提醒游标按账号分开算', async () => {
    stubCommandCode();
    const { world: w } = world({ alertPercent: 80 });
    const host = new FakeHost();
    const decl = w.console('zh');
    await w.start(host.asHost());
    expect(host.pushed.length).toBe(1);

    const one = (await decl.invoke!('quota', 'addAccount', [{ label: 'A', key: 'key_aaaaaaaaaaaa' }])) as Record<string, any>;
    const idA = one.accounts.list[0]!.id;
    // 换账号后同一个窗口会再提醒一次：游标按账号分开
    expect(host.pushed.length).toBe(2);

    const two = (await decl.invoke!('quota', 'addAccount', [{ label: 'B', key: 'key_bbbbbbbbbbbb' }])) as Record<string, any>;
    expect(two.accounts.list.length).toBe(2);
    expect(two.accounts.activeId).toBe(two.accounts.list[1]!.id);
    expect(host.pushed.length).toBe(3);

    const back = (await decl.invoke!('quota', 'activateAccount', [{ id: idA }])) as Record<string, any>;
    expect(back.accounts.activeId).toBe(idA);

    const afterRemove = (await decl.invoke!('quota', 'removeAccount', [{ id: idA }])) as Record<string, any>;
    expect(afterRemove.accounts.list.map((a: { label: string }) => a.label)).toEqual(['B']);
    expect(afterRemove.accounts.activeId).toBe(afterRemove.accounts.list[0].id);
    await w.stop();
  });

  it('账号表落盘：重建实例后还在，且当前账号仍是那把 Key', async () => {
    stubCommandCode();
    const dataDir = home();
    const secrets = fakeSecrets();
    const first = new QuotaWorld({
      cfg: { ...QUOTA_DEFAULTS, enabled: true, commandcodeKey: 'test-key', hermesHome: home() },
      timezone: 'Asia/Shanghai',
      dataDir,
      botDir: home(),
      secrets,
      persist: vi.fn(),
    });
    await first.start(new FakeHost().asHost());
    const decl = first.console('zh');
    await decl.invoke!('quota', 'addAccount', [{ label: '主号', key: 'user_zzzzzzzz9999' }]);
    await first.stop();

    const caught: Caught[] = [];
    stubCommandCode(caught);
    const again = new QuotaWorld({
      cfg: { ...QUOTA_DEFAULTS, enabled: true, commandcodeKey: 'test-key', hermesHome: home() },
      timezone: 'Asia/Shanghai',
      dataDir,
      botDir: home(),
      secrets,
      persist: vi.fn(),
    });
    await again.start(new FakeHost().asHost());
    const view = again.view('zh');
    expect(view.accounts.list.map((a) => a.label)).toEqual(['主号']);
    expect(view.key.source).toBe('account:主号');
    expect(caught[0]?.auth).toBe('Bearer user_zzzzzzzz9999');
    await again.stop();
  });

  it('供应商切到没实现的家：不发请求，读数写明原因，上一家的价目与模型也清掉', async () => {
    const caught: Caught[] = [];
    stubCommandCode(caught);
    const { world: w } = world({ source: 'openai' });
    await w.start(new FakeHost().asHost());
    const view = w.view('zh');
    expect(view.quota.ok).toBe(false);
    expect(view.quota.reason).toContain('source not implemented: openai');
    expect(view.sources.find((s) => s.id === 'openai')?.current).toBe(true);
    expect(view.sources.find((s) => s.id === 'commandcode')?.implemented).toBe(true);
    expect(view.pricing).toBeNull();
    expect(view.models).toEqual([]);
    expect(w.envPromptVars()['quota.summary']).toContain('还没有实现');
    expect(caught.filter((c) => c.url.includes('/alpha/'))).toEqual([]);
    await w.stop();
  });

  it('桌宠端点自动记成账号：邮箱/套餐/尾四位都填上，密钥用端点里那把', async () => {
    const caught: Caught[] = [];
    stubCommandCode(caught);
    const botDir = petWithEndpoints([{ name: 'CommandCode', key: 'user_native_key_abcd' }]);
    // 配置里没有 Key：证明读数确实用的端点那把
    const { world: w } = world({ commandcodeKey: '' }, fakeSecrets(), botDir);
    await w.start(new FakeHost().asHost());

    const view = w.view('zh');
    expect(view.accounts.list.length).toBe(1);
    const account = view.accounts.list[0]!;
    expect(account.origin).toBe('native');
    expect(account.email).toBe('test@gmail.com');
    expect(account.label).toBe('test@gmail.com');
    expect(account.planLabel).toBe('GOAT');
    expect(account.keyHint).toBe('••••abcd');
    expect(account.active).toBe(true);
    expect(account.inUse).toBe(true);
    expect(caught.some((c) => c.auth === 'Bearer user_native_key_abcd')).toBe(true);
    await w.stop();
  });

  it('两个端点 = 两个账号：切过去就用那一把密钥，桌宠在用哪个也标出来', async () => {
    const caught: Caught[] = [];
    stubCommandCode(caught);
    const botDir = petWithEndpoints(
      [
        { name: 'CommandCode', key: 'user_first_key_0001' },
        { name: 'CommandCode-2', key: 'user_second_key_0002' },
      ],
      'CommandCode-2',
    );
    const { world: w } = world({ commandcodeKey: '' }, fakeSecrets(), botDir);
    const decl = w.console('zh');
    await w.start(new FakeHost().asHost());

    const first = w.view('zh');
    expect(first.accounts.list.map((a) => a.keyHint)).toEqual(['••••0001', '••••0002']);
    // 第一个被发现的端点是当前账号；桌宠在用的是第二个
    expect(first.accounts.list.find((a) => a.keyHint === '••••0002')?.inUse).toBe(true);
    expect(first.accounts.list.find((a) => a.keyHint === '••••0001')?.active).toBe(true);

    const secondId = first.accounts.list.find((a) => a.keyHint === '••••0002')!.id;
    const switched = (await decl.invoke!('quota', 'activateAccount', [{ id: secondId }])) as Record<string, any>;
    expect(switched.accounts.activeId).toBe(secondId);
    expect(switched.key.detail).toBe('CORTICO_KEY_COMMANDCODE');
    expect(caught.some((c) => c.auth === 'Bearer user_second_key_0002')).toBe(true);
    await w.stop();
  });

  it('面板保存走 saveSettings：一次写回、当场夹紧，不经过配置页的即时保存', async () => {
    stubCommandCode();
    const { world: w, persist } = world();
    const decl = w.console('zh');
    await w.start(new FakeHost().asHost());

    const after = (await decl.invoke!('quota', 'saveSettings', [
      { alerts: true, alertPercent: '150', pollMinutes: '-5', hermesDays: '30' },
    ])) as Record<string, any>;
    expect(persist).toHaveBeenCalledWith({ alerts: true, alertPercent: 100, pollMinutes: 0, hermesDays: 30 });
    expect(after.config.alertPercent).toBe(100);
    expect(after.config.pollMinutes).toBe(0);
    expect(after.config.hermesDays).toBe(30);
    await w.stop();
  });

  it('配置不交给框架：没有配置组，改成自己画的「配置」页签', async () => {
    stubCommandCode();
    const { world: w } = world();
    await w.start(new FakeHost().asHost());
    const decl = w.console('zh');
    expect(decl.config ?? []).toEqual([]);
    expect(decl.panels?.map((p) => p.id)).toEqual(['quota', 'settings']);
    expect(decl.panels?.[1]?.title).toBe('配置');
    // 两个页签共用同一份数据面
    const fromSettings = (await decl.invoke!('settings', 'state', [{ days: 7 }])) as Record<string, any>;
    expect(fromSettings.quota.planLabel).toBe('GOAT');
    const saved = (await decl.invoke!('settings', 'saveSettings', [{ source: 'openai', hermesHome: ' C:/h ' }])) as Record<string, any>;
    expect(saved.config.source).toBe('openai');
    expect(saved.config.hermesHome).toBe('C:/h');
    await w.stop();
  });

  it('进界面不取数：state 只回手上这份，refresh 才拉网络', async () => {
    const caught: Caught[] = [];
    stubCommandCode(caught);
    const { world: w } = world();
    await w.start(new FakeHost().asHost());
    const decl = w.console('zh');

    const before = caught.length;
    const state = (await decl.invoke!('quota', 'state', [{ days: 7 }])) as Record<string, any>;
    expect(state.quota.ok).toBe(true);
    expect(caught.length).toBe(before);

    await decl.invoke!('quota', 'refresh', [{ days: 7 }]);
    expect(caught.length).toBeGreaterThan(before);
    await w.stop();
  });

  it('没有任何端点、也没手动加时：账号栏空着，取数走默认来源', async () => {
    stubCommandCode();
    const { world: w } = world();
    await w.start(new FakeHost().asHost());
    const view = w.view('zh');
    expect(view.accounts.list).toEqual([]);
    expect(view.quota.ok).toBe(true);
    expect(view.key.source).toBe('config');
    await w.stop();
  });
});
