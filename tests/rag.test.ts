import { describe, expect, it } from 'vitest';
import { filterRelevantHits, joinChunks, lexicalScore, queryOverlapRatio, splitText, zhBigrams, type RetrievalHit } from '@/lib/ai/rag';

const hit = (content: string, score: number, source = '手册.docx'): RetrievalHit => ({ content, score, source });

describe('zhBigrams（词法候选召回用）', () => {
  it('纯中文整句能切出可命中的二元组', () => {
    const bg = zhBigrams('示例新区的设备综合指数同比排名前了几位');
    // 关键：不能只返回整句——整句 ILIKE 必然 0 命中，这正是修复前的 bug
    expect(bg).not.toContain('示例新区的设备综合指数同比排名前了几位');
    expect(bg).toContain('示例');
    expect(bg).toContain('设备');
    expect(bg).toContain('综合');
    expect(bg.length).toBeLessThanOrEqual(10);
  });

  it('纯实词二元组排在含虚词的二元组前面', () => {
    // 「环境变量的配置」→ 实词 [环境,境变,变量,配置]，虚词二元组 [量的,的配] 垫后
    expect(zhBigrams('环境变量的配置')).toEqual(['环境', '境变', '变量', '配置', '量的', '的配']);
  });

  it('全是虚词的组合被丢弃', () => {
    expect(zhBigrams('的了吗呢')).toEqual([]);
  });

  it('单字与英文不产生二元组（英文由 tokenize 负责）', () => {
    expect(zhBigrams('vib 读数')).toEqual(['读数']);
    expect(zhBigrams('')).toEqual([]);
  });

  it('去重：重复汉字序列不产出重复二元组', () => {
    const bg = zhBigrams('天府天府');
    expect(bg).toEqual(Array.from(new Set(bg)));
  });
});

describe('queryOverlapRatio', () => {
  it('中文按二元组切词，能识别真正相关的片段', () => {
    expect(queryOverlapRatio('如何获取token', '获取接口验证Token 备注：账号和密码')).toBeGreaterThanOrEqual(0.1);
    expect(queryOverlapRatio('设备运行数据怎么查', '设备运行数据接口说明')).toBeGreaterThan(0.5);
  });

  it('无关问题与片段的重合为 0', () => {
    expect(queryOverlapRatio('今天天气怎么样', '湿度 rainFall')).toBe(0);
    expect(queryOverlapRatio('帮我写个周报', '日期 编制')).toBe(0);
    expect(queryOverlapRatio('谢谢', 'pM10_EHI 湿度iehi')).toBe(0);
  });

  it('空问题不产生重合', () => {
    expect(queryOverlapRatio('', '任意文档内容')).toBe(0);
    expect(queryOverlapRatio('   ', '任意文档内容')).toBe(0);
  });

  it('英文/数字按单词切分，大小写不敏感', () => {
    expect(queryOverlapRatio('How to get TOKEN', 'token 有效期为 1 小时')).toBeGreaterThan(0);
  });
});

describe('filterRelevantHits', () => {
  it('丢弃分数不高且词面无重合的命中（无关问题不再带来源）', () => {
    const hits = [hit('湿度 rainFall', 0.49), hit('日期 编制', 0.3), hit('pM10_EHI', 0.21)];
    expect(filterRelevantHits('今天天气怎么样', hits)).toEqual([]);
  });

  it('保留词面有重合的命中，即便向量分不高', () => {
    const hits = [hit('获取接口验证Token 备注：账号和密码', 0.41)];
    expect(filterRelevantHits('如何获取token', hits)).toHaveLength(1);
  });

  it('保留高向量分的命中，即便词面没有重合（同义表达）', () => {
    const hits = [hit('接口鉴权说明', 0.72)];
    expect(filterRelevantHits('怎么拿到访问凭证', hits)).toHaveLength(1);
  });

  it('阈值可配置', () => {
    const hits = [hit('接口鉴权说明', 0.72)];
    expect(filterRelevantHits('怎么拿到访问凭证', hits, { strongScore: 0.8 })).toEqual([]);
  });

  it('空命中直接返回空', () => {
    expect(filterRelevantHits('如何获取token', [])).toEqual([]);
  });
});

