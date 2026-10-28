/**
 * RTC 错误归一。
 *
 * 业务层要能区分两类失败，而不是靠读中文文案猜：
 *
 * - **用法错误**（`RtcUsageError`）—— 调用顺序不对，比如没 join 就发布麦克风。
 *   这类错误是代码写错了，重试没有意义，UI 不该把它当成网络问题提示用户。
 * - **SDK 错误**（`RtcSdkError`）—— SDK 或网络真的失败了，原始错误挂在 `cause` 上，
 *   便于排查时看到 SDK 的原文。
 *
 * 两者都从 `RtcError` 派生，所以 `catch (e) { if (e instanceof RtcError) }` 能一把兜住。
 */

/** RTC 错误的共同基类。 */
export abstract class RtcError extends Error {
  abstract readonly kind: 'usage' | 'sdk';
}

/** 调用顺序错误。重试无意义 —— 是代码写错了。 */
export class RtcUsageError extends RtcError {
  readonly kind = 'usage' as const;

  constructor(message: string) {
    super(message);
    this.name = 'RtcUsageError';
  }
}

/** SDK 或网络失败。原始错误保留在 `cause` 里。 */
export class RtcSdkError extends RtcError {
  readonly kind = 'sdk' as const;

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'RtcSdkError';
  }
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`.toUpperCase();
  if (typeof error === 'string') return error.toUpperCase();
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    return [record.code, record.name, record.message]
      .filter((value) => typeof value === 'string' || typeof value === 'number')
      .join(' ')
      .toUpperCase();
  }
  return '';
}

/** 把 SDK 抛出的任意值归一成一句可读中文。 */
export function describeRtcError(error: unknown): string {
  const detail = errorDetail(error);
  if (
    detail.includes('INVALID_TOKEN') ||
    detail.includes('TOKEN_EXPIRED') ||
    detail.includes('DYNAMIC_USE_STATIC_KEY')
  ) {
    return 'RTC Token 无效或已过期，请重新生成';
  }
  if (
    detail.includes('NOTALLOWEDERROR') ||
    detail.includes('PERMISSION_DENIED') ||
    detail.includes('PERMISSION DENIED')
  ) {
    return '浏览器未授予麦克风或摄像头权限';
  }
  if (detail.includes('NOTFOUNDERROR') || detail.includes('DEVICE_NOT_FOUND')) {
    return '未找到麦克风或摄像头设备';
  }
  if (
    detail.includes('CONNECTION') ||
    detail.includes('NETWORK') ||
    detail.includes('DISCONNECTED')
  ) {
    return 'RTC 网络连接失败，请检查网络后重试';
  }
  return 'RTC 操作失败，请稍后重试';
}

/** 把 SDK 抛出的任意值包成 `RtcSdkError`。已经是 `RtcError` 的原样透传。 */
export function toRtcSdkError(error: unknown): RtcError {
  if (error instanceof RtcError) return error;
  return new RtcSdkError(describeRtcError(error), error);
}
