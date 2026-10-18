/**
 * World 的假宿主：只记 pushEvent 与 log。World 只用这两个成员，
 * 其余按 `WorldHost` 的形状留空，测试里不会走到。
 */
import type { EventEnvelope, WorldHost } from 'cortico/core/types.ts';

export interface PushedEvent {
  type: string;
  text: string;
  origin?: string;
  senderKey?: string;
  trigger?: string;
  meta?: Record<string, unknown>;
}

export class FakeHost {
  readonly pushed: PushedEvent[] = [];
  private cursor = 0;

  async pushEvent(
    e: Omit<EventEnvelope, 'cursor' | 'origin' | 'contextDelivery' | 'blobs'> & { origin?: string },
    opts?: { trigger?: string },
  ): Promise<EventEnvelope> {
    this.pushed.push({
      type: e.type,
      text: e.text,
      origin: e.origin,
      senderKey: e.senderKey,
      trigger: opts?.trigger,
      meta: e.meta,
    });
    this.cursor += 1;
    return { ...(e as object), cursor: this.cursor, origin: (e.origin ?? 'external') as EventEnvelope['origin'] } as EventEnvelope;
  }

  asHost(): WorldHost {
    return this as unknown as WorldHost;
  }
}
