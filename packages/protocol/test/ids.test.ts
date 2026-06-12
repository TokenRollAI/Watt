import { describe, expect, it } from 'vitest';
import {
  AgentId,
  idempotencyKeyForHostCall,
  newAgentId,
  newAgentRunId,
  newAgentVersionId,
  newRunId,
  newSessionId,
  newTaskId,
  RunId,
  SessionId,
  AgentRunId,
  ResourceRef,
  newCheckpointId,
} from '../src/index.js';

describe('ID 语法', () => {
  const taskId = newTaskId();
  const runId = newRunId(taskId);
  const agentId = newAgentId();

  it('run id 编码所属 task', () => {
    expect(RunId.parse(runId)).toBe(runId);
    expect(runId).toContain(taskId.slice('task_'.length));
  });

  it('arun id 编码所属 run 与确定性 seq', () => {
    const arun = newAgentRunId(runId, 3);
    expect(AgentRunId.parse(arun)).toBe(arun);
    expect(arun.endsWith('_3')).toBe(true);
    // 同 run 同 seq 派生结果确定
    expect(newAgentRunId(runId, 3)).toBe(arun);
  });

  it('session id 编码所属 agent，且语法中无 run 成分', () => {
    const sess = newSessionId(agentId);
    expect(SessionId.parse(sess)).toBe(sess);
    // run id 不可能通过 session 校验，反之亦然
    expect(SessionId.safeParse(runId).success).toBe(false);
    expect(RunId.safeParse(sess).success).toBe(false);
  });

  it('agentVersion 编码所属 agent 与修订号', () => {
    const v = newAgentVersionId(agentId, 2);
    expect(v).toBe(`agentv_${agentId.slice('agent_'.length)}_2`);
  });

  it('派生函数校验父 ID，拒绝错误类型', () => {
    expect(() => newRunId(agentId)).toThrow();
    expect(() => newSessionId(taskId)).toThrow();
    expect(() => newAgentRunId(taskId, 0)).toThrow();
  });

  it('ResourceRef 接受受认资源，拒绝裸字符串', () => {
    expect(ResourceRef.safeParse(newCheckpointId()).success).toBe(true);
    expect(ResourceRef.safeParse('some-random-string').success).toBe(false);
  });

  it('幂等 key 由 run_id + seq 确定性派生', () => {
    expect(idempotencyKeyForHostCall(runId, 5)).toBe(`${runId}:5`);
    expect(() => idempotencyKeyForHostCall('not-a-run', 5)).toThrow();
  });

  it('AgentId 拒绝大小写/前缀变体', () => {
    expect(AgentId.safeParse(agentId.toLowerCase()).success).toBe(false);
    expect(AgentId.safeParse(`x${agentId}`).success).toBe(false);
  });
});
