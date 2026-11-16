import { describe, expect, it } from 'vitest';
import { diffCapabilities, parseAuthSchemes, parseOpenApi, resolveBaseUrl } from '@/lib/connectors/openapi';
import {
  buildCapabilityRequest,
  capabilityAllowed,
  detectBusinessError,
  formatInputErrors,
  grantAllows,
  validateCapabilityInput,
} from '@/lib/capabilities';

const spec3 = {
  openapi: '3.0.0',
  info: { title: 'Demo API', version: '1.0.0' },
  servers: [{ url: 'https://api.demo.com/v1/' }],
  paths: {
    '/quotes/{code}': {
      get: {
        operationId: 'getQuote',
        summary: '查询行情',
        description: '按代码查询实时行情',
        parameters: [
          { name: 'code', in: 'path', required: true, description: '证券代码', schema: { type: 'string' } },
          { name: 'fields', in: 'query', schema: { type: 'string' } },
          { name: 'X-Token', in: 'header', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/orders': {
      post: {
        summary: '创建订单',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['amount'],
                properties: {
                  amount: { type: 'number', description: '金额' },
                  memo: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'ok' } },
      },
    },
    '/health': { get: { responses: { '200': { description: 'ok' } } } },
  },
};

describe('lib/connectors/openapi parseOpenApi', () => {
  it('OpenAPI 3.x：解析 baseUrl、路径/查询/请求头参数与请求体', () => {
    const parsed = parseOpenApi(spec3);
    expect(parsed.title).toBe('Demo API');
    expect(parsed.version).toBe('1.0.0');
    expect(parsed.baseUrl).toBe('https://api.demo.com/v1');
    expect(parsed.candidates).toHaveLength(3);

    const quote = parsed.candidates.find((c) => c.key === 'getQuote')!;
    expect(quote.method).toBe('GET');
    expect(quote.path).toBe('/quotes/{code}');
    expect(quote.inputSchema.required).toEqual(['code', 'X-Token']);
    expect(Object.keys(quote.inputSchema.properties)).toEqual(['code', 'fields', 'X-Token']);
    expect(quote.description).toContain('查询行情');
    expect(quote.fingerprint).toMatch(/^[0-9a-f]{16}$/);

    const order = parsed.candidates.find((c) => c.path === '/orders')!;
    expect(order.method).toBe('POST');
    expect(order.inputSchema.required).toEqual(['amount']);
    expect(Object.keys(order.inputSchema.properties)).toEqual(['amount', 'memo']);
    expect(order.parameters.filter((p) => p.in === 'body')).toHaveLength(2);
  });

  it('Swagger 2.0：解析 host/basePath/schemes 与 body 展开', () => {
    const swagger = {
      swagger: '2.0',
      info: { title: 'Legacy', version: '2' },
      host: 'api.legacy.com',
      basePath: '/api',
      schemes: ['https'],
      paths: {
        '/users/{id}': {
          get: {
            parameters: [
              { name: 'id', in: 'path', required: true, type: 'string' },
              { name: 'q', in: 'query', type: 'string' },
            ],
          },
        },
        '/users': {
          post: {
            parameters: [
              {
                name: 'payload',
                in: 'body',
                required: true,
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: { name: { type: 'string' }, age: { type: 'integer' } },
                },
              },
            ],
          },
        },
      },
    };
    const parsed = parseOpenApi(swagger as any);
    expect(parsed.baseUrl).toBe('https://api.legacy.com/api');
    const get = parsed.candidates.find((c) => c.method === 'GET')!;
    expect(get.inputSchema.required).toEqual(['id']);
    const post = parsed.candidates.find((c) => c.method === 'POST')!;
    expect(post.inputSchema.required).toEqual(['name']);
    expect(Object.keys(post.inputSchema.properties)).toEqual(['name', 'age']);
    // 不应残留 Swagger 的 body 参数本身
    expect(post.parameters.some((p) => p.name === 'payload')).toBe(false);
  });

  it('同名操作自动加后缀，避免 key 冲突', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Dup' },
      paths: {
        '/a': { get: { summary: '列表' } },
        '/b': { get: { summary: '列表' } },
      },
    };
    const parsed = parseOpenApi(spec as any);
    expect(new Set(parsed.candidates.map((c) => c.key)).size).toBe(2);
  });
});

