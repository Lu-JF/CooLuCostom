// @vitest-environment jsdom
/**
 * 面板渲染的验收：拿一份假读数喂进去，看它有没有把该画的东西画出来。
 * 这里用的 ctx 是按 `ConsolePanelContext` 写的替身，只实现这个面板真正用到的那几个原语——
 * 形状与真宿主一致，所以这里过得了的调用序列，装进 Coopanion 也不会因为用法错而炸。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import bundle from '../src/console/client.ts';
import type { QuotaView } from '../src/view-types.ts';

const view = (overrides: Partial<QuotaView> = {}): QuotaView => ({
  quota: {
    ok: true,
    reason: null,
    keySource: 'envFile',
    baseUrl: 'https://api.commandcode.ai',
    account: 'test@gmail.com',
    planId: 'individual-goat',
    planLabel: 'GOAT',
    planStatus: 'active',
    periodStart: '2026-09-16T07:45:21.000Z',
    periodEnd: '2026-10-16T07:45:21.000Z',
    monthlyCredits: 54.66,
    purchasedCredits: 0,
    freeCredits: 0,
    monthlyAllowance: 70,
    monthlyUsedPercent: 21.9,
    fiveHour: { used: 13.2, cap: 14, exceeded: false, resetAt: Date.now() + 42 * 60_000, usedPercent: 94.3 },
    weekly: { used: 5.8, cap: 35, exceeded: false, resetAt: Date.now() + 3 * 86_400_000, usedPercent: 16.6 },
    fetchedAt: Date.now(),
  },
  hermes: {
    available: true,
    reason: null,
    dbPath: 'C:/Users/user/AppData/Local/hermes/state.db',
    via: 'sqlite',
    days: 7,
    models: [
      { model: 'deepseek/deepseek-v4.1-flash', provider: 'commandcode', calls: 726, inputTokens: 2_884_247, outputTokens: 920_779, cacheReadTokens: 117_101_165, cacheWriteTokens: 0, reasoningTokens: 521_192, totalTokens: 121_427_383, costUsd: 0 },
    ],
    daily: [{ day: '2026-10-13', calls: 726, totalTokens: 121_427_383 }],
    total: { model: '', provider: '', calls: 726, inputTokens: 2_884_247, outputTokens: 920_779, cacheReadTokens: 117_101_165, cacheWriteTokens: 0, reasoningTokens: 521_192, totalTokens: 121_427_383, costUsd: 0 },
    sessions: 28,
    firstSeen: 1_787_000_000,
    lastSeen: 1_791_893_000,
  },
  key: { source: 'envFile', detail: 'C:/Users/user/AppData/Local/hermes/.env', accountLabel: null },
  config: {
    source: 'commandcode',
    alerts: true,
    alertPercent: 80,
    pollMinutes: 10,
    hermesDays: 7,
    hermesHome: 'C:/Users/user/AppData/Local/hermes',
    envFile: 'C:/Users/user/AppData/Local/hermes/.env',
    authFile: '',
    baseUrl: 'https://api.commandcode.ai',
    keyHint: '',
    monthlyAllowanceUsd: 70,
  },
  language: 'zh',
  alerted: [],
  accounts: {
    activeId: 'acc_main',
    list: [
      {
        id: 'acc_main',
        label: 'test@gmail.com',
        source: 'commandcode',
        origin: 'native',
        keyHint: '••••3456',
        email: 'test@gmail.com',
        planId: 'individual-goat',
        planLabel: 'GOAT',
        active: true,
        inUse: true,
        addedAt: Date.now() - 86_400_000,
        lastCheckedAt: Date.now() - 60_000,
        lastError: null,
      },
      {
        id: 'acc_backup',
        label: '备用',
        source: 'commandcode',
        origin: 'manual',
        keyHint: '••••9999',
        email: 'other@example.com',
        planId: 'individual-go',
        planLabel: 'Go',
        active: false,
        inUse: false,
        addedAt: Date.now(),
        lastCheckedAt: null,
        lastError: 'command code returned HTTP 401',
      },
    ],
  },
  sources: [
    { id: 'commandcode', label: 'Command Code', implemented: true, needs: 'API Key', plan: '额度走 /alpha/billing/*', current: true },
    { id: 'openai', label: 'OpenAI', implemented: false, needs: '管理密钥（Admin Key）才能读组织账单', plan: '候选接口 GET /v1/organization/costs；普通 Key 读不了。', current: false },
  ],
  models: [{ id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextLength: 1_000_000, endpoints: ['/chat/completions'] }],
  pricing: {
    planId: 'individual-goat',
    planLabel: 'GOAT',
    slug: 'goat',
    url: 'https://commandcode.ai/docs/plans/goat',
    fetchedAt: Date.now(),
    via: 'live',
    reason: null,
    models: [
      {
        name: 'DeepSeek V4.1 Flash',
        context: '1M',
        intelligence: '56.0',
        inputPerM: 0.15,
        outputPerM: 0.6,
        cacheReadPerM: 0.015,
        cacheWritePerM: null,
        caps: ['+1'],
        requests5h: 51300,
        requestsWeek: 100000,
        requestsMonth: 256000,
        monthlyCredits: 80,
        free: false,
      },
      {
        name: 'Laguna S 2.1',
        context: '256K',
        intelligence: null,
        inputPerM: 0,
        outputPerM: 0,
        cacheReadPerM: 0,
        cacheWritePerM: null,
        caps: [],
        requests5h: null,
        requestsWeek: null,
        requestsMonth: null,
        monthlyCredits: null,
        free: true,
      },
    ],
  },
  ...overrides,
});

interface Harness {
  root: HTMLElement;
  invoke: ReturnType<typeof vi.fn>;
  setConfig: ReturnType<typeof vi.fn>;
}

/** 假 ctx：DOM 原语照真宿主的形状给，数据面记下调用。 */
function harness(payload: QuotaView | (() => Promise<QuotaView>), panel: 'quota' | 'settings' = 'quota'): Harness {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const invoke = vi.fn(async () => (typeof payload === 'function' ? await payload() : payload));
  const setConfig = vi.fn(async () => 'saved');

  const el = (tag: string, cls?: string | null, text?: string | null): HTMLElement => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  };

  const ui = {
    h: el,
    esc: (s: unknown) => String(s),
    sheet: (opts: { title: string; desc?: string }) => {
      const wrap = el('section', 'sheet');
      wrap.appendChild(el('h3', null, opts.title));
      const body = el('div', 'sheet-body');
      wrap.appendChild(body);
      return { el: wrap, body, note: el('div'), desc: null };
    },
    rowbar: () => el('div', 'rowbar'),
    section: (title: string) => el('div', 'section', title),
    actions: () => el('div', 'actions'),
    button: (label: string, opts?: { onClick?: () => void }) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (opts?.onClick) b.addEventListener('click', opts.onClick);
      return b;
    },
    kv: (rows: Array<{ k: string; v: unknown }>) => {
      const table = el('table', 'kv');
      for (const row of rows) {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td');
        td1.textContent = row.k;
        const td2 = document.createElement('td');
        if (row.v instanceof HTMLElement) td2.appendChild(row.v);
        else td2.textContent = String(row.v ?? '');
        tr.append(td1, td2);
        table.appendChild(tr);
      }
      return table;
    },
    statgrid: (items: Array<{ k: string; v: string | number; unit?: string }> = []) => {
      const grid = el('div', 'statgrid');
      for (const item of items) grid.appendChild(el('div', 'stat', `${item.k}=${item.v}${item.unit ?? ''}`));
      return grid;
    },
    progress: (opts?: { value?: number; max?: number; label?: string; format?: (v: number, m: number) => string }) => {
      const wrap = el('div', 'progress');
      const label = el('span', 'label', opts?.label ?? '');
      const read = el('span', 'read', opts?.format ? opts.format(opts.value ?? 0, opts.max ?? 1) : '');
      wrap.append(label, read);
      return { el: wrap, value: opts?.value ?? 0, max: opts?.max ?? 1, setValue: () => {}, setLabel: () => {} };
    },
    table: (opts?: { head?: string[] }) => {
      const wrap = el('div', 'tablewrap');
      const table = document.createElement('table');
      if (opts?.head) {
        const thead = document.createElement('thead');
        const tr = document.createElement('tr');
        for (const h of opts.head) tr.appendChild(el('th', null, h));
        thead.appendChild(tr);
        table.appendChild(thead);
      }
      const body = document.createElement('tbody');
      table.appendChild(body);
      wrap.appendChild(table);
      return {
        el: wrap,
        body,
        addRow: (cells: unknown[]) => {
          const tr = document.createElement('tr');
          for (const cell of cells) {
            const td = document.createElement('td');
            if (cell instanceof HTMLElement) {
              td.appendChild(cell);
            } else if (cell && typeof cell === 'object') {
              // 真宿主两种都给：{ text } 与 { el }（塞按钮、标签那种格）
              const el = (cell as { el?: unknown }).el;
              if (el instanceof HTMLElement) td.appendChild(el);
              else td.textContent = String((cell as { text?: unknown }).text ?? '');
            } else {
              td.textContent = String(cell ?? '');
            }
            tr.appendChild(td);
          }
          body.appendChild(tr);
          return tr;
        },
        clear: (empty?: string) => {
          body.replaceChildren();
          if (empty) body.appendChild(el('tr', 'placeholder', empty));
        },
      };
    },
    checkbox: (label: string, opts?: { checked?: boolean; onChange?: (v: boolean) => void }) => {
      const wrap = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(opts?.checked);
      input.addEventListener('change', () => opts?.onChange?.(input.checked));
      wrap.append(input, document.createTextNode(label));
      return { el: wrap, input, get checked() { return input.checked; }, setChecked: (v: boolean) => { input.checked = v; } };
    },
    input: (opts?: { value?: string; type?: string; onInput?: (v: string) => void }) => {
      const input = document.createElement('input');
      input.type = opts?.type ?? 'text';
      input.value = opts?.value ?? '';
      input.addEventListener('input', () => opts?.onInput?.(input.value));
      return input;
    },
    select: (opts?: { options?: Array<string | { value: string; label?: string }>; onChange?: (v: string) => void }) => {
      const sel = document.createElement('select');
      if (opts?.onChange) sel.addEventListener('change', () => opts.onChange?.(sel.value));
      for (const item of opts?.options ?? []) {
        const value = typeof item === 'string' ? item : item.value;
        const label = typeof item === 'string' ? item : item.label ?? item.value;
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        sel.appendChild(option);
      }
      return sel;
    },
    textarea: () => document.createElement('textarea'),
    field: (label: string, control: HTMLElement) => {
      const wrap = document.createElement('label');
      wrap.append(document.createTextNode(label), control);
      return wrap;
    },
    segmented: (items: Array<string | { value: string; label?: string }>, opts?: { value?: string; onSelect?: (v: string) => void }) => {
      const wrap = el('div', 'segwrap');
      let current = opts?.value ?? '';
      for (const item of items) {
        const value = typeof item === 'string' ? item : item.value;
        const b = document.createElement('button');
        b.textContent = typeof item === 'string' ? item : item.label ?? item.value;
        b.dataset.value = value;
        b.addEventListener('click', () => {
          current = value;
          opts?.onSelect?.(value);
        });
        wrap.appendChild(b);
      }
      return { el: wrap, get value() { return current; }, setValue: (v: string) => { current = v; } };
    },
    msgline: (text?: string, bad?: boolean) => el('div', bad ? 'msgline bad' : 'msgline', text ?? ''),
    placeholder: (text: string) => el('div', 'placeholder', text),
    chip: (text: string) => el('span', 'chip', text),
    pill: (text: string) => el('span', 'pill', text),
    copyButton: (text: string) => el('button', null, `copy ${text}`),
    toast: () => ({ dispose: () => {} }),
    confirm: async () => false,
    drawer: () => ({ dispose: () => {} }),
    lightbox: () => ({ dispose: () => {} }),
    busy: () => ({ dispose: () => {} }),
    disable: () => ({ dispose: () => {} }),
    fmt: {
      count: (n: number) => String(n),
      bytes: (n: number) => String(n),
      percent: (r: number) => `${r}%`,
      clock: (ts: unknown) => String(ts),
      money: (n: number) => `$${n.toFixed(2)}`,
      duration: (ms: number) => `${ms}ms`,
    },
  };

  const ctx = {
    pageId: 'world:quota',
    panelId: 'quota',
    language: 'zh',
    root,
    signal: new AbortController().signal,
    invoke,
    invokeBinary: async () => new Blob(),
    pickPath: async () => null,
    setConfig,
    stream: () => ({ send: () => {}, open: false, dispose: () => {} }),
    interval: () => ({ dispose: () => {} }),
    timeout: () => ({ dispose: () => {} }),
    frame: () => ({ dispose: () => {} }),
    own: (d: { dispose(): void }) => d,
    memo: { get: (_k: string, dflt: unknown) => dflt, set: () => {} },
    guardLeave: () => ({ dispose: () => {} }),
    scope: {},
    mountSlot: async () => ({ dispose: () => {} }),
    ui,
    refresh: async () => {},
  };

  // 面板用的是 ConsolePanelContext；替身按它的形状给，类型在测试里放宽。
  void bundle.panels[panel]!.mount(ctx as never);
  return { root, invoke, setConfig };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('用量额度面板', () => {
  it('把额度、Hermes 用量与提醒设置画出来', async () => {
    const { root, invoke } = harness(view());
    await vi.waitFor(() => expect(root.textContent).toContain('GOAT'));
    expect(invoke).toHaveBeenCalledWith('state', [{ days: 7 }]);

    const text = root.textContent ?? '';
    expect(text).toContain('Command Code 套餐额度');
    expect(text).toContain('test@gmail.com');
    expect(text).toContain('$54.66');
    expect(text).toContain('5 小时窗口');
    expect(text).toContain('$13.20 / $14.00');
    expect(text).toContain('本月额度');
    expect(text).toContain('账号');
    expect(text).toContain('供应商');
    expect(text).toContain('可用模型');
    expect(text).toContain('计划价目与额度');
    expect(text).toContain('Hermes 用量');
    expect(text).toContain('deepseek/deepseek-v4.1-flash');
    expect(text).toContain('726');
    expect(root.querySelectorAll('.progress').length).toBe(3);
  });

  it('账号卡：列出账号、标出当前与「桌宠在用」，添加与切换都走 invoke', async () => {
    const { root, invoke } = harness(view());
    await vi.waitFor(() => expect(root.textContent).toContain('test@gmail.com'));

    const text = root.textContent ?? '';
    expect(text).toContain('••••3456');
    expect(text).toContain('使用中');
    expect(text).toContain('桌宠端点');
    expect(text).toContain('桌宠在用');
    expect(text).toContain('备用');
    expect(text).toContain('手动添加');
    expect(text).toContain('command code returned HTTP 401');

    const use = [...root.querySelectorAll('button')].find((b) => b.textContent === '使用') as HTMLButtonElement;
    use.click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('activateAccount', [{ id: 'acc_backup' }]));

    // 手动加的才有「删除」：桌宠端点账号要删就去桌宠里删端点
    const removeButtons = [...root.querySelectorAll('button')].filter((b) => b.textContent === '删除');
    expect(removeButtons.length).toBe(1);

    const form = root.querySelector('.quota-form') as HTMLElement;
    const toggle = [...root.querySelectorAll('button')].find((b) => b.textContent === '手动添加账号' && !form.contains(b)) as HTMLButtonElement;
    expect(form.style.display).toBe('none');
    toggle.click();
    expect(form.style.display).not.toBe('none');

    const inputs = form.querySelectorAll('input');
    (inputs[0] as HTMLInputElement).value = '三号';
    (inputs[1] as HTMLInputElement).value = 'user_abcdef123456';
    (form.querySelector('button') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('addAccount', [{ label: '三号', key: 'user_abcdef123456', source: 'commandcode' }]),
    );
  });

  it('供应商卡：只留一个下拉 + 指向备忘文档，不再堆表格', async () => {
    const { root, setConfig } = harness(view());
    await vi.waitFor(() => expect(root.textContent).toContain('Command Code'));

    const select = root.querySelector('select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['commandcode', 'openai']);
    expect(select.value).toBe('commandcode');
    expect(root.textContent).toContain('OpenAI · 未实现');
    expect(root.textContent).toContain('docs/VENDORS.md');
    // 备忘表格已经从这里搬走了
    expect(root.textContent).not.toContain('候选接口');

    select.value = 'openai';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(setConfig).toHaveBeenCalledWith('world:quota', { 'worlds.quota.source': 'openai' }));
  });

  it('模型卡与价目卡：单价、按模型的额度、免费都画出来', async () => {
    const { root } = harness(view());
    await vi.waitFor(() => expect(root.textContent).toContain('GOAT'));

    const text = root.textContent ?? '';
    expect(text).toContain('可用模型');
    expect(text).toContain('DeepSeek V4.1 Flash');
    expect(text).toContain('/chat/completions');
    expect(text).toContain('计划价目与额度');
    expect(text).toContain('$0.15');
    expect(text).toContain('$0.6');
    expect(text).toContain('$80.00');
    expect(text).toContain('Laguna S 2.1');
    expect(text).toContain('免费');
    // 请求额度那三列已经去掉，只留「月额度 $」
    expect(text).toContain('月额度 $');
    expect(text).not.toContain('5 小时额度');
    expect(text).not.toContain('51300');
  });

  it('价目还没抓过：卡片写明怎么拿', async () => {
    const { root } = harness(view({ pricing: null }));
    await vi.waitFor(() => expect(root.textContent).toContain('还没抓过价目'));
    expect(root.textContent).toContain('缓存 12 小时');
  });

  it('点刷新走 refresh，再看一次读数', async () => {
    const { root, invoke } = harness(view());
    await vi.waitFor(() => expect(root.textContent).toContain('GOAT'));
    (root.querySelector('button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('refresh', [{ days: 7 }]));
  });

  it('换统计范围就按新天数重新取', async () => {
    const { root, invoke } = harness(view());
    await vi.waitFor(() => expect(root.textContent).toContain('GOAT'));
    const thirty = [...root.querySelectorAll('button')].find((b) => b.textContent?.includes('30'));
    (thirty as HTMLButtonElement).click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('state', [{ days: 30 }]));
  });

  it('取不到密钥时卡片写明原因，不抛错', async () => {
    const broken = view({
      quota: { ...view().quota, ok: false, reason: 'no command code key found', monthlyCredits: null, monthlyUsedPercent: null, fiveHour: null, weekly: null, monthlyAllowance: null },
    });
    const { root } = harness(broken);
    await vi.waitFor(() => expect(root.textContent).toContain('no command code key found'));
    expect(root.querySelector('.msgline.bad')).not.toBeNull();
  });

  it('Hermes 读不到时给出提示与改法', async () => {
    const broken = view({ hermes: { ...view().hermes, available: false, reason: 'no state.db under C:/nope', models: [], daily: [], total: null } });
    const { root } = harness(broken);
    await vi.waitFor(() => expect(root.textContent).toContain('读不到 Hermes 的用量库'));
    expect(root.textContent).toContain('Hermes 数据目录');
  });

  it('「配置」页签：表单填完点保存，一次提交全部字段', async () => {
    const { root, invoke } = harness(view(), 'settings');
    await vi.waitFor(() => expect(root.textContent).toContain('保存'));

    const text = root.textContent ?? '';
    expect(text).toContain('提醒');
    expect(text).toContain('连接');
    expect(text).toContain('路径');
    expect(text).toContain('Hermes 数据目录');

    const inputs = [...root.querySelectorAll('input')] as HTMLInputElement[];
    // 密钥框是密码框，提示语在 placeholder 上（不在 textContent 里）
    const keyInput = inputs.find((i) => i.type === 'password')!;
    expect(keyInput.placeholder).toContain('留空＝保持已存的密钥');
    // 阈值、间隔、统计天数、API 地址、密钥、月度额度 = 6 个 input（路径三项也在）
    expect(inputs.length).toBeGreaterThanOrEqual(9);

    const save = [...root.querySelectorAll('button')].find((b) => b.textContent === '保存') as HTMLButtonElement;
    save.click();
    const payload = invoke.mock.calls.find((c) => c[0] === 'saveSettings')?.[1]?.[0] as Record<string, unknown>;
    expect(payload).toBeTruthy();
    expect(payload.alerts).toBe(true);
    expect(payload.alertPercent).toBe('80');
    expect(payload.pollMinutes).toBe('10');
    expect(payload.hermesDays).toBe('7');
    expect(payload.source).toBe('commandcode');
    expect(typeof payload.commandcodeBaseUrl).toBe('string');
    expect(typeof payload.hermesHome).toBe('string');
  });

  it('「配置」页签：路径那几项带本机选择器', async () => {
    const { root } = harness(view(), 'settings');
    await vi.waitFor(() => expect(root.textContent).toContain('选择…'));
    const pickers = [...root.querySelectorAll('button')].filter((b) => b.textContent === '选择…');
    expect(pickers.length).toBe(3);
  });
});
