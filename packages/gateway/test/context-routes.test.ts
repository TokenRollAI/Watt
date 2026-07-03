/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import {
  importPrivateJwk,
  type NamespaceMount,
  parseHelpDsl,
  signUserToken,
  type TokenMeta,
} from '@watt/core';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetSeedGuardForTests } from '../src/authz/seed.ts';
import type { ContextRegistry } from '../src/context/context-registry.ts';
import { PLATFORM_KID } from '../src/env.ts';
import {
  TEST_ADMIN_PRINCIPAL,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
  TEST_PRIVATE_JWK,
} from './fixtures/test-key.ts';

/**
 * Context Layer 路由服务端契约测试（HTTP 进 → ContextRegistry DO / provider I/O 出，真实 workerd）。
 * 覆盖：platform/context 管理面五动词 + 消费面四动词 + ~help（Help DSL parser 断言）+ 权限拦截
 * + readOnly 拒绝 + TTL 惰性回收访问 404。oracle 硬编码自 Proto §4.1/§4.2/§11.3a + DoD §5。
 * token/种子模式参照 platform-event.test.ts / platform.test.ts。
 */

const META: TokenMeta = { issuer: TEST_JWT_ISSUER, audience: TEST_JWT_AUDIENCE };
const BASE = 'https://gateway.test';

let signAdmin: () => Promise<string>;
let signNonAdmin: () => Promise<string>;

beforeAll(async () => {
  const { priv } = await importPrivateJwk(TEST_PRIVATE_JWK, PLATFORM_KID);
  signAdmin = () =>
    signUserToken({ principal: TEST_ADMIN_PRINCIPAL, roles: ['admin'], trace: 'tr-a' }, priv, META);
  signNonAdmin = () => signUserToken({ principal: 'user:bob', roles: ['staff'] }, priv, META);
});

/** 生产 routes/context-routes 用的单例 registry（idFromName('registry')）——测试直接操纵同一实例。 */
function registryStub(): DurableObjectStub<ContextRegistry> {
  return env.CONTEXT_REGISTRY.get(env.CONTEXT_REGISTRY.idFromName('registry'));
}

async function clearDb() {
  await env.DB_POLICIES.prepare('DELETE FROM policies').run();
  await env.DB_POLICIES.prepare('DELETE FROM identity_mappings').run();
  await env.DB_CONTEXT.prepare('DELETE FROM entries').run();
}

async function clearBucket() {
  const listed = await env.R2_CONTEXT_OBJECTS.list();
  for (const obj of listed.objects) await env.R2_CONTEXT_OBJECTS.delete(obj.key);
}

/** 清空单例 registry 的全部挂载（DO 存活整个 isolate，跨用例隔离）。 */
async function clearMounts() {
  const stub = registryStub();
  const page = (await stub.list({ limit: 200 })) as { items: NamespaceMount[] };
  for (const m of page.items) await stub.delete(m.namespace);
}

beforeEach(async () => {
  await clearDb();
  await clearBucket();
  await clearMounts();
  resetSeedGuardForTests();
});

async function post(path: string, token: string | null, call: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return SELF.fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(call) });
}

/** 经管理面挂载一个 namespace（admin token）。 */
async function mount(over: Partial<NamespaceMount> & { namespace: string; provider: string }) {
  const token = await signAdmin();
  const res = await post('/htbp/platform/context', token, {
    tool: 'Write',
    arguments: { mount: over },
  });
  expect(res.status).toBe(200);
}