describe('lib/connectors/openapi parseAuthSchemes', () => {
  it('OpenAPI 3.x：识别全局 apiKey（query）', () => {
    const auth = parseAuthSchemes({
      openapi: '3.0.3',
      security: [{ AppKeyAuth: [] }],
      components: {
        securitySchemes: {
          AppKeyAuth: { type: 'apiKey', in: 'query', name: 'appKey', description: 'DemoAPI 控制台的 appKey' },
        },
      },
      paths: { '/88-01': { post: {} } },
    });
    expect(auth).toEqual([{ name: 'appKey', in: 'query', description: 'DemoAPI 控制台的 appKey' }]);
  });

  it('Swagger 2.0：识别 securityDefinitions（header）', () => {
    const auth = parseAuthSchemes({
      swagger: '2.0',
      securityDefinitions: { KeyAuth: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } },
      security: [{ KeyAuth: [] }],
      paths: {},
    });
    expect(auth).toEqual([{ name: 'X-Api-Key', in: 'header', description: undefined }]);
  });

  it('没有全局 security 时汇总各 operation 的声明；非 apiKey 忽略', () => {
    const auth = parseAuthSchemes({
      openapi: '3.0.0',
      components: {
        securitySchemes: {
          Q: { type: 'apiKey', in: 'query', name: 'token' },
          OAuth: { type: 'oauth2', flows: {} },
        },
      },
      paths: {
        '/a': { get: { security: [{ Q: [] }] } },
        '/b': { get: { security: [{ OAuth: [] }] } },
      },
    });
    expect(auth).toEqual([{ name: 'token', in: 'query', description: undefined }]);
  });

  it('相对 securitySchemes 的 $ref 也能解析', () => {
    const auth = parseAuthSchemes({
      openapi: '3.0.0',
      security: [{ Key: [] }],
      components: { securitySchemes: { Key: { $ref: '#/components/securitySchemes/Real' }, Real: { type: 'apiKey', in: 'query', name: 'appKey' } } },
    });
    expect(auth).toEqual([{ name: 'appKey', in: 'query', description: undefined }]);
  });

  it('未声明认证时返回空数组', () => {
    expect(parseAuthSchemes({ paths: {} })).toEqual([]);
  });
});

describe('lib/connectors/openapi diffCapabilities', () => {  it('区分新增 / 变更 / 未变 / 移除', () => {
    const existing = [
      { key: 'a', fingerprint: '1' },
      { key: 'b', fingerprint: '2' },
      { key: 'gone', fingerprint: '3' },
    ];
    const incoming = [
      { key: 'a', fingerprint: '1' },
      { key: 'b', fingerprint: '99' },
      { key: 'new', fingerprint: '4' },
    ];
    const d = diffCapabilities(existing, incoming);
    expect(d.added.map((x) => x.key)).toEqual(['new']);
    expect(d.updated.map((x) => x.key)).toEqual(['b']);
    expect(d.unchanged.map((x) => x.key)).toEqual(['a']);
    expect(d.removed.map((x) => x.key)).toEqual(['gone']);
  });
});

