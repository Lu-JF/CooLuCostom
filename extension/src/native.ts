/**
 * 桌宠自己给「模型端点」存的凭证 —— 也就是使用者说的「原生接入方式」。
 *
 * 布局（实测）：
 *   <home>/providers/<端点名>/config.json   { kind, baseUrl, secret: '<.env 里的变量名>', spec, … }
 *   <home>/providers/<端点名>/.env          <变量名>=<密钥>
 *
 * 这个面板的额度查询就用同一把密钥：不需要使用者在面板里再贴一次 Key，也不需要知道它
 * 是从哪儿来的。每个这样的端点天然就是一个「账号」（想换号就在桌宠里再配一个端点）。
 *
 * 只读，不写这些文件；`<botDir>` 由框架给（World 的安装目录），providers 一般在它旁边。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface NativeEndpoint {
  /** 端点目录名，如 `CommandCode`。 */
  name: string;
  /** 端点目录的绝对路径。 */
  dir: string;
  /** config.json 里的 kind，如 `openai-responses-compat` / `coo`。 */
  kind: string;
  baseUrl: string;
  /** config.json 里的 `secret`，就是 `.env` 里的变量名。 */
  secretName: string;
  /** 从 `.env` 读出来的密钥；读不到是空串。 */
  key: string;
}

/** 解析一个 `.env`：KEY=VALUE 一行一条，容忍引号、注释与 CRLF。 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const at = line.indexOf('=');
    const name = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (name) out[name] = value;
  }
  return out;
}

/** providers 目录的候选位置：`<botDir>/../providers`（实测）与 `<botDir>/providers`（保险）。 */
export function providersRoots(botDir: string): string[] {
  if (!botDir) return [];
  return [join(dirname(botDir), 'providers'), join(botDir, 'providers')];
}

/** 读一个端点目录；不像端点就返回 null。 */
export function readEndpoint(dir: string): NativeEndpoint | null {
  const cfgPath = join(dir, 'config.json');
  if (!existsSync(cfgPath)) return null;
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const secretName = typeof cfg.secret === 'string' ? cfg.secret : '';
  let key = '';
  const envPath = join(dir, '.env');
  if (secretName && existsSync(envPath)) {
    try {
      key = parseEnv(readFileSync(envPath, 'utf8'))[secretName] ?? '';
    } catch {
      key = '';
    }
  }
  return {
    name: dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? dir,
    dir,
    kind: typeof cfg.kind === 'string' ? cfg.kind : '',
    baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : '',
    secretName,
    key,
  };
}

/** 所有像端点样的目录。 */
export function listEndpoints(botDir: string): NativeEndpoint[] {
  const found: NativeEndpoint[] = [];
  const seen = new Set<string>();
  for (const root of providersRoots(botDir)) {
    if (!existsSync(root)) continue;
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = join(root, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (seen.has(dir)) continue;
      const endpoint = readEndpoint(dir);
      if (!endpoint) continue;
      seen.add(dir);
      found.push(endpoint);
    }
  }
  return found;
}

/** baseUrl 的主机是不是这一家（不区分大小写，允许它带路径）。 */
export function hostMatches(baseUrl: string, host: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase().endsWith(host.toLowerCase());
  } catch {
    return baseUrl.toLowerCase().includes(host.toLowerCase());
  }
}

/**
 * 挑出指向某一家的端点。默认 Command Code（`commandcode.ai`）——
 * 也就是「这一家用哪个账号」这件事在桌宠里是怎么表达的。
 */
export function endpointsFor(botDir: string, host = 'commandcode.ai'): NativeEndpoint[] {
  return listEndpoints(botDir).filter((e) => e.baseUrl && hostMatches(e.baseUrl, host));
}