describe('POST /htbp/platform/context (§4.2 管理面五动词)', () => {
  it('rejects a request with no token: 401', async () => {
    const res = await post('/htbp/platform/context', null, { tool: 'List', arguments: {} });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('permission_denied');
  });

  it('rejects an unknown tool with invalid_argument (400)', async () => {
    const token = await signAdmin();
    const res = await post('/htbp/platform/context', token, { tool: 'Frobnicate', arguments: {} });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_argument');
  });

  it('Write mounts a namespace; Get reads it; List includes it; Update mutates; Delete unmounts', async () => {
    const token = await signAdmin();
    const write = await post('/htbp/platform/context', token, {
      tool: 'Write',
      arguments: { mount: { namespace: 'docs/api', provider: 'object' } },
    });
    expect(write.status).toBe(200);
    const writeBody = (await write.json()) as { mount: NamespaceMount };
    expect(writeBody.mount.namespace).toBe('docs/api');
    expect(writeBody.mount.provider).toBe('object');

    const get = await post('/htbp/platform/context', token, {
      tool: 'Get',
      arguments: { namespace: 'docs/api' },
    });
    expect(get.status).toBe(200);
    expect(((await get.json()) as { mount: NamespaceMount }).mount.provider).toBe('object');

    const list = await post('/htbp/platform/context', token, {
      tool: 'List',
      arguments: { opts: {} },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { items: NamespaceMount[] };
    expect(listBody.items.some((m) => m.namespace === 'docs/api')).toBe(true);

    const update = await post('/htbp/platform/context', token, {
      tool: 'Update',
      arguments: { namespace: 'docs/api', patch: { provider: 'structured' } },
    });
    expect(update.status).toBe(200);
    expect(((await update.json()) as { mount: NamespaceMount }).mount.provider).toBe('structured');

    const del = await post('/htbp/platform/context', token, {
      tool: 'Delete',
      arguments: { namespace: 'docs/api' },
    });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true);

    const getGone = await post('/htbp/platform/context', token, {
      tool: 'Get',
      arguments: { namespace: 'docs/api' },
    });
    expect(getGone.status).toBe(404);
  });

  it('Write with a malformed mount (missing provider) → invalid_argument (400)', async () => {
    const token = await signAdmin();
    const res = await post('/htbp/platform/context', token, {
      tool: 'Write',
      arguments: { mount: { namespace: 'x' } },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_argument');
  });

  it('non-admin is denied Write with 403 (default-deny)', async () => {
    const token = await signNonAdmin();
    const res = await post('/htbp/platform/context', token, {
      tool: 'Write',
      arguments: { mount: { namespace: 'y', provider: 'object' } },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('permission_denied');
  });
});

describe('POST /htbp/context/<ns> object provider full loop (§4.1)', () => {
  it('Write → Get → List → Update round-trips on an object mount', async () => {
    await mount({ namespace: 'skills/py', provider: 'object' });
    const token = await signAdmin();

    const write = await post('/htbp/context/skills/py', token, {
      tool: 'Write',
      arguments: {
        path: 'SKILL.md',
        entry: { contentType: 'text/markdown', content: '# py', metadata: { d: 'py' } },
      },
    });
    expect(write.status).toBe(200);
    const writeBody = (await write.json()) as { meta: { uri: string; version: string } };
    expect(writeBody.meta.uri).toBe('context://skills/py/SKILL.md');
    expect(writeBody.meta.version).toBe('1');

    const get = await post('/htbp/context/skills/py', token, {
      tool: 'Get',
      arguments: { path: 'SKILL.md' },
    });
    expect(get.status).toBe(200);
    const getBody = (await get.json()) as { entry: { content: string } };
    expect(getBody.entry.content).toBe('# py');

    const list = await post('/htbp/context/skills/py', token, {
      tool: 'List',
      arguments: { path: '', opts: {} },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { items: { uri: string }[] };
    expect(listBody.items.some((m) => m.uri === 'context://skills/py/SKILL.md')).toBe(true);

    const update = await post('/htbp/context/skills/py', token, {
      tool: 'Update',
      arguments: { path: 'SKILL.md', patch: { content: '# py v2' } },
    });
    expect(update.status).toBe(200);
    expect(((await update.json()) as { meta: { version: string } }).meta.version).toBe('2');
  });

  it('Write with a stale ifVersion → conflict (409)', async () => {
    await mount({ namespace: 'skills/py', provider: 'object' });
    const token = await signAdmin();
    await post('/htbp/context/skills/py', token, {
      tool: 'Write',
      arguments: { path: 'f', entry: { contentType: 'text/plain', content: 'v1' } },
    });
    await post('/htbp/context/skills/py', token, {
      tool: 'Write',
      arguments: { path: 'f', entry: { contentType: 'text/plain', content: 'v2', ifVersion: '1' } },
    });
    const res = await post('/htbp/context/skills/py', token, {
      tool: 'Write',
      arguments: { path: 'f', entry: { contentType: 'text/plain', content: 'v3', ifVersion: '1' } },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('conflict');
  });

  it('Update on a missing path → not_found (404)', async () => {
    await mount({ namespace: 'skills/py', provider: 'object' });
    const token = await signAdmin();
    const res = await post('/htbp/context/skills/py', token, {
      tool: 'Update',
      arguments: { path: 'nope', patch: { content: 'x' } },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('not_found');
  });

  it('Write with a malformed entry (missing contentType) → invalid_argument (400)', async () => {
    await mount({ namespace: 'skills/py', provider: 'object' });
    const token = await signAdmin();
    const res = await post('/htbp/context/skills/py', token, {
      tool: 'Write',
      arguments: { path: 'f', entry: { content: 'x' } },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_argument');
  });
});

describe('POST /htbp/context/<ns> structured provider full loop (§4.1)', () => {
  it('Write → Get → List → Update → Delete round-trips on a structured mount', async () => {
    await mount({ namespace: 'feedback/bugs', provider: 'structured' });
    const token = await signAdmin();

    const write = await post('/htbp/context/feedback/bugs', token, {
      tool: 'Write',
      arguments: {
        path: '1235',
        entry: {
          contentType: 'text/markdown',
          content: '## bug\ndetail',
          metadata: { status: 'open' },
        },
      },
    });
    expect(write.status).toBe(200);
    const writeBody = (await write.json()) as { meta: { uri: string; version: string } };
    expect(writeBody.meta.uri).toBe('context://feedback/bugs/1235');
    expect(writeBody.meta.version).toBe('1');

    const get = await post('/htbp/context/feedback/bugs', token, {
      tool: 'Get',
      arguments: { path: '1235' },
    });
    expect(get.status).toBe(200);
    expect(((await get.json()) as { entry: { content: string } }).entry.content).toBe(
      '## bug\ndetail',
    );

    const list = await post('/htbp/context/feedback/bugs', token, {
      tool: 'List',
      arguments: { path: '', opts: {} },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { items: { uri: string }[] };
    expect(listBody.items.some((m) => m.uri === 'context://feedback/bugs/1235')).toBe(true);

    const update = await post('/htbp/context/feedback/bugs', token, {
      tool: 'Update',
      arguments: { path: '1235', patch: { metadata: { status: 'fixed' } } },
    });
    expect(update.status).toBe(200);
    const updateBody = (await update.json()) as {
      meta: { version: string; metadata: Record<string, string> };
    };
    expect(updateBody.meta.version).toBe('2');
    expect(updateBody.meta.metadata).toEqual({ status: 'fixed' });

    const del = await post('/htbp/context/feedback/bugs', token, {
      tool: 'Delete',
      arguments: { path: '1235' },
    });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true);

    const getGone = await post('/htbp/context/feedback/bugs', token, {
      tool: 'Get',
      arguments: { path: '1235' },
    });
    expect(getGone.status).toBe(404);
  });
});

describe('POST /htbp/context/<ns> Delete verb (§4.1 Delete)', () => {
  it('Delete removes an object entry (object provider)', async () => {
    await mount({ namespace: 'skills/py', provider: 'object' });
    const token = await signAdmin();
    await post('/htbp/context/skills/py', token, {
      tool: 'Write',
      arguments: { path: 'f', entry: { contentType: 'text/plain', content: 'x' } },
    });
    const del = await post('/htbp/context/skills/py', token, {
      tool: 'Delete',
      arguments: { path: 'f' },
    });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true);
    const get = await post('/htbp/context/skills/py', token, {
      tool: 'Get',
      arguments: { path: 'f' },
    });
    expect(get.status).toBe(404);
  });

  it('Delete on a readOnly mount → 403 permission_denied', async () => {
    await mount({ namespace: 'ro/ns', provider: 'object', readOnly: true });
    const token = await signAdmin();
    const res = await post('/htbp/context/ro/ns', token, {
      tool: 'Delete',
      arguments: { path: 'f' },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('permission_denied');
  });
});

describe('POST /htbp/context/<ns> Search routing (§4.1 Search)', () => {
  // Search happy-path（embed→query→D1）在 provider 单测覆盖（注入 fake AI/Vectorize）；
  // 此处覆盖不触发 AI/Vectorize 的路由分支（provider 无 search、query 非 string）。
  it('Search on a structured mount (no search capability) → 400 invalid_argument', async () => {
    await mount({ namespace: 'feedback/bugs', provider: 'structured' });
    const token = await signAdmin();
    const res = await post('/htbp/context/feedback/bugs', token, {
      tool: 'Search',
      arguments: { query: 'anything' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_argument');
  });

  it('Search on a vector mount with a non-string query → 400 invalid_argument (before embed)', async () => {
    await mount({ namespace: 'research/vec', provider: 'vector' });
    const token = await signAdmin();
    const res = await post('/htbp/context/research/vec', token, {
      tool: 'Search',
      arguments: { query: 42 },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_argument');
  });
});

describe('POST /htbp/context/<ns> guards (§4.2 / 权限)', () => {
  it('rejects a request with no token: 401', async () => {
    await mount({ namespace: 'skills/py', provider: 'object' });
    const res = await post('/htbp/context/skills/py', null, { tool: 'List', arguments: {} });
    expect(res.status).toBe(401);
  });

  it('unknown tool → invalid_argument (400)', async () => {
    await mount({ namespace: 'skills/py', provider: 'object' });
    const token = await signAdmin();
    const res = await post('/htbp/context/skills/py', token, { tool: 'Nope', arguments: {} });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_argument');
  });

  it('unmounted namespace → not_found (404)', async () => {
    const token = await signAdmin();
    const res = await post('/htbp/context/never/mounted', token, { tool: 'List', arguments: {} });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('not_found');
  });

  it('readOnly mount rejects a write verb with 403 permission_denied', async () => {
    await mount({ namespace: 'ro/ns', provider: 'object', readOnly: true });
    const token = await signAdmin();
    const res = await post('/htbp/context/ro/ns', token, {
      tool: 'Write',
      arguments: { path: 'f', entry: { contentType: 'text/plain', content: 'x' } },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('permission_denied');
  });

  it('non-admin is denied a read verb with 403 (default-deny on context://)', async () => {
    await mount({ namespace: 'skills/py', provider: 'object' });
    const token = await signNonAdmin();
    const res = await post('/htbp/context/skills/py', token, { tool: 'List', arguments: {} });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('permission_denied');
  });

  it('access to a TTL-expired mount → not_found (404, lazy reclaim)', async () => {
    await mount({ namespace: 'tmp/scratch', provider: 'object', ttl: 60 });
    // 直接往单例 DO 写过期 mounted_at/expires_at（参照 context-registry.test.ts 手法）。
    await runInDurableObject(registryStub(), (r: ContextRegistry) => {
      const past = new Date(Date.now() - 3600_000).toISOString();
      (r as unknown as { sql: { exec: (q: string, ...b: unknown[]) => unknown } }).sql.exec(
        'UPDATE mounts SET mounted_at = ?, expires_at = ? WHERE namespace = ?',
        past,
        past,
        'tmp/scratch',
      );
    });
    const token = await signAdmin();
    const res = await post('/htbp/context/tmp/scratch', token, { tool: 'List', arguments: {} });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('not_found');
  });
});

describe('GET /htbp/context/<ns>/~help (§11.3a 渐进发现, DoD §5 项 3)', () => {
  it('returns text/plain Help DSL whose cmd lines cover all four verbs', async () => {
    await mount({ namespace: 'skills/py', provider: 'object' });
    const res = await SELF.fetch(`${BASE}/htbp/context/skills/py/~help`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    const parsed = parseHelpDsl(text);
    expect('code' in parsed).toBe(false);
    if ('code' in parsed) return;
    const names = parsed.cmds.map((c) => c.name);
    // 四动词恒有（DoD §5 项 3 验收面）；object provider 另声明 delete → 附一条 Delete cmd。
    for (const verb of ['List', 'Get', 'Write', 'Update']) {
      expect(names).toContain(verb);
    }
    // 每条 cmd 行四段齐全：POST 方法 + 节点路径。
    for (const cmd of parsed.cmds) {
      expect(cmd.method).toBe('POST');
      expect(cmd.path).toBe('/htbp/context/skills/py');
    }
  });

  it('~help is served without authentication (progressive discovery)', async () => {
    await mount({ namespace: 'skills/py', provider: 'object' });
    // 无 Authorization 头也应 200（免认证决策）。
    const res = await SELF.fetch(`${BASE}/htbp/context/skills/py/~help`);
    expect(res.status).toBe(200);
  });

  it('~help on a vector mount adds a Search cmd line', async () => {
    await mount({ namespace: 'research/vec', provider: 'vector' });
    const res = await SELF.fetch(`${BASE}/htbp/context/research/vec/~help`);
    expect(res.status).toBe(200);
    const parsed = parseHelpDsl(await res.text());
    if ('code' in parsed) throw new Error('expected cmds');
    expect(parsed.cmds.map((c) => c.name)).toContain('Search');
  });

  it('~help on an unmounted namespace → not_found (404)', async () => {
    const res = await SELF.fetch(`${BASE}/htbp/context/never/mounted/~help`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('not_found');
  });
});
