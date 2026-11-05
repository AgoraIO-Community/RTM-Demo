/**
 * 时间线的时间格式化。
 *
 * 固定使用 `Asia/Shanghai`，避免运行浏览器的本地时区影响演示和截图。
 *
 * 毫秒必须显示到三位 —— 时间线的核心价值之一就是分辨紧邻调用的先后。
 */

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** `at` 是 `Date.now()` 那样的毫秒时间戳。输出形如 `15:07:23.045`。 */
export function formatTraceTime(at: number): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${value('hour')}:${value('minute')}:${value('second')}.${pad(new Date(at).getMilliseconds(), 3)}`;
}
