/**
 * World 的假宿主：记 pushEvent 与 log，另外提供一个内存版事件库（`store`），
 * 供读回执（`desktop-pet.answer`）之类的逻辑做单测。成员形状按 `EventStoreReader` 对齐。
 */
import type { EventEnvelope, EventGrepQuery, EventRangeQuery, WorldHost } from 'cortico/core/types.ts';

export interface PushedEvent {
  type: string;
  text: string;
  origin?: string;
  senderKey?: string;
  trigger?: string;
  tags?: readonly string[];
  meta?: Record<string, unknown>;
}

export class FakeHost {
  readonly pushed: PushedEvent[] = [];
  readonly logged: string[] = [];
  /** 内存事件库：pushEvent 与 seed 都往里写。 */
  readonly events: EventEnvelope[] = [];
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
      tags: e.tags,
      meta: e.meta,
    });
    this.cursor += 1;
    const saved = {
      ...(e as object),
      cursor: this.cursor,
      origin: (e.origin ?? 'external') as EventEnvelope['origin'],
    } as EventEnvelope;
    this.events.push(saved);
    return saved;
  }

  /** 往事件库里塞一条外部事件（例如桌宠的问答回执）。 */
  seed(e: { type: string; text: string; ts?: string; source?: string; meta?: Record<string, unknown> }): EventEnvelope {
    this.cursor += 1;
    const ev = {
      cursor: this.cursor,
      type: e.type,
      ts: e.ts ?? new Date().toISOString(),
      source: e.source ?? 'desktop-pet',
      origin: 'external' as EventEnvelope['origin'],
      text: e.text,
      meta: e.meta,
    } as EventEnvelope;
    this.events.push(ev);
    return ev;
  }

  asHost(): WorldHost {
    const self = this;
    const store = {
      get: (cursor: number) => self.events.find((e) => e.cursor === cursor),
      latestCursor: () => self.cursor,
      range: (q: EventRangeQuery) => {
        const from = q.fromCursor ?? 0;
        const to = q.toCursor ?? Number.MAX_SAFE_INTEGER;
        const hits = self.events.filter((e) => e.cursor >= from && e.cursor <= to);
        const limit = q.limit ?? hits.length;
        return hits.slice(Math.max(0, hits.length - limit));
      },
      around: (cursor: number, before: number, after: number) =>
        self.events.filter((e) => e.cursor >= cursor - before && e.cursor <= cursor + after),
      grep: (q: EventGrepQuery) => {
        const needle = q.keyword.toLowerCase();
        return self.events
          .filter((e) => e.text.toLowerCase().includes(needle))
          .map((e) => ({ hitCursor: e.cursor, events: [e] }));
      },
    };
    return {
      pushEvent: this.pushEvent.bind(this),
      pushDeferred: () => {},
      store,
      drainPendingEvents: async () => [],
      modelFacts: { supportsImages: false },
      blob: () => null,
      reportUsage: () => {},
      log: {
        info: (...a: unknown[]) => { self.logged.push(`info ${a.map(String).join(' ')}`); },
        warn: (...a: unknown[]) => { self.logged.push(`warn ${a.map(String).join(' ')}`); },
        error: (...a: unknown[]) => { self.logged.push(`error ${a.map(String).join(' ')}`); },
      },
    } as unknown as WorldHost;
  }
}
