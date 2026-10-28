/**
 * 身份推导：房间号与各端 uid。
 *
 * 这是实验室外壳的职责，不放场景目录 —— 角色 RTM 单文件只接受构造参数传入的
 * uid，保持零依赖（见 spec「身份推导」与票 06）。
 *
 * 三条不变式：
 * 1. uid 一定带角色前缀。时间线的 uid badge 依赖前缀做可读区分。
 * 2. 同一标签页内各端 uid 互不相同。由前缀 + 各自独立随机段保证，不做冲突检测 ——
 *    前缀不同就已经足够，检测是多余的复杂度。
 * 3. 推导结果不落任何 storage。只从 URL 读，每次刷新重新推导；刷新时 URL 还在，
 *    行为稳定，分享链接即可让对方进同一个房间。
 */

/** 随机段：6 位 base36，足够避碰且便于口头传达。 */
const RANDOM_SEGMENT_LENGTH = 6;

export interface IdentityInputs<Role extends string> {
  /** 场景 id，用作自动生成房间号的前缀。 */
  sceneId: string;
  /** 本场景的角色列表，第一项是主角色（`?uid=` 简写的目标）。 */
  roles: readonly Role[];
  /** `location.search`。显式传入，便于测试且不隐式依赖全局。 */
  search?: string;
  /**
   * 随机段生成器。可注入以便测试盯住结构而不是具体值。
   * 只有真正需要生成的槽位才调用它 —— 被 URL 覆盖的房间号或 uid 不消耗随机段。
   */
  randomSegment?: () => string;
}

export interface DerivedIdentity<Role extends string> {
  roomId: string;
  uids: Record<Role, string>;
}

function defaultRandomSegment(): string {
  let segment = '';
  while (segment.length < RANDOM_SEGMENT_LENGTH) {
    segment += Math.random().toString(36).slice(2);
  }
  return segment.slice(0, RANDOM_SEGMENT_LENGTH);
}

/** 空字符串与纯空白都不算有效覆盖值，回落到自动生成。 */
function readOverride(params: URLSearchParams, key: string): string | undefined {
  const trimmed = params.get(key)?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 把 uid 覆盖值规范成「角色前缀 + 非空主体」。
 *
 * 主体为空时返回 `undefined`（回落到自动生成）—— 否则 `?uid.host=host-` 会得到一个
 * 裸前缀 `host-`，它满足前缀不变式却没有任何区分度，两端各写一次就撞成同一个 uid，
 * 而我们刻意不做冲突检测。
 */
function normalizeUidOverride(role: string, raw: string): string | undefined {
  const prefix = `${role}-`;
  // 已带前缀的不重复补，保持幂等。
  const rest = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  const body = rest.replace(/^-+|-+$/g, '').trim();
  return body ? `${prefix}${body}` : undefined;
}

export function deriveIdentity<Role extends string>({
  sceneId,
  roles,
  search = '',
  randomSegment = defaultRandomSegment,
}: IdentityInputs<Role>): DerivedIdentity<Role> {
  const params = new URLSearchParams(search);

  const roomId = readOverride(params, 'room') ?? `${sceneId}-${randomSegment()}`;

  const uids = {} as Record<Role, string>;
  const [primaryRole] = roles;
  for (const role of roles) {
    // `?uid=` 只是主角色的简写；多端场景用 `?uid.<role>=` 精确指定。
    const raw =
      readOverride(params, `uid.${role}`) ??
      (role === primaryRole ? readOverride(params, 'uid') : undefined);
    const override = raw ? normalizeUidOverride(role, raw) : undefined;

    uids[role] = override ?? `${role}-${randomSegment()}`;
  }

  return { roomId, uids };
}
