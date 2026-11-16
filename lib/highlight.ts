// 代码高亮：按需懒加载 highlight.js 与常用语言，避免打进页面初始包。
type Hljs = any;
let hljsPromise: Promise<Hljs> | null = null;

const g = (m: any) => m.default || m;

async function getHljs(): Promise<Hljs> {
  if (!hljsPromise) {
    hljsPromise = (async () => {
      const [
        core,
        js,
        ts,
        py,
        json,
        bash,
        sh,
        sql,
        xml,
        css,
        java,
        go,
        yaml,
        md,
        cpp,
      ] = await Promise.all([
        import('highlight.js/lib/core'),
        import('highlight.js/lib/languages/javascript'),
        import('highlight.js/lib/languages/typescript'),
        import('highlight.js/lib/languages/python'),
        import('highlight.js/lib/languages/json'),
        import('highlight.js/lib/languages/bash'),
        import('highlight.js/lib/languages/shell'),
        import('highlight.js/lib/languages/sql'),
        import('highlight.js/lib/languages/xml'),
        import('highlight.js/lib/languages/css'),
        import('highlight.js/lib/languages/java'),
        import('highlight.js/lib/languages/go'),
        import('highlight.js/lib/languages/yaml'),
        import('highlight.js/lib/languages/markdown'),
        import('highlight.js/lib/languages/cpp'),
      ]);
      const hljs: Hljs = g(core);
      hljs.registerLanguage('javascript', g(js));
      hljs.registerLanguage('js', g(js));
      hljs.registerLanguage('jsx', g(js));
      hljs.registerLanguage('typescript', g(ts));
      hljs.registerLanguage('ts', g(ts));
      hljs.registerLanguage('tsx', g(ts));
      hljs.registerLanguage('python', g(py));
      hljs.registerLanguage('py', g(py));
      hljs.registerLanguage('json', g(json));
      hljs.registerLanguage('bash', g(bash));
      hljs.registerLanguage('sh', g(bash));
      hljs.registerLanguage('shell', g(sh));
      hljs.registerLanguage('sql', g(sql));
      hljs.registerLanguage('html', g(xml));
      hljs.registerLanguage('xml', g(xml));
      hljs.registerLanguage('css', g(css));
      hljs.registerLanguage('java', g(java));
      hljs.registerLanguage('go', g(go));
      hljs.registerLanguage('yaml', g(yaml));
      hljs.registerLanguage('yml', g(yaml));
      hljs.registerLanguage('markdown', g(md));
      hljs.registerLanguage('md', g(md));
      hljs.registerLanguage('cpp', g(cpp));
      hljs.registerLanguage('c', g(cpp));
      return hljs;
    })();
  }
  return hljsPromise;
}

export async function highlightCode(code: string, lang?: string): Promise<string> {
  try {
    const hljs = await getHljs();
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    if (lang) return hljs.highlightAuto(code).value;
  } catch {
    /* 忽略高亮失败，回退纯文本 */
  }
  return '';
}
