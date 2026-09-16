/**
 * 时区工具（零依赖，基于 Intl）。
 *
 * 为什么不直接用 new Date().getHours()：容器默认 UTC，若忘记设置 TZ 环境变量，
 * 08:30 会偏移成北京时间 16:30。显式指定 IANA 时区可让调度行为与容器 TZ 解耦。
 */

/** 校验 IANA 时区名是否可用（非法名会让 Intl 抛错，需提前兜底）。 */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface TzParts {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM（24 小时制） */
  time: string;
  hour: number;
  minute: number;
}

/** 取指定时刻在目标时区下的日期与时分。tz 非法时回退到进程本地时区。 */
export function partsInTz(d: Date, tz: string): TzParts {
  const useTz = isValidTimeZone(tz) ? tz : undefined;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: useTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) map[p.type] = p.value;
  const hour = parseInt(map.hour || '0', 10);
  const minute = parseInt(map.minute || '0', 10);
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    hour,
    minute,
  };
}

/** 目标时区下的「今天」（YYYY-MM-DD）。 */
export function todayInTz(tz: string, now: Date = new Date()): string {
  return partsInTz(now, tz).date;
}

/**
 * 绝对时刻 → 目标时区的 `YYYY-MM-DD HH:MM:SS`。
 *
 * 为什么不用 `d.toLocaleString('zh-CN')`：它取**进程本地时区**，结果取决于 TZ 环境
 * 变量。容器里 Node 认 TZ（ICU 自带时区库），所以当下恰好是对的 —— 但这把一个
 * 隐式前提（TZ 没丢）变成了正确性的必要条件，TZ 一旦丢失就会静默偏 8 小时。
 * 显式传入 IANA 时区则与运行环境彻底解耦。
 *
 * 与 `dbDateTimeInTz` 输出格式相同、刻意分开命名：那个的语义是「生成写库的字面量」，
 * 这个的语义是「把绝对时刻渲染给人看」，分开可让调用点自证意图。
 * 接受 Date / 字符串 / 毫秒数：mysql2 对 DATETIME 列返回 Date，而日志行里的时间
 * 字段是数字或字符串，调用点不该被迫先判类型。
 */
export function formatInTz(d: Date | string | number, tz: string): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return String(d); // 坏数据不该让日志/审计链路崩
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: isValidTimeZone(tz) ? tz : undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

/**
 * 目标时区下的 DATETIME 字面量（YYYY-MM-DD HH:MM:SS）。
 *
 * 为什么不用 new Date() 直接交给 mysql2：驱动按进程本地时区格式化，
 * 而查询侧若用 DB 的 NOW()/CURDATE()（取决于数据库会话时区），两边会错位。
 * 统一由应用侧显式生成目标时区的墙上时间字符串，读写两侧语义一致。
 */
export function dbDateTimeInTz(tz: string, now: Date = new Date()): string {
  return formatInTz(now, tz);
}

/** 目标时区下的 YYYY-MM-DD HH:MM（用于正文署名区展示）。 */
export function displayDateTimeInTz(tz: string, now: Date = new Date()): string {
  const p = partsInTz(now, tz);
  return `${p.date} ${p.time}`;
}
