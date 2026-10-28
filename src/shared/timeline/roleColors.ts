/**
 * 角色 → uid badge 配色。
 *
 * **这是 badge 颜色的唯一来源。** 时间线条目上的 badge 与主区身份相关的 badge
 * 必须同色 —— 读者靠颜色而不是文字判断「这条来自哪一端」（见 spec
 * 「时间线条目形态」与票 20）。两处各写一份颜色一定会漂移，所以收在这里。
 *
 * 用 CSS 自定义属性而不是十六进制字面量：颜色值仍然只写在 `styles.css` 的
 * token 块里一处，本模块只负责「哪个角色用哪个变量」这层映射。
 * 「墨」设计系统里 badge 默认由 CSS 隐藏，映射保留供 trace 数据兼容。
 */

/** 角色配色。`accent` 是文字与色点，`soft` 是底色。 */
export interface RoleColor {
  accent: string;
  soft: string;
}

/**
 * 已知角色的固定配色。
 *
 * 语聊房只有 host 与 audience 两个角色；课堂等三端场景后续按同样方式加进来。
 * **不要改成按出现顺序自动分配** —— 颜色会随连接顺序变化，读者刚记住的对应
 * 关系下次刷新就失效了。
 */
const ROLE_COLORS: Record<string, RoleColor> = {
  host: { accent: 'var(--ink-ink)', soft: 'var(--ink-subtle)' },
  audience: { accent: 'var(--ink-fg2)', soft: 'var(--ink-av-empty)' },
};

/** 未登记角色的兜底配色，保证 UI 不因为多出一个角色而崩。 */
const FALLBACK: RoleColor = { accent: 'var(--ink-mono)', soft: 'var(--ink-code)' };

export function roleColor(role: string): RoleColor {
  return ROLE_COLORS[role] ?? FALLBACK;
}

/** 已登记的角色列表，供图例与筛选器列举。 */
export const knownRoles = Object.keys(ROLE_COLORS);
