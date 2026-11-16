'use client';

import { useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import ProjectSelect from '@/components/ProjectSelect';
import { getCache, cachedJson } from '@/lib/clientCache';
import {
  Card,
  Table,
  Button,
  Tag,
  Modal,
  Form,
  Input,
  Select,
  InputNumber,
  Switch,
  App,
  Space,
  Typography,
  Dropdown,
  Drawer,
  Empty,
  Divider,
} from 'antd';
import { PlusOutlined, DeleteOutlined, PlayCircleOutlined, ToolOutlined, ThunderboltOutlined, HistoryOutlined, CheckOutlined, ExportOutlined, MoreOutlined, ImportOutlined, DownOutlined, LinkOutlined, RollbackOutlined } from '@ant-design/icons';
import { useGuest } from '@/components/SessionContext';
import { safeValidate } from '@/lib/form';

const { Title, Text, Paragraph } = Typography;

type StepType = 'llm' | 'tool' | 'condition' | 'loop' | 'human';
type Step = {
  role: 'supervisor' | 'planner' | 'worker' | 'critic';
  type?: StepType;
  prompt: string;
  tool?: string;
  contains?: string;
  times?: number;
  requireConfirm?: boolean;
};
type Skill = {
  id: string;
  name: string;
  description: string | null;
  steps: Step[];
  scope: string;
  builtin?: boolean;
  editable?: boolean;
  projectId?: string | null;
  modelId: string | null;
  version: number;
};
/** 历史版本快照：version 是「被快照时的版本号」，回滚即把它写回技能并生成新版本号 */
type VersionSnap = {
  version: number;
  steps: Step[];
  createdAt: number;
  createdBy?: string | null;
};

const ROLE_COLOR: Record<string, string> = {
  supervisor: 'cyan',
  planner: 'blue',
  worker: 'green',
  critic: 'orange',
};
const TYPE_LABEL: Record<string, string> = {
  llm: 'LLM',
  tool: '工具',
  condition: '条件',
  loop: '循环',
  human: '人工确认',
};

export default function SkillsPage() {
  const { message, modal } = App.useApp();
  const isGuest = useGuest();
  const [list, setList] = useState<Skill[]>([]);
  const [open, setOpen] = useState(false);
  const [connectors, setConnectors] = useState<string[]>([]);

  const [runSkill, setRunSkill] = useState<Skill | null>(null);
  const [runInput, setRunInput] = useState('');
  const [running, setRunning] = useState(false);
  const [traj, setTraj] = useState<any>(null);
  const [runId, setRunId] = useState<string>('');
  const [paused, setPaused] = useState(false);

  const [historySkill, setHistorySkill] = useState<Skill | null>(null);
  const [runs, setRuns] = useState<any[]>([]);

  const [verSkill, setVerSkill] = useState<Skill | null>(null);
  const [vers, setVers] = useState<VersionSnap[]>([]);
  const [verLoading, setVerLoading] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);

  const [form] = Form.useForm();
  const [shOpen, setShOpen] = useState(false);
  const [shUrl, setShUrl] = useState('');
  const [shBusy, setShBusy] = useState(false);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const projName = (id?: string | null) => projects.find((p) => p.id === id)?.name || '项目';
  const [steps, setSteps] = useState<Step[]>([
    { role: 'planner', type: 'llm', prompt: '' },
    { role: 'worker', type: 'llm', prompt: '' },
  ]);

  async function load() {
    const c = getCache<any[]>('/api/skills');
    if (c) setList(c);
    const d = await cachedJson<any[]>('/api/skills');
    if (d) setList(d);
  }
  useEffect(() => {
    load();
    fetch('/api/connectors')
      .then((r) => (r.ok ? r.json() : []))
      .then((d: any[]) => setConnectors(d.map((c) => c.name)))
      .catch(() => {});
    fetch('/api/projects')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setProjects(d))
      .catch(() => {});
  }, []);

  function addStep() {
    setSteps((s) => [...s, { role: 'worker', type: 'llm', prompt: '' }]);
  }
  function updateStep(i: number, patch: Partial<Step>) {
    setSteps((s) => s.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  }
  function removeStep(i: number) {
    setSteps((s) => s.filter((_, idx) => idx !== i));
  }

  async function submit() {
    const v = await safeValidate(form);
    if (!v) return;
    if (steps.length === 0 || steps.some((s) => (s.type || 'llm') !== 'human' && !s.prompt.trim())) {
      message.warning('请为每个步骤填写 prompt（人工确认节点可留空）');
      return;
    }
    const r = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...v, steps }),
    });
    if (r.ok) {
      message.success('已保存技能');
      setOpen(false);
      form.resetFields();
      setSteps([
        { role: 'planner', type: 'llm', prompt: '' },
        { role: 'worker', type: 'llm', prompt: '' },
      ]);
      load();
    } else {
      message.error((await r.json().catch(() => ({}))).error || '保存失败');
    }
  }

  async function remove(id: string) {
    await fetch(`/api/skills?id=${id}`, { method: 'DELETE' });
    message.success('已删除');
    load();
  }

  async function importFromSkillsSh() {
    if (!shUrl.trim()) {
      message.warning('请填写技能引用：@handle/slug 或 skills.sh 链接');
      return;
    }
    setShBusy(true);
    try {
      const r = await fetch('/api/skills/import-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: shUrl }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        message.success(`已导入技能：${j.name}`);
        setShOpen(false);
        setShUrl('');
        load();
      } else {
        message.error(j.error || '导入失败');
      }
    } finally {
      setShBusy(false);
    }
  }

  async function importPackage(file: File) {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/api/skills/import', { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      message.success(`已导入技能：${j.name}（${j.steps} 个节点）`);
      load();
    } else {
      message.error(j.error || '导入失败');
    }
    return false;
  }

  function openRun(s: Skill) {
    setRunSkill(s);
    setRunInput('');
    setTraj(null);
    setRunId('');
    setPaused(false);
  }

  async function runNow(inputOverride?: string, resume?: string) {
    const input = inputOverride ?? runInput;
    if (!resume && !input.trim()) return;
    if (!runSkill) return;
    setRunning(true);
    if (!resume) setTraj(null);
    try {
      const r = await fetch('/api/skills/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(resume ? { resume } : { id: runSkill.id, input }),
      });
      const j = await r.json();
      if (r.ok) {
        setTraj({ trajectory: j.trajectory, result: j.result });
        if (j.paused) {
          setPaused(true);
          setRunId(j.runId);
          message.info('已到人工确认点，确认后继续');
        } else {
          setPaused(false);
          message.success('运行完成');
        }
      } else {
        message.error(j.error || '运行失败');
      }
    } finally {
      setRunning(false);
    }
  }

  async function openHistory(s: Skill) {
    setHistorySkill(s);
    const r = await fetch(`/api/skills/runs?id=${s.id}`);
    if (r.ok) setRuns(await r.json());
  }

  async function openVersions(s: Skill) {
    setVerSkill(s);
    setVers([]);
    setVerLoading(true);
    try {
      const r = await fetch(`/api/skills/${s.id}/versions`);
      const j = await r.json().catch(() => ({}));
      if (r.ok) setVers(j.versions || []);
      else message.error(j.error || '读取历史版本失败');
    } finally {
      setVerLoading(false);
    }
  }

  async function doRollback(snap: VersionSnap) {
    if (!verSkill) return;
    // 回滚会覆盖当前编排，是不可撤销的写操作（虽然后端会把回滚前的版本再快照一次），
    // 必须二次确认，避免误点把线上技能改成旧草稿。
    modal.confirm({
      title: `回滚到 v${snap.version}？`,
      content: (
        <div>
          <div>
            当前 <Text code>v{verSkill.version}</Text> 的 {verSkill.steps.length} 个节点将被 v{snap.version} 的 {snap.steps.length} 个节点替换。
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6 }}>
            回滚前的版本会自动留存一份快照，可在历史版本里再滚回来。
          </div>
        </div>
      ),
      okText: '回滚',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setRollingBack(true);
        try {
          const r = await fetch(`/api/skills/${verSkill.id}/rollback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version: snap.version }),
          });
          const j = await r.json().catch(() => ({}));
          if (r.ok) {
            message.success(`已回滚到 v${snap.version}（现在是 v${j.version}）`);
            setVerSkill(null);
            load();
          } else {
            message.error(j.error || '回滚失败');
          }
        } finally {
          setRollingBack(false);
        }
      },
    });
  }

  const columns = [
    {
      title: '名称',
      key: 'name',
      render: (_: any, r: Skill) => (
        <a onClick={() => openRun(r)}>
          <ToolOutlined style={{ color: 'var(--accent)', marginRight: 8 }} />
          <strong>{r.name}</strong>
          <div className="cell-sub">{r.description || '暂无描述'}</div>
        </a>
      ),
    },
    {
      title: '节点',
      key: 'steps',
      width: 210,
      render: (_: any, r: Skill) => (
        <Space size={4} wrap={false}>
          {r.steps.map((s: Step, i: number) => (
            <Tag key={i} color={ROLE_COLOR[s.role]}>
              {s.role}
              {s.type && s.type !== 'llm' ? `·${TYPE_LABEL[s.type]}` : ''}
            </Tag>
          ))}
        </Space>
      ),
    },
    { title: '版本', dataIndex: 'version', key: 'version', width: 78, render: (v: number) => <Tag>v{v}</Tag> },
    {
      title: '作用域',
      key: 'scope',
      width: 150,
      render: (_: any, r: Skill) => (
        <Space size={4} wrap={false}>
          {r.scope === 'builtin' ? (
            <Tag color="cyan">内置</Tag>
          ) : (
            <Tag color={r.scope === 'team' ? 'cyan' : 'default'}>{r.scope === 'team' ? '团队' : '个人'}</Tag>
          )}
          {r.projectId && <Tag color="blue">项目：{projName(r.projectId)}</Tag>}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 132,
      align: 'right' as const,
      render: (_: any, r: Skill) => (
        // 主操作单列，次要操作收进「更多」，避免一排 4 个按钮把行挤爆
        <Space size={6} wrap={false}>
          <Button size="small" icon={<PlayCircleOutlined />} onClick={() => openRun(r)} disabled={isGuest}>
            运行
          </Button>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'history', icon: <HistoryOutlined />, label: '执行历史', onClick: () => openHistory(r) },
                // 版本快照只对技能作者开放（接口侧同样按 owner 鉴权），内置/他人技能不显示该入口
                ...(isGuest || r.editable === false || r.scope === 'builtin'
                  ? []
                  : [{ key: 'versions', icon: <RollbackOutlined />, label: '历史版本', onClick: () => openVersions(r) }]),
                { key: 'export', icon: <ExportOutlined />, label: '导出技能包', onClick: () => window.open(`/api/skills/export?id=${r.id}`, '_blank') },
                ...(isGuest || r.editable === false || r.scope === 'builtin'
                  ? []
                  : [
                      { type: 'divider' as const },
                      {
                        key: 'delete',
                        danger: true,
                        icon: <DeleteOutlined />,
                        label: '删除技能',
                        onClick: () => {
                          modal.confirm({
                            title: '确认删除？',
                            content: `将删除技能「${r.name}」，此操作不可撤销。`,
                            okText: '删除',
                            okButtonProps: { danger: true },
                            cancelText: '取消',
                            onOk: () => remove(r.id),
                          });
                        },
                      },
                    ]),
              ],
            }}
          >
            <Button size="small" icon={<MoreOutlined />} aria-label="技能更多操作" />
          </Dropdown>
        </Space>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title={<><ThunderboltOutlined /> 技能编排（多 Agent）</>}
        desc="声明式节点编排：LLM / 工具 / 条件 / 循环 / 人工确认。步骤间用 {{input}}（原始输入）与 {{prev}}（上一步产出）串联；Critic 判定 FAIL 时自动重试。"
        extra={
          isGuest ? (
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>访客为只读角色，可查看既有技能，但无法运行或编排</span>
          ) : (
            <Space>
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [
                    {
                      key: 'pkg',
                      icon: <ImportOutlined />,
                      label: '导入技能包（.zip）',
                      onClick: () => document.getElementById('skill-pkg-input')?.click(),
                    },
                    {
                      key: 'url',
                      icon: <LinkOutlined />,
                      label: '从技能源导入',
                      onClick: () => setShOpen(true),
                    },
                  ],
                }}
              >
                <Button icon={<ImportOutlined />}>
                  导入 <DownOutlined style={{ fontSize: 10 }} />
                </Button>
              </Dropdown>
              <input
                id="skill-pkg-input"
                type="file"
                accept=".zip"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) importPackage(f);
                  e.currentTarget.value = '';
                }}
              />
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
                新建技能
              </Button>
            </Space>
          )
        }
      />
      <Card>
        <Table
          rowKey="id"
          dataSource={list}
          columns={columns}
          pagination={list.length > 10 ? { pageSize: 10, showSizeChanger: false, size: 'small' } : false}
        />
      </Card>

      {/* 编辑技能 */}
      <Modal
        title="从技能源导入技能"
        open={shOpen}
        onOk={importFromSkillsSh}
        confirmLoading={shBusy}
        onCancel={() => setShOpen(false)}
        okText="导入"
        cancelText="取消"
        destroyOnHidden
      >
        <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>
          支持：<code>@handle/slug</code>（SkillHub，如 <code>@user_3b34947d/ppt-generator-skill</code>）、
          <code>https://skillhub.cn/@handle/slug</code>、<code>https://skills.sh/owner/repo/skill</code>、
          <code>https://github.com/owner/repo --skill skill</code>、<code>owner/repo/skill</code>。
          只填 <code>owner/repo</code> 时会列出该仓库的技能供选择。
          <br />
          只导入 <code>SKILL.md</code> 正文；技能包自带的脚本文件本平台不会执行。
        </div>
        <Input
          value={shUrl}
          onChange={(e) => setShUrl(e.target.value)}
          placeholder="@handle/slug 或 https://skills.sh/owner/repo/skill"
        />
      </Modal>

      <Modal title="新建技能" open={open} onOk={submit} onCancel={() => setOpen(false)} okText="保存" cancelText="取消" width={760} destroyOnHidden>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="技能名" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：需求拆解器" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} placeholder="这个技能做什么" />
          </Form.Item>
          <Form.Item name="scope" label="作用域" initialValue="personal">
            <Select options={[{ value: 'personal', label: '个人' }, { value: 'team', label: '团队' }]} />
          </Form.Item>
          <Form.Item name="projectId" label="归属项目（可选）">
            <ProjectSelect />
          </Form.Item>
          <Divider orientation="left">节点编排</Divider>
          {steps.map((st, i) => {
            const type = st.type || 'llm';
            return (
              <Card key={i} size="small" style={{ marginBottom: 10, borderLeft: `3px solid var(--accent)` }}>
                <Space wrap style={{ marginBottom: 8 }}>
                  <Select
                    value={type}
                    style={{ width: 110 }}
                    onChange={(v) => updateStep(i, { type: v as StepType })}
                    options={(['llm', 'tool', 'condition', 'loop', 'human'] as StepType[]).map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
                  />
                  <Select
                    value={st.role}
                    style={{ width: 130 }}
                    onChange={(v) => updateStep(i, { role: v as Step['role'] })}
                    options={[
                      { value: 'supervisor', label: 'supervisor' },
                      { value: 'planner', label: 'planner' },
                      { value: 'worker', label: 'worker' },
                      { value: 'critic', label: 'critic' },
                    ]}
                  />
                  {type === 'tool' && (
                    <Select
                      value={st.tool || 'search_knowledge'}
                      style={{ width: 180 }}
                      onChange={(v) => updateStep(i, { tool: v })}
                      options={[
                        { value: 'search_knowledge', label: '内置：检索知识库' },
                        { value: 'read_file', label: '内置：读取文件' },
                        { value: 'sandbox', label: '内置：代码沙箱(JS)' },
                        ...connectors.map((c) => ({ value: c, label: `连接器：${c}` })),
                      ]}
                    />
                  )}
                  {type === 'condition' && (
                    <Input
                      value={st.contains || ''}
                      onChange={(e) => updateStep(i, { contains: e.target.value })}
                      placeholder="prev 需包含的关键词"
                      style={{ width: 200 }}
                    />
                  )}
                  {type === 'loop' && (
                    <Space>
                      <span style={{ color: 'var(--muted)' }}>次数</span>
                      <InputNumber min={1} max={10} value={st.times || 2} onChange={(v) => updateStep(i, { times: Number(v) })} />
                    </Space>
                  )}
                  {type === 'human' && (
                    <Space>
                      <span style={{ color: 'var(--muted)' }}>需人工确认</span>
                      <Switch checked={!!st.requireConfirm} onChange={(v) => updateStep(i, { requireConfirm: v })} />
                    </Space>
                  )}
                  <Button danger icon={<DeleteOutlined />} aria-label="删除步骤" onClick={() => removeStep(i)} />
                </Space>
                {type !== 'human' && (
                  <Input.TextArea
                    value={st.prompt}
                    onChange={(e) => updateStep(i, { prompt: e.target.value })}
                    placeholder={type === 'tool' ? '传给工具的输入，可用 {{input}} / {{prev}}（留空则用上一步产出）' : '本步骤 prompt，可用 {{input}} / {{prev}}'}
                    rows={2}
                  />
                )}
              </Card>
            );
          })}
          <Button type="dashed" icon={<PlusOutlined />} onClick={addStep}>
            添加节点
          </Button>
        </Form>
      </Modal>

      {/* 运行 + 轨迹 */}
      <Drawer title={`运行技能：${runSkill?.name || ''}`} open={!!runSkill} onClose={() => setRunSkill(null)} width={720}>
        <Input.TextArea
          value={runInput}
          onChange={(e) => setRunInput(e.target.value)}
          rows={4}
          placeholder="输入交给该技能的初始任务 / 问题"
          style={{ marginBottom: 12 }}
        />
        <Space>
          <Button type="primary" loading={running} icon={<PlayCircleOutlined />} onClick={() => runNow()} disabled={isGuest}>
            运行
          </Button>
          {paused && (
            <Button icon={<CheckOutlined />} loading={running} onClick={() => runNow(undefined, runId)}>
              确认并继续
            </Button>
          )}
        </Space>
        {traj && (
          <div style={{ marginTop: 20 }}>
            <Title level={5}>执行轨迹</Title>
            {traj.trajectory?.map((t: any, i: number) => (
              <Card key={i} size="small" style={{ marginBottom: 10, borderLeft: `3px solid var(--accent)` }}>
                <Space>
                  <Tag color={ROLE_COLOR[t.role] || 'default'}>{t.role}</Tag>
                  {t.type && t.type !== 'llm' && <Tag>{TYPE_LABEL[t.type] || t.type}</Tag>}
                  {t.tool && <Tag color="blue">{t.tool}</Tag>}
                </Space>
                <Paragraph style={{ marginTop: 8, whiteSpace: 'pre-wrap', marginBottom: 0 }}>{t.output}</Paragraph>
              </Card>
            ))}
            <Title level={5}>最终结果</Title>
            <Card size="small">
              <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{traj.result}</Paragraph>
            </Card>
            {!traj.trajectory?.length && <Empty description="无轨迹（可能模型未配置）" />}
          </div>
        )}
      </Drawer>

      {/* 历史 */}
      <Drawer title={`执行历史：${historySkill?.name || ''}`} open={!!historySkill} onClose={() => setHistorySkill(null)} width={720}>
        {runs.length === 0 && <Empty description="暂无运行记录" />}
        {runs.map((r) => (
          <Card
            key={r.id}
            size="small"
            style={{ marginBottom: 10 }}
            title={
              <Space>
                <Tag color={r.status === 'done' ? 'green' : r.status === 'paused' ? 'gold' : 'red'}>{r.status}</Tag>
                <Text type="secondary" style={{ fontSize: 12 }}>{new Date(r.createdAt).toLocaleString()}</Text>
              </Space>
            }
            extra={
              <Button size="small" onClick={() => { if (historySkill) { setHistorySkill(null); openRun(historySkill); setRunInput(r.input); } }}>
                回放
              </Button>
            }
          >
            <Text strong>输入：</Text>
            <Paragraph style={{ whiteSpace: 'pre-wrap' }}>{r.input}</Paragraph>
            <Text strong>结果：</Text>
            <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{r.result || '—'}</Paragraph>
          </Card>
        ))}
      </Drawer>

      {/* 历史版本 */}
      <Drawer title={`历史版本：${verSkill?.name || ''}`} open={!!verSkill} onClose={() => setVerSkill(null)} width={640}>
        {verLoading && <Empty description="读取中…" />}
        {!verLoading && vers.length === 0 && <Empty description="暂无历史版本（修改并保存过编排后才会生成快照）" />}
        {!verLoading && vers.length > 0 && (
          <>
            <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 12 }}>
              当前生效：<Text code>v{verSkill?.version}</Text>。下列快照在每次保存时自动留存，回滚会写入旧编排并生成一个新版本号。
            </div>
            {vers.map((v) => (
              <Card
                key={v.version}
                size="small"
                style={{ marginBottom: 10 }}
                title={
                  <Space>
                    <Tag color="blue">v{v.version}</Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>{new Date(v.createdAt).toLocaleString()}</Text>
                  </Space>
                }
                extra={
                  <Button size="small" icon={<RollbackOutlined />} loading={rollingBack} onClick={() => doRollback(v)}>
                    回滚
                  </Button>
                }
              >
                <Space size={4} wrap>
                  {v.steps.length === 0 && <Text type="secondary">快照为空或无法解析</Text>}
                  {v.steps.map((st, i) => (
                    <Tag key={i} color={ROLE_COLOR[st.role]}>
                      {st.role}
                      {st.type && st.type !== 'llm' ? `·${TYPE_LABEL[st.type]}` : ''}
                    </Tag>
                  ))}
                </Space>
              </Card>
            ))}
          </>
        )}
      </Drawer>
    </div>
  );
}
