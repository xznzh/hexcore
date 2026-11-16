import { describe, expect, it } from 'vitest';
import { parseSkillRef, parseFrontmatter } from '@/lib/skills/hub';

describe('lib/skills/hub 技能引用解析', () => {
  it('解析 @handle/slug（SkillHub）', () => {
    const r = parseSkillRef('@user_3b34947d/ppt-generator-skill');
    expect(r).toMatchObject({ source: 'skillhub', handle: 'user_3b34947d', slug: 'ppt-generator-skill' });
  });

  it('解析 skillhub.cn 链接', () => {
    const r = parseSkillRef('https://skillhub.cn/@user_3b34947d/ppt-generator-skill');
    expect(r).toMatchObject({ source: 'skillhub', handle: 'user_3b34947d', slug: 'ppt-generator-skill' });
  });

  it('解析 skills.sh 链接为 GitHub 来源', () => {
    const r = parseSkillRef('https://skills.sh/vercel-labs/agent-skills/ppt');
    expect(r).toMatchObject({ source: 'github', owner: 'vercel-labs', repo: 'agent-skills', slug: 'ppt' });
  });

  it('解析 GitHub 链接与 --skill 参数', () => {
    const r = parseSkillRef('https://github.com/owner/repo --skill my-skill');
    expect(r).toMatchObject({ source: 'github', owner: 'owner', repo: 'repo', slug: 'my-skill' });
  });

  it('解析裸 owner/repo/skill', () => {
    const r = parseSkillRef('owner/repo/skill');
    expect(r).toMatchObject({ source: 'github', owner: 'owner', repo: 'repo', slug: 'skill' });
  });

  it('无法解析时返回 null', () => {
    expect(parseSkillRef('')).toBeNull();
    expect(parseSkillRef('随便一句话')).toBeNull();
  });

  it('解析 SKILL.md frontmatter', () => {
    const md = '---\nname: ppt-generator\ndescription: 智能 PPT 生成助手\n---\n\n# 正文\n内容';
    const fm = parseFrontmatter(md);
    expect(fm.name).toBe('ppt-generator');
    expect(fm.description).toBe('智能 PPT 生成助手');
    expect(fm.body).toContain('# 正文');
  });

  it('无 frontmatter 时整篇作为正文', () => {
    const fm = parseFrontmatter('# 只有正文');
    expect(fm.name).toBe('');
    expect(fm.body).toContain('只有正文');
  });
});
