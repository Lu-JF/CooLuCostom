/**
 * 多账号：一份账号表 + 每个账号一把密钥。
 *
 * 表存在部署的数据目录里（`<dataDir>/quota/accounts.json`），**密钥不写进表**：表里只存变量名，
 * 值经 `ctx.storeSecret()` 落在部署的 `.env`（框架提供的秘密存储），读回走 `ctx.secret()`。
 * 这样一个 Key 泄漏面跟平台其它密钥一致，账号表也可以随便看。
 *
 * 账号只服务这个面板的额度/价目：Coo 说话用哪个模型端点由「模型供应商」页决定，两件事互不影响。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface QuotaAccount {
  id: string;
  /** 使用者起的名字，如「主号」「备用」；原生端点账号跟着登录邮箱走。 */
  label: string;
  /** 供应商 id，见 sources.ts。 */
  source: string;
  /** 这把密钥从哪儿来：桌宠自己配的端点（native），还是面板里手动加的（manual）。 */
  origin: 'native' | 'manual';
  /** native：端点目录（`<home>/providers/<名字>`）；manual：null。 */
  providerDir: string | null;
  /** 密钥的变量名：native 是端点 `.env` 里的名字，manual 是部署 `.env` 里的名字。 */
  secretName: string;
  /** 密钥尾四位，仅用于辨认。 */
  keyHint: string;
  email: string | null;
  planId: string | null;
  planLabel: string | null;
  addedAt: number;
  /** 最近一次成功取数的时刻。 */
  lastCheckedAt: number | null;
  /** 最近一次失败原因（英文短句）。 */
  lastError: string | null;
}

export interface AccountsFile {
  version: 1;
  activeId: string | null;
  accounts: QuotaAccount[];
}

export interface SecretBackend {
  read(name: string): string;
  write(name: string, value: string): void;
}

const EMPTY: AccountsFile = { version: 1, activeId: null, accounts: [] };

export function accountsPath(dataDir: string): string {
  return join(dataDir, 'quota', 'accounts.json');
}

export function loadAccounts(file: string): AccountsFile {
  if (!existsSync(file)) return { ...EMPTY, accounts: [] };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AccountsFile>;
    const accounts = (Array.isArray(raw.accounts) ? raw.accounts : [])
      .filter((a): a is QuotaAccount => Boolean(a) && typeof a === 'object' && typeof (a as QuotaAccount).id === 'string')
      // 老版本没有 origin/providerDir：按「有端点目录就是原生的」补一下。
      .map((a) => ({
        ...a,
        origin: a.origin === 'native' || a.origin === 'manual' ? a.origin : a.providerDir ? 'native' : 'manual',
        providerDir: typeof a.providerDir === 'string' ? a.providerDir : null,
      }));
    const activeId = typeof raw.activeId === 'string' && accounts.some((a) => a.id === raw.activeId) ? raw.activeId : (accounts[0]?.id ?? null);
    return { version: 1, activeId, accounts };
  } catch {
    // 文件坏了不该让整个 World 起不来：当作没有账号，界面会说明。
    return { ...EMPTY, accounts: [] };
  }
}

/** 先写临时文件再改名，坏一半的账号表不会留在盘上。 */
export function saveAccounts(file: string, data: AccountsFile): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

/** 密钥尾四位：够辨认，不够还原。 */
export function maskKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 4) return '••••';
  return `••••${trimmed.slice(-4)}`;
}

/** 账号变量名：`QUOTA_<供应商>_<序号>`，符合 .env 里 KEY 的命名习惯。 */
export function secretNameFor(source: string, existing: readonly QuotaAccount[]): string {
  const upper = source.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  let n = 1;
  const taken = new Set(existing.map((a) => a.secretName));
  while (taken.has(`QUOTA_${upper}_${n}`)) n += 1;
  return `QUOTA_${upper}_${n}`;
}

export function newAccountId(existing: readonly QuotaAccount[]): string {
  const taken = new Set(existing.map((a) => a.id));
  for (;;) {
    const id = `acc_${Math.random().toString(16).slice(2, 10)}`;
    if (!taken.has(id)) return id;
  }
}

export function activeAccount(data: AccountsFile): QuotaAccount | null {
  return data.accounts.find((a) => a.id === data.activeId) ?? null;
}

