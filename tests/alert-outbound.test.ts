import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  composeAlertDigest,
  readAlertOutbound,
  readAlertPolicy,
  type AlertNotification,
} from '@/lib/agent/quality-alert';

/**
 * 外发消息的组装是纯函数，这里只锁「合并后的信息量够不够定位问题」。
 *
 * 为什么这件事值得单测：外发消息是唯一的跨系统载体——收到的人**不会**登录平台，
 * 如果他手里的那条消息缺了通道/规则/次数，唯一的补救就是手动去查。
 * 而这类「字段漏拼」缺陷在站内通知里看不出来（站内每条都有完整标题）。
 */

const policy = readAlertPolicy();

const issue = (label: string, rule: string): AlertNotification => ({
  kind: 'issue',
  keys: [`skill/${label}#${rule}`],
  title: `质量告警 · skill/${label} · ${rule}`,
  body: `最近 60 分钟内「skill/${label}」有 3 次触发 ${rule}（阻断级）。\n同一问题 6 小时内不再重复提醒。`,
});

describe('composeAlertDigest 合并外发消息', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('没有通知时返回 null（不发空消息）', () => {
    expect(composeAlertDigest([], policy)).toBeNull();
  });

  it('多条问题合并成一条，且每条都带通道/规则/次数', () => {
    const msg = composeAlertDigest([issue('日报', 'empty_answer'), issue('周报', 'fabricated_source')], policy, {
      scanned: 42,
    })!;
    expect(msg).not.toBeNull();
    expect(msg.event).toBe('quality_alert');
    expect(msg.title).toContain('2 项');
    // 定位三要素：谁、什么规则、多严重
    expect(msg.body).toContain('skill/日报');
    expect(msg.body).toContain('empty_answer');
    expect(msg.body).toContain('skill/周报');
    expect(msg.body).toContain('fabricated_source');
    expect(msg.body).toContain('3 次');
    expect(msg.body).toContain('42 条');
  });

  it('问题与恢复同时出现时两段都在（只报问题会让人以为旧毛病还在）', () => {
    const recovery: AlertNotification = {
      kind: 'recovery',
      keys: ['skill/日报#empty_answer'],
      title: '质量告警已解除 · 1 项',
      body: '以下问题在最近 60 分钟内未再达到告警条件：\n· skill/日报#empty_answer\n\n注意：这不等于「已修复」。',
    };
    const msg = composeAlertDigest([issue('周报', 'empty_answer'), recovery], policy)!;
    expect(msg.title).toContain('1 项');
    expect(msg.title).toContain('恢复 1 项');
    expect(msg.body).toContain('已解除');
    // 两段都要在正文里：只留标题会让人以为旧问题已被替换掉
    expect(msg.body).toContain('skill/周报');
  });

  it('被压掉的条数必须写出来（否则「只有 3 条」会被当成全部）', () => {
    const msg = composeAlertDigest([issue('日报', 'empty_answer')], policy, { suppressed: 7 })!;
    expect(msg.body).toContain('7 条');
    expect((msg.meta as any).suppressed).toBe(7);
  });

  it('解析失败单列一段，并说明「不报不等于没问题」', () => {
    const unparsed: AlertNotification = {
      kind: 'unparsed',
      keys: [],
      title: '质量告警自身异常 · 校验日志无法解析',
      body: '最近 60 分钟有 5 行校验日志解析失败。',
    };
    const msg = composeAlertDigest([unparsed], policy)!;
    expect(msg.body).toContain('可能偏低');
    expect((msg.meta as any).unparsed).toBe(1);
  });

  it('meta 是结构化字段（自建接收端要能分流，不必解析中文）', () => {
    const msg = composeAlertDigest([issue('日报', 'empty_answer')], policy, { scanned: 10, suppressed: 2 })!;
    expect(msg.meta).toMatchObject({ issues: 1, recoveries: 0, unparsed: 0, suppressed: 2, scanned: 10 });
  });
});

describe('readAlertOutbound 配置收敛', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('未配置时 urls 为空数组', () => {
    vi.stubEnv('QUALITY_ALERT_WEBHOOK', '');
    expect(readAlertOutbound().urls).toEqual([]);
  });

  it('超过 5 个目标时截断并标记（否则本轮检查会超过锁 TTL，下轮重复告警）', () => {
    vi.stubEnv(
      'QUALITY_ALERT_WEBHOOK',
      Array.from({ length: 8 }, (_, i) => `https://hook${i}.example.com/x`).join(','),
    );
    const cfg = readAlertOutbound();
    expect(cfg.urls).toHaveLength(5);
    expect(cfg.truncatedTargets).toBe(true);
  });

  it('渠道名写错时归一为 raw，而不是丢掉整条配置', () => {
    vi.stubEnv('QUALITY_ALERT_WEBHOOK', 'https://hook.example.com/x');
    vi.stubEnv('QUALITY_ALERT_WEBHOOK_KIND', '企业微信');
    expect(readAlertOutbound().kind).toBe('raw');
  });

  it('接受企微/飞书这类渠道名（大小写不敏感）', () => {
    vi.stubEnv('QUALITY_ALERT_WEBHOOK', 'https://hook.example.com/x');
    vi.stubEnv('QUALITY_ALERT_WEBHOOK_KIND', 'WeCom');
    expect(readAlertOutbound().kind).toBe('wecom');
  });
});
