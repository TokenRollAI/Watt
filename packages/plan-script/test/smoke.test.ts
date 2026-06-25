import { describe, it, expect } from 'vitest';
import { replayPlanScript } from '../src/index.js';

describe('smoke', () => {
  it('runs an empty script to completion', async () => {
    const res = await replayPlanScript({ source: 'return 42;', journal: [] });
    expect(res.status).toBe('completed');
    if (res.status === 'completed') expect(res.value).toBe(42);
  });

  it('emits a single pending call', async () => {
    const res = await replayPlanScript({
      source: `
        const r = await run('agent_01ARZ3NDEKTSV4RRFFQ69G5FAV', {
          objective: 'do', inputs: [], budget: { maxCostUsd: 1, maxWallClockMs: 1000, maxToolCalls: 1 },
          expectedOutput: 'x', permissions: { contextScope: [] },
        });
        return r;
      `,
      journal: [],
    });
    expect(res.status).toBe('pending');
    if (res.status === 'pending') {
      expect(res.calls).toHaveLength(1);
      expect(res.calls[0]!.fn).toBe('run');
      expect(res.calls[0]!.seq).toBe(0);
    }
  });
});