describe('splitText（分块合并，防碎片化）', () => {
  // 回归案例：docx 一个视觉行就是一个 w:p，mammoth 还原成「空行分隔的段落」，
  // 旧实现「一段一片」，实测 711 片里 613 片（86%）不足 20 字。
  const docxLike = Array.from({ length: 12 }, (_, i) => `${i + 1}.${i} 获取接口验证Token`).join('\n\n');

  it('相邻短行会合并成一片，而不是一行一片', () => {
    expect(splitText(docxLike).length).toBe(1);
  });

  it('长文本切成接近 size 的片，而不是几百个碎片', () => {
    const rows = Array.from({ length: 80 }, (_, i) => `第${i}行 城市: 示例市；EHI: ${i}`).join('\n\n');
    const parts = splitText(rows);
    expect(parts.length).toBeGreaterThan(1);
    // 单片上限 800；尾片允许并到 1.1×size(880)，再加 80 字重叠 = 961
    expect(parts.every((p) => p.length <= 961)).toBe(true);
    expect(Math.min(...parts.map((p) => p.length))).toBeGreaterThan(200);
  });

  it('超长单句不再被截断丢字', () => {
    const long = '环'.repeat(1900);
    const parts = splitText(long, 800, 0);
    expect(parts.join('').length).toBe(1900);
  });

  it('尾部过短的片会并回上一片', () => {
    const text = `${'甲'.repeat(795)}\n\n${'乙'.repeat(795)}\n\n附：修订记录`;
    const parts = splitText(text, 800, 0);
    expect(parts.length).toBe(2);
    expect(parts[1].endsWith('附：修订记录')).toBe(true);
  });

  it('小数点与版本号不会被当成句末切断', () => {
    // 回归案例：旧正则 `(?<=[。.！!？?；;\n])` 把 '.' 一律当句末，
    // 切碎后再用 '\n' 拼回，正文里就出现「T2.\n5」「0.\n6」这种劈开数字的换行。
    const text = '示例新区温度读数 64.1 ℃，湿度为 94.1，电压为 80；版本 1.3.1 的接口地址见 1.2 节。'.repeat(40);
    const parts = splitText(text, 800, 0);
    const joined = parts.join('\n');
    expect(joined).not.toMatch(/\d\.\n\d/); // 「数字 . 换行 数字」= 小数被劈开
    expect(joined).toContain('温度');
    expect(joined).toContain('1.3.1');
  });

  it('空文本不会抛错', () => {
    expect(splitText('')).toEqual(['']);
    expect(splitText('   ')).toEqual(['   ']);
  });
});

describe('joinChunks（从切片还原原文，供重建切片用）', () => {
  const text = Array.from({ length: 60 }, (_, i) => `第${i}行：这是用于测试的一段正文内容，长度大约二十个字。`).join('\n\n');

  it('剥掉重叠副本后能还原出原文', () => {
    const parts = splitText(text);
    const restored = joinChunks(parts);
    expect(restored.replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
  });

  it('还原后再切，得到的片数与原来一致（重建是幂等的）', () => {
    const parts = splitText(text);
    expect(splitText(joinChunks(parts)).length).toBe(parts.length);
  });

  it('第一片没有重叠可剥，原样保留', () => {
    expect(joinChunks(['只有一片'])).toBe('只有一片');
  });

  // 回归案例：历史数据是「几字一片」，比 overlap(80) 还短。
  // 那时 `contents[i-1].slice(-80)` 拿到的是「上一片全文 + 更早一片的尾巴」，
  // 不匹配任何前缀 → 重叠剥不掉 → 重建后原文每行都变成两行。
  it('切片短于重叠长度时，也不会把原文复制一遍', () => {
    const text = Array.from({ length: 20 }, (_, i) => `第${i}行内容`).join('\n\n');
    const parts = splitText(text, 24, 80);
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.every((p) => p.length < 80)).toBe(true);
    expect(joinChunks(parts, 80).replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
  });
});

describe('lexicalScore（融合打分的词法项必须有界）', () => {
  it('词频再高也不会超过 1（否则 0.62 的闸门阈值失去意义）', () => {
    const doc = Array(50).fill('接口').join(' ');
    expect(lexicalScore('接口', doc)).toBeLessThan(1);
    expect(lexicalScore('接口', doc)).toBeGreaterThan(0.9);
  });

  it('重复越多仍越靠前（单调递增）', () => {
    const a = lexicalScore('接口', '接口 说明');
    const b = lexicalScore('接口', '接口 接口 接口 说明');
    expect(b).toBeGreaterThan(a);
  });

  it('完全不重合得 0', () => {
    expect(lexicalScore('报销', '接口 说明')).toBe(0);
  });
});
