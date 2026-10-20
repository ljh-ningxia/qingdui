// 日期解析：PRD 7.4.1 唯一口径
// 时区固定东八区（PRD 10.2：所有周口径以周一 00:00 东八区为界）
const TZ_OFFSET = 8 * 60 * 60 * 1000;
const DAY = 86400000;

function now() {
  return Date.now();
}

// 返回东八区的「日历日期」分解
function partsOf(ms) {
  const d = new Date(ms + TZ_OFFSET);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
    dow: d.getUTCDay(), // 0=周日
  };
}

function fromParts(y, m, d, hh, mm) {
  return Date.UTC(y, m - 1, d, hh || 0, mm || 0) - TZ_OFFSET;
}

function startOfDay(ms) {
  const p = partsOf(ms);
  return fromParts(p.y, p.m, p.d, 0, 0);
}

function endOfDay(ms) {
  return startOfDay(ms) + DAY - 1;
}

// 本周一 00:00
function startOfWeek(ms) {
  const p = partsOf(ms);
  const back = (p.dow + 6) % 7;
  return startOfDay(ms - back * DAY);
}

function addDays(ms, n) {
  return ms + n * DAY;
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

const WEEK_CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

/**
 * 解析自然语言日期，返回 { due_at, label } 或 { error }
 * 严格按 PRD 7.4.1 的五条规则实现。
 */
function parseDue(input, base = now()) {
  if (input == null) return { due_at: null, label: '' };
  let s = String(input).trim();
  if (!s) return { due_at: null, label: '' };

  // 去掉常见前后缀，但不吞掉语义词
  s = s.replace(/^截止[:：]?\s*/, '').replace(/\s*(之前|以前)$/, '').trim();

  // 完整时间戳必须最先处理：下面的「剥离 HH:mm 后缀」会把 `2026-10-17 15:50:14`
  // 里的 ` 15:50` 当作时间后缀切掉，导致秒丢失、甚至整串变成 `2026-10-17`。
  // 前端直传、Excel 复制、系统日历导出的都是这个形态，用户粘贴过来必须能认。
  const tsMatch = s.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/
  );
  if (tsMatch) {
    const [, y, mo, d, h, mi, sec = '0', msPart = '0', tz] = tsMatch;
    const ms3 = Number(msPart.padEnd(3, '0'));
    let ms;
    if (tz) {
      const base = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec, ms3);
      const off = tz === 'Z' ? 0 : (() => {
        const sign = tz[0] === '-' ? -1 : 1;
        const [hh, mm] = tz.slice(1).replace(':', '').match(/\d{2}/g).map(Number);
        return sign * (hh * 60 + mm) * 60 * 1000;
      })();
      ms = base - off;
    } else {
      // 无时区：按东八区的墙上时间理解（Date.parse 对这种串返回 NaN，不能依赖）
      ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec, ms3) - TZ_OFFSET;
    }
    if (!Number.isNaN(ms)) return { due_at: ms, label: '' };
  }

  const p = partsOf(base);
  const todayEnd = fromParts(p.y, p.m, p.d, 23, 59);

  // 带 HH:mm 的扩展：允许「周三 18:00」「3/15 9:00」
  const timeMatch = s.match(/[（(\s]?(\d{1,2})[:：](\d{2})\s*[)）]?$/);
  let hour = 23;
  let minute = 59;
  if (timeMatch) {
    hour = Number(timeMatch[1]);
    minute = Number(timeMatch[2]);
    if (hour > 23 || minute > 59) return { error: '没听懂这个时间，点这里选个日期' };
    s = s.slice(0, timeMatch.index).trim();
  }

  const at = (y, m, d) => fromParts(y, m, d, hour, minute);

  // 今天 / 明天 / 后天
  if (/^(今天|今日)$/.test(s)) return ok(at(p.y, p.m, p.d));
  if (/^(明天|明日)$/.test(s)) {
    const t = partsOf(base + DAY);
    return ok(at(t.y, t.m, t.d));
  }
  if (/^后天$/.test(s)) {
    const t = partsOf(base + 2 * DAY);
    return ok(at(t.y, t.m, t.d));
  }

  // 「周三」「下周三」「本周五」「周日」：先剥离白名单前缀，再匹配「周X」
  let wPrefix = '';
  const prefixMatch = s.match(/^(下周|下星期|下礼拜|本周|这周|本星期|这星期|这个星期|礼拜)/);
  let wBody = s;
  if (prefixMatch) {
    wPrefix = prefixMatch[1];
    wBody = s.slice(wPrefix.length);
  }
  const w = wBody.match(/^(?:周|星期|礼拜)?([一二三四五六日天])$/)
    || (wPrefix ? wBody.match(/^([一二三四五六日天])$/) : null);
  if (w && wPrefix) {
    // 「下周」本身已含「周」字，形如「下周一」时 wBody = "一"
    const target = WEEK_CN[w[1]];
    const cur = p.dow;
    const mondayThisWeek = startOfDay(base) - ((cur + 6) % 7) * DAY;
    const offset = (target + 6) % 7;
    const day = wPrefix.startsWith('下')
      ? mondayThisWeek + 7 * DAY + offset * DAY
      : mondayThisWeek + offset * DAY;
    const t = partsOf(day);
    return ok(at(t.y, t.m, t.d));
  }
  const wPlain = s.match(/^(?:周|星期|礼拜)([一二三四五六日天])$/);
  if (wPlain) {
    const target = WEEK_CN[wPlain[1]];
    const cur = p.dow;
    // 无前缀：最近一个该星期几；今天就是则今天；若已过 23:59 则下一周
    if (target === cur) {
      const base2 = at(p.y, p.m, p.d);
      if (base2 > base) return ok(base2);
      const t = partsOf(base + 7 * DAY);
      return ok(at(t.y, t.m, t.d));
    }
    let diff = (target - cur + 7) % 7;
    const t0 = partsOf(base + diff * DAY);
    const cand = at(t0.y, t0.m, t0.d);
    if (cand > base) return ok(cand);
    const t1 = partsOf(base + (diff + 7) * DAY);
    return ok(at(t1.y, t1.m, t1.d));
  }

  // 「3 天后」「2周后」
  const rel = s.match(/^(\d{1,3})\s*(天|日|周|个星期)后$/);
  if (rel) {
    const n = Number(rel[1]);
    const mult = rel[2] === '天' || rel[2] === '日' ? 1 : 7;
    const t = partsOf(base + n * mult * DAY);
    return ok(at(t.y, t.m, t.d));
  }

  // 「3/15」「3-15」「3月15日」「3月15号」「2027/3/15」
  const absFull = s.match(/^(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})[日号]?$/);
  const abs = s.match(/^(\d{1,2})[\/\-月](\d{1,2})[日号]?$/);
  function buildAbs(y, m, d) {
    if (m < 1 || m > 12) return { error: '没听懂这个时间，点这里选个日期' };
    if (d < 1 || d > daysInMonth(y, m)) {
      if (m === 2 && d === 29) return { error: '该日期不存在（今年不是闰年）' };
      return { error: '该日期不存在' };
    }
    return ok(at(y, m, d));
  }
  if (absFull) return buildAbs(Number(absFull[1]), Number(absFull[2]), Number(absFull[3]));
  if (abs) {
    const m = Number(abs[1]);
    const d = Number(abs[2]);
    const first = buildAbs(p.y, m, d);
    if (first.error) return first;
    if (first.due_at >= startOfDay(base)) return first;
    return buildAbs(p.y + 1, m, d);
  }

  // 完整时间戳（前端、Excel、系统日历导出的都长这样）：直接取毫秒，避免走自然语言分支。
  // ISO 日期时间（前端日期选择器直传）
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
  if (iso) {
    const hh = iso[4] != null ? Number(iso[4]) : hour;
    const mi = iso[5] != null ? Number(iso[5]) : minute;
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return { error: '该日期不存在' };
    return { due_at: fromParts(y, m, d, hh, mi), label: '' };
  }

  return { error: '没听懂这个时间，点这里选个日期' };

  function ok(ms) {
    return { due_at: ms, label: '' };
  }
}

