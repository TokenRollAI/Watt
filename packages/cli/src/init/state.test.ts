import { describe, expect, it } from 'vitest';
import { answersPath, deploymentDir, loadState, saveState } from './paths.ts';
import {
  type DeploymentState,
  markCompleted,
  newState,
  pendingSteps,
  STEP_ORDER,
} from './state.ts';

describe('newState / pendingSteps / markCompleted', () => {
  it('new state has no completed steps → all pending', () => {
    const s = newState({
      namePrefix: 'wtest',
      adminPrincipal: 'user:alice',
      feishuEnabled: false,
      llmKeyProvided: false,
      now: () => 0,
    });
    expect(pendingSteps(s)).toEqual([...STEP_ORDER]);
    expect(s.createdAt).toBe(new Date(0).toISOString());
  });

  it('--resume: completed steps are skipped, order preserved', () => {
    let s = newState({
      namePrefix: 'wtest',
      adminPrincipal: 'user:alice',
      feishuEnabled: true,
      llmKeyProvided: false,
    });
    s = markCompleted(s, 'auth');
    s = markCompleted(s, 'provision');
    s = markCompleted(s, 'config');
    const pending = pendingSteps(s);
    expect(pending).not.toContain('auth');
    expect(pending).not.toContain('provision');
    expect(pending).not.toContain('config');
    expect(pending).toEqual(['migrations', 'secrets', 'deploy', 'llmSecret']);
  });

  it('markCompleted is immutable', () => {
    const s = newState({
      namePrefix: 'wtest',
      adminPrincipal: 'user:alice',
      feishuEnabled: false,
      llmKeyProvided: false,
    });
    const s2 = markCompleted(s, 'auth');
    expect(s.completed.auth).toBeUndefined();
    expect(s2.completed.auth).toBe(true);
  });
});

describe('loadState / saveState (injected fs)', () => {
  it('round-trips state and never persists secrets', () => {
    const store = new Map<string, string>();
    const fs = {
      readFile: (p: string) => {
        const v = store.get(p);
        if (v === undefined) throw new Error('ENOENT');
        return v;
      },
      writeFile: (p: string, d: string) => void store.set(p, d),
      mkdir: () => {},
    };
    let s = newState({
      namePrefix: 'wtest',
      adminPrincipal: 'user:alice',
      feishuEnabled: false,
      llmKeyProvided: true,
      llmSecretName: 'WATT_LLM_KEY',
    });
    s = markCompleted(s, 'provision');
    s.d1Ids = { policies: 'a', providers: 'b', audit: 'c', events: 'd', context: 'e' };
    s.kvIds = { authzCache: 'f', tenants: 'g' };
    saveState(s, '/home/u', fs);

    const loaded = loadState('wtest', '/home/u', fs) as DeploymentState;
    expect(loaded.namePrefix).toBe('wtest');
    expect(loaded.completed.provision).toBe(true);
    expect(loaded.d1Ids?.policies).toBe('a');
    // 存档只记布尔，绝不含 LLM key 明文。
    const raw = store.get(answersPath('wtest', '/home/u')) as string;
    expect(raw).not.toMatch(/sk-|secret-value|api[-_]?key.*[:=].*['"][^'"]{8}/i);
    expect(loaded.llmKeyProvided).toBe(true);
  });

  it('loadState returns undefined for missing archive', () => {
    const fs = {
      readFile: () => {
        throw new Error('ENOENT');
      },
    };
    expect(loadState('missing', '/home/u', fs)).toBeUndefined();
  });

  it('deploymentDir/answersPath layout', () => {
    expect(deploymentDir('wtest', '/home/u')).toBe('/home/u/.watt/deployments/wtest');
    expect(answersPath('wtest', '/home/u')).toBe('/home/u/.watt/deployments/wtest/answers.json');
  });
});