describe('lib/capabilities buildCapabilityRequest', () => {
  const parameters = [
    { name: 'code', in: 'path' as const, required: true },
    { name: 'fields', in: 'query' as const, required: false },
    { name: 'X-Token', in: 'header' as const, required: false },
    { name: 'amount', in: 'body' as const, required: true },
    { name: 'memo', in: 'body' as const, required: false },
  ];

  it('POST：路径编码、查询参数、请求头与 JSON body', () => {
    const req = buildCapabilityRequest({
      baseUrl: 'https://api.demo.com/v1/',
      method: 'POST',
      path: '/orders/{code}',
      parameters,
      input: { code: 'A 1', fields: 'f2,f3', 'X-Token': 'tk', amount: 10, memo: '备注' },
    });
    expect(req.url).toBe('https://api.demo.com/v1/orders/A%201?fields=f2%2Cf3');
    expect(req.method).toBe('POST');
    expect(req.headers['X-Token']).toBe('tk');
    expect(req.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(req.body || '{}')).toEqual({ amount: 10, memo: '备注' });
  });

  it('GET：不产生 body，数组参数重复展开', () => {
    const req = buildCapabilityRequest({
      baseUrl: 'https://api.demo.com',
      method: 'GET',
      path: '/search',
      parameters: [{ name: 'tag', in: 'query', required: false }],
      input: { tag: ['a', 'b'] },
    });
    expect(req.url).toBe('https://api.demo.com/search?tag=a&tag=b');
    expect(req.body).toBeUndefined();
  });

  it('baseUrl 为空且 path 为绝对地址时直接使用', () => {
    const req = buildCapabilityRequest({
      baseUrl: '',
      method: 'GET',
      path: 'https://other.example.com/x',
      parameters: [],
      input: {},
    });
    expect(req.url).toBe('https://other.example.com/x');
  });

  it('连接器配置的 query 会自动注入，且调用入参优先', () => {
    const req = buildCapabilityRequest({
      baseUrl: 'https://api.demo-service.com',
      method: 'POST',
      path: '/88-01',
      parameters: [{ name: 'fields', in: 'query', required: false }],
      input: { fields: 'from-input' },
      connectorConfig: { query: { fields: 'from-config', appKey: 'k1' } },
    });
    expect(req.url).toBe('https://api.demo-service.com/88-01?fields=from-input&appKey=k1');
  });

  it('配置 query 里的对象/数组按现有规则展开', () => {
    const req = buildCapabilityRequest({
      baseUrl: 'https://api.demo.com',
      method: 'GET',
      path: '/x',
      parameters: [],
      input: {},
      connectorConfig: { query: { tag: ['a', 'b'], filter: { k: 1 } } },
    });
    const u = new URL(req.url);
    expect(u.searchParams.getAll('tag')).toEqual(['a', 'b']);
    expect(u.searchParams.get('filter')).toBe('{"k":1}');
  });
});

describe('lib/capabilities detectBusinessError', () => {
  it('DemoAPI 缺少 appKey（-1002）给出配置提示', () => {
    const msg = detectBusinessError(
      JSON.stringify({ demoapi_res_code: -1002, demoapi_res_error: 'appKey err', demoapi_res_body: {} }),
    );
    expect(msg).toContain('appKey err');
    expect(msg).toContain('-1002');
    expect(msg).toContain('"query"');
  });

  it('DemoAPI appKey 无效（-1004）给出核对提示', () => {
    const msg = detectBusinessError(JSON.stringify({ demoapi_res_code: -1004, demoapi_res_error: 'appKey err' }));
    expect(msg).toContain('-1004');
    expect(msg).toContain('无效');
  });

  it('demoapi_res_code=0 / 非 DemoAPI 响应 / 非 JSON 均不误判', () => {
    expect(detectBusinessError(JSON.stringify({ demoapi_res_code: 0, demoapi_res_body: { ehi: 1 } }))).toBeNull();
    expect(detectBusinessError(JSON.stringify({ code: 500, message: 'oops' }))).toBeNull();
    expect(detectBusinessError('plain text')).toBeNull();
    expect(detectBusinessError('[]')).toBeNull();
  });

  it('Open-Meteo 城市名查不到时给出拼音提示（HTTP 200 但业务失败）', () => {
    const msg = detectBusinessError(JSON.stringify({ status: 'error', data: 'Unknown station' }));
    expect(msg).toContain('Unknown station');
    expect(msg).toContain('拼音');
  });

  it('Open-Meteo token 无效/超额时给出换 token 提示', () => {
    expect(detectBusinessError(JSON.stringify({ status: 'error', data: 'Invalid key' }))).toContain('token');
    expect(detectBusinessError(JSON.stringify({ status: 'error', data: 'Over quota' }))).toContain('token');
  });

  it('Open-Meteo 成功响应不误判', () => {
    expect(detectBusinessError(JSON.stringify({ status: 'ok', data: { ehi: 53 } }))).toBeNull();
    // data 为对象（不是字符串）时不进入 Open-Meteo 分支，避免误伤别的网关
    expect(detectBusinessError(JSON.stringify({ status: 'error', data: { code: 1 } }))).toBeNull();
  });
});

