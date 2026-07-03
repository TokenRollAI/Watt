import { describe, expect, it } from 'vitest';
import { generateContextHelp, parseHelpDsl } from './help.ts';

/**
 * Help DSL 生成器 + parser 用例（test-first，HTBP Reference §2.1；DoD 项 3）。
 * 对拍：generate 输出 parse 回来断言四动词 cmd 行完整齐全。
 */

describe('generateContextHelp', () => {
  it('四动词各一条 cmd 行（无可选能力）', () => {
    const text = generateContextHelp('feedback/bugs', {});
    expect(text).toContain('cmd List POST /htbp/context/feedback/bugs');
    expect(text).toContain('cmd Get POST /htbp/context/feedback/bugs');
    expect(text).toContain('cmd Write POST /htbp/context/feedback/bugs');
    expect(text).toContain('cmd Update POST /htbp/context/feedback/bugs');
    expect(text).not.toContain('cmd Search');
    expect(text).not.toContain('cmd Delete');
  });

  it('scope 属性行：读动词 read / 写动词 write', () => {
    const text = generateContextHelp('x', {});
    expect(text).toMatch(/cmd List POST \/htbp\/context\/x\n {2}scope read/);
    expect(text).toMatch(/cmd Write POST \/htbp\/context\/x\n {2}scope write/);
  });

  it('capabilities.search → 追加 Search 行', () => {
    const text = generateContextHelp('mem', { search: true });
    expect(text).toContain('cmd Search POST /htbp/context/mem');
  });

  it('capabilities.delete → 追加 Delete 行', () => {
    const text = generateContextHelp('mem', { delete: true });
    expect(text).toContain('cmd Delete POST /htbp/context/mem');
  });
});

describe('parseHelpDsl', () => {
  it('解析 cmd 行为 {name, method, path}', () => {
    const r = parseHelpDsl('cmd List POST /htbp/context/x\n');
    expect(r).toEqual({ cmds: [{ name: 'List', method: 'POST', path: '/htbp/context/x' }] });
  });

  it('跳过属性行、空行、纯空白行', () => {
    const text = 'cmd Get POST /p\n  scope read\n\n   \n';
    const r = parseHelpDsl(text);
    expect(r).toEqual({ cmds: [{ name: 'Get', method: 'POST', path: '/p' }] });
  });

  it('跳过非 cmd 顶格行', () => {
    const r = parseHelpDsl('note something\ncmd Get POST /p\n');
    expect(r).toEqual({ cmds: [{ name: 'Get', method: 'POST', path: '/p' }] });
  });

  it('缺段 cmd 行 → invalid_argument', () => {
    expect(parseHelpDsl('cmd Get POST\n')).toMatchObject({ code: 'invalid_argument' });
    expect(parseHelpDsl('cmd Get\n')).toMatchObject({ code: 'invalid_argument' });
    expect(parseHelpDsl('cmd\n')).toMatchObject({ code: 'invalid_argument' });
  });
});

describe('对拍：generate → parse 四动词完整', () => {
  it('无可选能力：parse 出恰好四条 cmd 且方法名齐全', () => {
    const parsed = parseHelpDsl(generateContextHelp('feedback/bugs', {}));
    expect('code' in parsed).toBe(false);
    if ('code' in parsed) return; // narrow
    const names = parsed.cmds.map((c) => c.name);
    expect(names).toEqual(['List', 'Get', 'Write', 'Update']);
    for (const c of parsed.cmds) {
      expect(c.method).toBe('POST');
      expect(c.path).toBe('/htbp/context/feedback/bugs');
    }
  });

  it('含 search+delete：parse 出六条 cmd', () => {
    const parsed = parseHelpDsl(generateContextHelp('mem', { search: true, delete: true }));
    if ('code' in parsed) throw new Error('unexpected error');
    expect(parsed.cmds.map((c) => c.name)).toEqual([
      'List',
      'Get',
      'Write',
      'Update',
      'Search',
      'Delete',
    ]);
  });
});
