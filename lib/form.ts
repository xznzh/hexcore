import type { FormInstance } from 'antd';

/**
 * 安全版表单校验。
 *
 * 为什么需要：Ant Design 的 `form.validateFields()` 在规则不通过时会 **reject**
 * 一个 `errorFields` 对象。业务代码若直接 `await form.validateFields()`，
 * 这个 rejection 没有任何 catch —— 控制台出现 `Uncaught (in promise) Object`，
 * 前端错误上报会被这类「用户输错字」的噪声刷满，React 19 下还可能中断后续逻辑。
 *
 * 用法：
 * ```ts
 * const v = await safeValidate(form);
 * if (!v) return; // 校验失败的红色提示由 Form.Item 自己渲染，这里只需停止提交
 * ```
 */
export async function safeValidate<T = any>(form: FormInstance<T>): Promise<T | null> {
  try {
    return (await form.validateFields()) as T;
  } catch {
    // 校验不通过：错误信息已在对应 Form.Item 下展示，静默返回 null
    return null;
  }
}