// 展示用：周三 23:59 / 3月15日 23:59
function formatDue(ms) {
  if (!ms) return '无截止';
  const p = partsOf(ms);
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const hm = `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
  const todayP = partsOf(now());
  const diffDays = Math.round((startOfDay(ms) - startOfDay(now())) / DAY);
  if (diffDays === 0) return hm === '23:59' ? '今天 23:59' : `今天 ${hm}`;
  if (diffDays === 1) return hm === '23:59' ? '明天 23:59' : `明天 ${hm}`;
  if (diffDays > 1 && diffDays < 7) return `${names[p.dow]} ${hm}`;
  return `${p.m}月${p.d}日 ${hm}`;
}

function formatDateTime(ms) {
  if (!ms) return '—';
  const p = partsOf(ms);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')} ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
}

// 逾期天数：今天 0 点为基准的自然日差
function overdueDays(dueAt, base = now()) {
  if (!dueAt) return 0;
  const diff = Math.floor((startOfDay(base) - startOfDay(dueAt)) / DAY);
  return diff > 0 ? diff : 0;
}

function isOverdue(task, base = now()) {
  if (!task.due_at) return false;
  if (task.status === 'done' || task.status === 'cancelled') return false;
  return task.due_at < base;
}

module.exports = {
  now, partsOf, fromParts, startOfDay, endOfDay, startOfWeek, addDays,
  parseDue, formatDue, formatDateTime, overdueDays, isOverdue,
  daysInMonth, DAY, TZ_OFFSET,
};