describe('lib/capabilities validateCapabilityInput', () => {
  const schema = {
    type: 'object',
    required: ['code'],
    properties: {
      code: { type: 'string' },
      limit: { type: 'integer' },
      flag: { type: 'boolean' },
      side: { type: 'string', enum: ['buy', 'sell'] },
      tags: { type: 'array' },
    },
  };

  it('全部合法时无错误', () => {
    expect(validateCapabilityInput(schema, { code: 'AAPL', limit: 5, flag: true, side: 'buy', tags: [] })).toEqual([]);
  });

  it('缺少必填 / 空白字符串算缺失', () => {
    expect(validateCapabilityInput(schema, {})).toHaveLength(1);
    expect(validateCapabilityInput(schema, { code: '   ' })).toEqual([{ field: 'code', message: '缺少必填参数 code' }]);
  });

  it('类型不符与枚举外取值会被拦下', () => {
    const errors = validateCapabilityInput(schema, { code: 1, limit: 1.5, side: 'hold', flag: 'yes' });
    expect(errors.map((e) => e.field).sort()).toEqual(['code', 'flag', 'limit', 'side']);
    expect(formatInputErrors(errors)).toContain('只能是：buy / sell');
  });

  it('不拒绝 schema 之外的字段；坏 schema / 字符串入参不抛错', () => {
    expect(validateCapabilityInput(schema, { code: 'X', extra: 'ok' })).toEqual([]);
    expect(validateCapabilityInput('not-json', { a: 1 })).toEqual([]);
    expect(validateCapabilityInput({}, null)).toEqual([]);
  });
});

describe('lib/connectors/openapi resolveBaseUrl', () => {
  it('相对 servers[].url 按文档地址补全为绝对地址', () => {
    expect(resolveBaseUrl('/api/v3', 'https://petstore3.swagger.io/api/v3/openapi.json')).toBe(
      'https://petstore3.swagger.io/api/v3',
    );
    expect(resolveBaseUrl('v2', 'https://demo.com/api/openapi.json')).toBe('https://demo.com/api/v2');
  });

  it('已是绝对地址时原样返回并去掉尾部斜杠', () => {
    expect(resolveBaseUrl('https://api.demo.com/v1/', 'https://other.com/openapi.json')).toBe('https://api.demo.com/v1');
    expect(resolveBaseUrl('HTTP://api.demo.com/v1', null)).toBe('HTTP://api.demo.com/v1');
  });

  it('空地址 / 无文档地址时不会抛错', () => {
    expect(resolveBaseUrl('', 'https://demo.com/openapi.json')).toBe('');
    expect(resolveBaseUrl(null, 'https://demo.com/openapi.json')).toBe('');
    expect(resolveBaseUrl('/api/v3')).toBe('/api/v3');
    expect(resolveBaseUrl('/api/v3/', 'not a url')).toBe('/api/v3');
  });
});

describe('lib/capabilities 权限判定', () => {
  const actor = { userId: 'u1', role: 'member' };

  it('管理员始终可用', () => {
    expect(grantAllows([{ subjectType: 'user', subjectId: 'u2' }], { userId: 'admin', role: 'admin' })).toBe(true);
  });

  it('无授权记录时按角色放行', () => {
    expect(grantAllows([], actor)).toBe(true);
    expect(
      capabilityAllowed({
        actor,
        minRole: 'member',
        visibleRoles: '["admin","member"]',
        connectorGrants: [],
        capabilityGrants: [],
      }),
    ).toBe(true);
  });

  it('存在授权白名单时仅命中用户/角色可用', () => {
    const grants = [{ subjectType: 'user', subjectId: 'u2' }];
    expect(grantAllows(grants, actor)).toBe(false);
    expect(grantAllows(grants, { userId: 'u2', role: 'member' })).toBe(true);
    expect(grantAllows([{ subjectType: 'role', subjectId: 'member' }], actor)).toBe(true);
  });

  it('角色不足 / 连接器撤销 / 能力停用时拒绝', () => {
    const base = {
      actor,
      minRole: 'member',
      visibleRoles: '["admin","member"]',
      connectorGrants: [],
      capabilityGrants: [],
    };
    expect(capabilityAllowed({ ...base, visibleRoles: '["admin"]' })).toBe(false);
    expect(capabilityAllowed({ ...base, connectorStatus: 'revoked' })).toBe(false);
    expect(capabilityAllowed({ ...base, capabilityStatus: 'disabled' })).toBe(false);
    expect(capabilityAllowed({ ...base, minRole: 'admin' })).toBe(false);
  });
});
