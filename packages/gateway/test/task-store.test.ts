/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { TaskStore } from '../src/task/task-store.ts';

/**
 * TaskStore 单测（真实 DB_EVENTS binding，vitest-pool-workers）。
 * oracle 硬编码自 Proto §8（TaskInfo/TaskDetail 字段、7 态、pendingCheckpoint/steps/artifacts）
 * / §0.2（ListOptions/Page、limit 钳制、非法 filter 键 invalid_argument）。
 */

async function clearDb() {
  await env.DB_EVENTS.prepare('DELETE FROM tasks').run();
}

beforeEach(async () => {
  await clearDb();
});

const NOW = '2026-07-03T00:00:00.000Z';

describe('TaskStore.create / getInfo / getDetail (§8)', () => {
  it('create stores an initial pending task and getInfo returns TaskInfo', async () => {
    const store = new TaskStore(env.DB_EVENTS);
    const info = await store.create({
      taskId: 't1',
      definition: 'deep-research',
      state: 'pending',
      createdBy: 'user:alice',
      now: NOW,
    });
    expect(info.taskId).toBe('t1');
    expect(info.definition).toBe('deep-research');
    expect(info.state).toBe('pending');
    expect(info.createdBy).toBe('user:alice');
  });

  it('getDetail includes empty steps/artifacts and no pendingCheckpoint initially', async () => {
    const store = new TaskStore(env.DB_EVENTS);
    await store.create({
      taskId: 't1',
      definition: 'deep-research',
      state: 'pending',
      createdBy: 'u',
      now: NOW,
    });
    const detail = await store.getDetail('t1');
    expect('code' in detail).toBe(false);
    if ('code' in detail) return;
    expect(detail.steps).toEqual([]);
    expect(detail.artifacts).toEqual([]);
    expect(detail.pendingCheckpoint).toBeUndefined();
  });

  it('getDetail on unknown task → not_found', async () => {
    const store = new TaskStore(env.DB_EVENTS);
    const detail = await store.getDetail('missing');
    expect('code' in detail && detail.code).toBe('not_found');
  });
});

describe('TaskStore checkpoint lifecycle (§8 waiting_human)', () => {
  it('setCheckpoint moves to waiting_human with pendingCheckpoint; clearCheckpoint resumes running', async () => {
    const store = new TaskStore(env.DB_EVENTS);
    await store.create({
      taskId: 't1',
      definition: 'deep-research',
      state: 'running',
      createdBy: 'u',
      now: NOW,
    });
    await store.setCheckpoint(
      't1',
      { checkpoint: 'confirm-plan', prompt: 'ok?', requestedAt: NOW },
      NOW,
    );
    let detail = await store.getDetail('t1');
    if ('code' in detail) throw new Error('unexpected');
    expect(detail.state).toBe('waiting_human');
    expect(detail.pendingCheckpoint?.checkpoint).toBe('confirm-plan');

    await store.clearCheckpoint('t1', NOW);
    detail = await store.getDetail('t1');
    if ('code' in detail) throw new Error('unexpected');
    expect(detail.state).toBe('running');
    expect(detail.pendingCheckpoint).toBeUndefined();
  });
});

describe('TaskStore.appendStep / addArtifacts', () => {
  it('appendStep accumulates steps and sets currentStep', async () => {
    const store = new TaskStore(env.DB_EVENTS);
    await store.create({
      taskId: 't1',
      definition: 'deep-research',
      state: 'running',
      createdBy: 'u',
      now: NOW,
    });
    await store.appendStep('t1', { name: 'a', state: 'done', startedAt: NOW }, NOW);
    await store.appendStep('t1', { name: 'b', state: 'done', startedAt: NOW }, NOW);
    const detail = await store.getDetail('t1');
    if ('code' in detail) throw new Error('unexpected');
    expect(detail.steps.map((s) => s.name)).toEqual(['a', 'b']);
    expect(detail.currentStep).toBe('b');
  });

  it('addArtifacts appends context:// URIs', async () => {
    const store = new TaskStore(env.DB_EVENTS);
    await store.create({
      taskId: 't1',
      definition: 'deep-research',
      state: 'running',
      createdBy: 'u',
      now: NOW,
    });
    await store.addArtifacts('t1', ['context://a', 'context://b'], NOW);
    const detail = await store.getDetail('t1');
    if ('code' in detail) throw new Error('unexpected');
    expect(detail.artifacts).toEqual(['context://a', 'context://b']);
  });
});

describe('TaskStore.list (§8 / §0.2)', () => {
  it('filters by state and definition; rejects unknown filter key', async () => {
    const store = new TaskStore(env.DB_EVENTS);
    await store.create({
      taskId: 't1',
      definition: 'deep-research',
      state: 'running',
      createdBy: 'u',
      now: '2026-07-03T00:00:01.000Z',
    });
    await store.create({
      taskId: 't2',
      definition: 'auto-delivery-lite',
      state: 'done',
      createdBy: 'u',
      now: '2026-07-03T00:00:02.000Z',
    });

    const running = await store.list({ filter: { state: 'running' } });
    if ('code' in running) throw new Error('unexpected');
    expect(running.items.map((t) => t.taskId)).toEqual(['t1']);

    const byDef = await store.list({ filter: { definition: 'auto-delivery-lite' } });
    if ('code' in byDef) throw new Error('unexpected');
    expect(byDef.items.map((t) => t.taskId)).toEqual(['t2']);

    const bad = await store.list({ filter: { bogus: 'x' } });
    expect('code' in bad && bad.code).toBe('invalid_argument');
  });
});

describe('TaskStore.patchNote (§8 Update)', () => {
  it('patchNote updates only note; not_found on unknown', async () => {
    const store = new TaskStore(env.DB_EVENTS);
    await store.create({
      taskId: 't1',
      definition: 'deep-research',
      state: 'running',
      createdBy: 'u',
      now: NOW,
    });
    const info = await store.patchNote('t1', 'hello', NOW);
    if ('code' in info) throw new Error('unexpected');
    expect(info.note).toBe('hello');
    expect(info.state).toBe('running');

    const missing = await store.patchNote('nope', 'x', NOW);
    expect('code' in missing && missing.code).toBe('not_found');
  });
});
