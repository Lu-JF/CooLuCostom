/**
 * 读桌宠当前让它说话的那个模型端点：`<botDir>/config.json` 的 `activeProvider` 指向
 * `<botDir>/providers/<端点名>/config.json`（`{ baseUrl, secret }`）与同目录 `.env`（`secret` 变量的值）。
 * 只读；找不到返回 null。翻译用它——用桌宠自己配的模型，与人设无关。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface PetModel {
  /** 端点名，例如 CommandCode。 */
  name: string;
  baseUrl: string;
  apiKey: string;
  /** 端点 `config.json` 的 `spec.model`，没有时为空字符串。 */
  model: string;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readEnvFile(path: string): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const at = line.indexOf('=');
      if (at <= 0) continue;
      out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * providers 目录的候选位置：`<botDir>/../providers`（安装版的实测布局，与用量额度扩展一致）
 * 与 `<botDir>/providers`（保险）。
 */
export function providersRoots(botDir: string): string[] {
  if (!botDir) return [];
  return [join(dirname(botDir), 'providers'), join(botDir, 'providers')];
}

/** `preferred` 非空时优先它，否则用 `config.json` 的 `activeProvider`。 */
export function resolvePetModel(botDir: string, preferred = ''): PetModel | null {
  const config = readJson(join(botDir, 'config.json'));
  const name = preferred || String(config?.activeProvider ?? '');
  let dir = '';
  let endpoint: Record<string, unknown> | null = null;
  for (const root of providersRoots(botDir)) {
    const candidate = join(root, name);
    if (!existsSync(candidate)) continue;
    const parsed = readJson(join(candidate, 'config.json'));
    if (parsed) {
      dir = candidate;
      endpoint = parsed;
      break;
    }
  }
  if (!endpoint) return null;
  const secretName = String(endpoint.secret ?? '');
  const dotenv = readEnvFile(join(dir, '.env'));
  const apiKey = (secretName ? (process.env[secretName] ?? dotenv[secretName]) : '') || String(endpoint.apiKey ?? '');
  const baseUrl = String(endpoint.baseUrl ?? '');
  const spec = (endpoint.spec ?? {}) as Record<string, unknown>;
  return { name, baseUrl, apiKey, model: String(spec.model ?? '') };
}