/** 原生端点账号的 id：跟端点目录名绑定，重启后还是同一条记录（认得出、不会重复加）。 */
export function nativeAccountId(name: string): string {
  return `acc_native_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'endpoint'}`;
}

export interface NativeAccountInput {
  name: string;
  dir: string;
  secretName: string;
  keyHint: string;
  now?: number;
}

/**
 * 把桌宠里的一个端点记成账号：**有就更新、没有就加**，并把当前账号指针落到它身上
 * （第一次发现时）。邮箱与套餐由取数那一步回填。
 */
export function upsertNativeAccount(data: AccountsFile, input: NativeAccountInput): AccountsFile {
  const id = nativeAccountId(input.name);
  const at = input.now ?? Date.now();
  const existing = data.accounts.find((a) => a.id === id);
  if (existing) {
    existing.origin = 'native';
    existing.providerDir = input.dir;
    existing.secretName = input.secretName || existing.secretName;
    existing.keyHint = input.keyHint || existing.keyHint;
    if (!existing.email) existing.label = input.name;
    return data;
  }
  const account: QuotaAccount = {
    id,
    label: input.name,
    source: 'commandcode',
    origin: 'native',
    providerDir: input.dir,
    secretName: input.secretName,
    keyHint: input.keyHint,
    email: null,
    planId: null,
    planLabel: null,
    addedAt: at,
    lastCheckedAt: null,
    lastError: null,
  };
  // 一条都没有时，第一个被发现的端点就是当前账号。
  const accounts = [...data.accounts, account];
  return { version: 1, activeId: data.activeId ?? account.id, accounts };
}

export interface AddAccountInput {
  label: string;
  source: string;
  key: string;
  email?: string | null;
  planId?: string | null;
  planLabel?: string | null;
  now?: number;
}

/** 一个新账号记录（手动加的：密钥由调用方经 SecretBackend 写入）；原生端点走 upsertNativeAccount。 */
export function buildAccount(input: AddAccountInput, existing: readonly QuotaAccount[]): QuotaAccount {
  return {
    id: newAccountId(existing),
    label: input.label.trim() || `账号 ${existing.length + 1}`,
    source: input.source,
    origin: 'manual',
    providerDir: null,
    secretName: secretNameFor(input.source, existing),
    keyHint: maskKey(input.key),
    email: input.email ?? null,
    planId: input.planId ?? null,
    planLabel: input.planLabel ?? null,
    addedAt: input.now ?? Date.now(),
    lastCheckedAt: null,
    lastError: null,
  };
}

export function addAccount(data: AccountsFile, account: QuotaAccount, key: string, secrets: SecretBackend): AccountsFile {
  secrets.write(account.secretName, key);
  const next: AccountsFile = {
    version: 1,
    // 刚加的账号直接生效：加号就是为了看它的读数，界面会标出「使用中」。
    activeId: account.id,
    accounts: [...data.accounts, account],
  };
  return next;
}

export function removeAccount(data: AccountsFile, id: string): AccountsFile {
  const accounts = data.accounts.filter((a) => a.id !== id);
  const activeId = data.activeId === id ? (accounts[0]?.id ?? null) : data.activeId;
  return { version: 1, activeId, accounts };
}

export function activateAccount(data: AccountsFile, id: string): AccountsFile {
  if (!data.accounts.some((a) => a.id === id)) return data;
  return { ...data, activeId: id };
}

/**
 * 当前账号的密钥来源，按优先级：当前账号的变量名 → 配置里手填的 Key → 环境变量 / 登录文件 / .env。
 * 返回的 `key` 为空时调用方按「取不到」处理。
 */
export function keyForActiveAccount(
  data: AccountsFile,
  secrets: SecretBackend,
  fallback: { configKey?: string; envFile?: string; authFile?: string; env?: Record<string, string | undefined> },
  resolveFallback: (opts: { configKey?: string; envFile?: string; authFile?: string; env?: Record<string, string | undefined> }) => { key: string | null; source: string; detail: string },
): { key: string | null; source: string; detail: string; account: QuotaAccount | null } {
  const account = activeAccount(data);
  if (account) {
    const value = secrets.read(account.secretName)?.trim();
    if (value) return { key: value, source: `account:${account.label}`, detail: account.secretName, account };
  }
  const fallbackResolved = resolveFallback(fallback);
  return { ...fallbackResolved, account };
}
