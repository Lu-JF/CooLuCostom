import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  accountsPath,
  activateAccount,
  addAccount,
  buildAccount,
  keyForActiveAccount,
  loadAccounts,
  maskKey,
  nativeAccountId,
  newAccountId,
  removeAccount,
  saveAccounts,
  secretNameFor,
  upsertNativeAccount,
  type AccountsFile,
  type QuotaAccount,
  type SecretBackend,
} from '../src/accounts.ts';

const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-accounts-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeSecrets(initial: Record<string, string> = {}): SecretBackend & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  return {
    store,
    read: (name) => store.get(name) ?? '',
    write: (name, value) => {
      store.set(name, value);
    },
  };
}

function account(label: string, extra: Partial<QuotaAccount> = {}): QuotaAccount {
  return {
    id: `acc_${label}`,
    label,
    source: 'commandcode',
    origin: 'manual',
    providerDir: null,
    secretName: `QUOTA_COMMANDCODE_${label}`,
    keyHint: '••••abcd',
    email: null,
    planId: null,
    planLabel: null,
    addedAt: 1,
    lastCheckedAt: null,
    lastError: null,
    ...extra,
  };
}

describe('账号表', () => {
  it('密钥尾四位：短的只留掩码，长的露尾四位', () => {
    expect(maskKey('')).toBe('••••');
    expect(maskKey('abcd')).toBe('••••');
    expect(maskKey('user_abcdef123456')).toBe('••••3456');
    expect(maskKey('  user_abcdef123456  ')).toBe('••••3456');
  });

  it('变量名按供应商生成并自动避让重名', () => {
    expect(secretNameFor('commandcode', [])).toBe('QUOTA_COMMANDCODE_1');
    expect(secretNameFor('open-router', [])).toBe('QUOTA_OPEN_ROUTER_1');
    expect(secretNameFor('commandcode', [account('1', { secretName: 'QUOTA_COMMANDCODE_1' })])).toBe('QUOTA_COMMANDCODE_2');
  });

  it('账号 id 不重复，且带前缀', () => {
    const existing = [account('a'), account('b')];
    const taken = new Set(existing.map((a) => a.id));
    for (let i = 0; i < 50; i += 1) {
      const id = newAccountId(existing);
      expect(id.startsWith('acc_')).toBe(true);
      expect(taken.has(id)).toBe(false);
    }
  });

  it('建账号：名字空着给默认名，Key 只留尾四位，额度信息照抄', () => {
    const built = buildAccount(
      { label: '  ', source: 'commandcode', key: 'user_abcdef123456', email: 'a@b.c', planId: 'individual-goat', planLabel: 'GOAT', now: 42 },
      [account('1')],
    );
    expect(built.label).toBe('账号 2');
    expect(built.keyHint).toBe('••••3456');
    expect(built.email).toBe('a@b.c');
    expect(built.planLabel).toBe('GOAT');
    expect(built.addedAt).toBe(42);
    expect(built.secretName).toBe('QUOTA_COMMANDCODE_2');
  });

  it('读写落盘：坏文件当空表，activeId 指向不存在的账号时退回第一个', () => {
    const file = accountsPath(tmp());
    expect(loadAccounts(file).accounts).toEqual([]);

    const data: AccountsFile = { version: 1, activeId: 'acc_a', accounts: [account('a'), account('b')] };
    saveAccounts(file, data);
    expect(loadAccounts(file)).toEqual(data);

    writeFileSync(file, '{ 这不是 json');
    expect(loadAccounts(file).accounts).toEqual([]);

    saveAccounts(file, { version: 1, activeId: 'acc_gone', accounts: [account('b')] });
    expect(loadAccounts(file).activeId).toBe('acc_b');
  });

  it('加账号：密钥写进秘密存储；加进去的那个就是当前账号', () => {
    const secrets = fakeSecrets();
    const first = addAccount({ version: 1, activeId: null, accounts: [] }, account('a'), 'key_aaaa', secrets);
    expect(first.activeId).toBe('acc_a');
    expect(secrets.store.get('QUOTA_COMMANDCODE_a')).toBe('key_aaaa');

    const second = addAccount(first, account('b'), 'key_bbbb', secrets);
    // 刚加的账号直接生效（加号就是为了看它的读数）
    expect(second.activeId).toBe('acc_b');
    expect(second.accounts.length).toBe(2);
  });

  it('切账号：不存在的 id 不动表；删当前账号后退回第一个', () => {
    const data: AccountsFile = { version: 1, activeId: 'acc_a', accounts: [account('a'), account('b')] };
    expect(activateAccount(data, 'acc_nope')).toBe(data);
    expect(activateAccount(data, 'acc_b').activeId).toBe('acc_b');

    const removed = removeAccount(data, 'acc_a');
    expect(removed.accounts.map((a) => a.label)).toEqual(['b']);
    expect(removed.activeId).toBe('acc_b');

    const removedOther = removeAccount(data, 'acc_b');
    expect(removedOther.activeId).toBe('acc_a');
  });

  it('手动加的账号带 origin=manual、没有端点目录', () => {
    const built = buildAccount({ label: 'x', source: 'commandcode', key: 'k' }, []);
    expect(built.origin).toBe('manual');
    expect(built.providerDir).toBeNull();
  });

  it('原生端点账号：id 跟端点名绑定，重复同步只更新不重复加', () => {
    const first = upsertNativeAccount({ version: 1, activeId: null, accounts: [] }, {
      name: 'CommandCode',
      dir: 'D:/pet/providers/CommandCode',
      secretName: 'CORTICO_KEY_COMMANDCODE',
      keyHint: '••••0001',
      now: 1,
    });
    expect(first.accounts.length).toBe(1);
    const row = first.accounts[0]!;
    expect(row.id).toBe(nativeAccountId('CommandCode'));
    expect(row.origin).toBe('native');
    expect(row.providerDir).toBe('D:/pet/providers/CommandCode');
    // 第一条被发现时自动成为当前账号
    expect(first.activeId).toBe(row.id);

    const again = upsertNativeAccount(first, {
      name: 'commandcode',
      dir: 'D:/pet/providers/CommandCode',
      secretName: 'CORTICO_KEY_COMMANDCODE',
      keyHint: '••••9999',
      now: 2,
    });
    expect(again.accounts.length).toBe(1);
    expect(again.accounts[0]!.keyHint).toBe('••••9999');
    expect(again.accounts[0]!.addedAt).toBe(1);
    // 已经认过邮箱的话，名字不被端点名覆盖回去
    again.accounts[0]!.email = 'a@b.c';
    again.accounts[0]!.label = 'a@b.c';
    const third = upsertNativeAccount(again, { name: 'CommandCode', dir: 'D:/pet/providers/CommandCode', secretName: 'K', keyHint: '••••9999' });
    expect(third.accounts[0]!.label).toBe('a@b.c');
  });

  it('老账号表没有 origin 字段：按有没有端点目录补出来', () => {
    const file = join(tmp(), 'accounts.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        activeId: 'acc_old',
        accounts: [
          { id: 'acc_old', label: '旧的', source: 'commandcode', secretName: 'K', keyHint: '••••1111', email: null, planId: null, planLabel: null, addedAt: 1, lastCheckedAt: null, lastError: null },
          { id: 'acc_native_x', label: 'x', source: 'commandcode', secretName: 'K2', keyHint: '••••2222', providerDir: 'D:/p/x', email: null, planId: null, planLabel: null, addedAt: 1, lastCheckedAt: null, lastError: null },
        ],
      }),
    );
    const loaded = loadAccounts(file);
    expect(loaded.accounts.map((a) => a.origin)).toEqual(['manual', 'native']);
    expect(loaded.accounts[1]!.providerDir).toBe('D:/p/x');
  });

  it('取密钥：账号里的优先，账号没密钥才回落到默认来源', () => {
    const fallback = (): { key: string; source: string; detail: string } => ({ key: 'fallback-key', source: 'env', detail: 'COMMANDCODE_API_KEY' });
    const data: AccountsFile = { version: 1, activeId: 'acc_a', accounts: [account('a')] };

    const withSecret = keyForActiveAccount(data, fakeSecrets({ QUOTA_COMMANDCODE_a: 'account-key' }), {}, fallback);
    expect(withSecret.key).toBe('account-key');
    expect(withSecret.source).toBe('account:a');
    expect(withSecret.account?.label).toBe('a');

    const withoutSecret = keyForActiveAccount(data, fakeSecrets(), {}, fallback);
    expect(withoutSecret.key).toBe('fallback-key');
    expect(withoutSecret.account?.label).toBe('a');

    const noAccounts = keyForActiveAccount({ version: 1, activeId: null, accounts: [] }, fakeSecrets(), {}, fallback);
    expect(noAccounts.key).toBe('fallback-key');
    expect(noAccounts.account).toBeNull();
  });
});
