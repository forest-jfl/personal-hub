/**
 * 时区基线门禁。
 *
 * 为什么需要它：时区错配**不报错、不影响任何功能**，只会静默地把时间写成另一种口径。
 * 本次故障就是这样长出来的 —— 库内时间列全是 DATETIME（原样存墙上时间、不做换算），
 * 而 `DEFAULT CURRENT_TIMESTAMP` 取容器时区（UTC）、app 又用 `dbDateTimeInTz` 写北京时间，
 * 于是 `posts.created_at` 一列里同时存在相差 8 小时的两类值。
 * 这类问题在本地开发环境**看不出来**：本机 MySQL 的时区就是 +08:00，怎么试都对。
 *
 * 所以把「改动时区时必须同时成立的四条约束」固化下来，纯文本分析即可验证：
 *   ① compose 的 db 与 app 必须同设同一个 TZ，且为 Asia/Shanghai
 *      —— 两侧不一致 = 两条写入口径再次分裂，正是本次病根。
 *      （`feed.repo.ts` 的 `DATE_SUB(NOW(), INTERVAL ? DAY)` 去重窗口、
 *        `post.repo.ts` 的按月归档 `DATE_FORMAT(created_at,'%Y-%m')` 都建立在这个不变量上。）
 *   ② schema 里**不得出现 TIMESTAMP 列** —— 它按会话时区做存/取换算，
 *      与满库的 DATETIME 混用会重演「同表两种口径」，且迁移方式完全不同。
 *   ③ 迁移脚本的幂等守卫在位 —— 去掉守卫后重复执行会把时间推到未来。
 *   ④ 迁移脚本里每一条 `UPDATE posts` 都必须**显式赋值 updated_at** ——
 *      该列是 `ON UPDATE CURRENT_TIMESTAMP`，只改别的列会把它顺手刷成当前时间，
 *      静默毁掉整列。
 *
 * 用法：npm run check:tz（ts-node，零新增依赖）
 * 退出码 0 通过 / 1 断言失败
 */
import fs from 'fs';
import path from 'path';

let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '   ' + detail : ''}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

const ROOT = path.resolve(__dirname, '..');
function read(rel: string): string {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    console.error(`找不到 ${rel}（期望在 ${ROOT}），门禁无法执行。`);
    process.exit(1);
  }
  return fs.readFileSync(p, 'utf8');
}

/* ── ① compose：db 与 app 必须同设 Asia/Shanghai ─────────────────────────── */

console.log('── ① compose 时区一致性 ────────────────');

const compose = read('docker-compose.yml');

/** 取出某个顶层服务（2 空格缩进）的片段，直到下一个顶层服务或顶格键。 */
function serviceBlock(name: string): string {
  const m = new RegExp(`^  ${name}:\\s*$`, 'm').exec(compose);
  if (!m) return '';
  const rest = compose.slice(m.index + m[0].length);
  const next = rest.search(/^  \S|^\S/m);
  return next < 0 ? rest : rest.slice(0, next);
}

const TZ_EXPECTED = 'Asia/Shanghai';
const tzOf: Record<string, string | null> = {};
for (const svc of ['db', 'app'] as const) {
  const block = serviceBlock(svc);
  check(`compose 中存在服务 ${svc}`, block.length > 0);
  // 允许引号包裹与尾注释
  const hit = /^\s+TZ:\s*['"]?([A-Za-z_/]+)['"]?\s*(?:#.*)?$/m.exec(block);
  tzOf[svc] = hit ? hit[1] : null;
  eq(`${svc} 服务设了 TZ=${TZ_EXPECTED}`, tzOf[svc], TZ_EXPECTED);
}
check(
  'db 与 app 的 TZ 完全一致（否则两条写入口径会再次分裂）',
  tzOf.db === tzOf.app && tzOf.db !== null,
  `db=${tzOf.db} app=${tzOf.app}`
);
// 时区一旦不是 UTC+8，迁移脚本里写死的 +8 小时就不再成立
check(
  'TZ 为固定 UTC+8 区域（迁移脚本按 +8h 硬编码，中国无夏令时）',
  tzOf.db === 'Asia/Shanghai',
  `实际=${tzOf.db}`
);

/* ── ② schema 不得引入 TIMESTAMP 列 ─────────────────────────────────────── */

console.log('\n── ② schema 时间列类型卫生 ─────────────');

for (const rel of ['schema.sql', 'src/db/migrate.ts']) {
  const text = read(rel);
  // 列定义形如 `  created_at   DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,`
  // 只看行首的「列名 + 类型」，因此 DEFAULT CURRENT_TIMESTAMP 不会误判。
  const tsCols = text
    .split('\n')
    .map((line, i) => ({ line: line.trim(), no: i + 1 }))
    .filter(({ line }) => /^`?\w+`?\s+TIMESTAMP\b/i.test(line));
  check(
    `${rel} 无 TIMESTAMP 类型列（与 DATETIME 混用会重演同表两种口径）`,
    tsCols.length === 0,
    tsCols.length ? tsCols.map((c) => `L${c.no}: ${c.line}`).join(' | ') : ''
  );
}

/* ── ③④ 迁移脚本：幂等守卫 + ON UPDATE 规避 ─────────────────────────────── */

console.log('\n── ③④ 存量迁移脚本自检 ─────────────────');

const MIGRATIONS: Array<{ file: string; postsTable: boolean }> = [
  { file: 'scripts/migrate-tz-cst.sql', postsTable: true },
  { file: 'scripts/migrate-tz-cst-tools-api.sql', postsTable: false },
];

for (const { file, postsTable } of MIGRATIONS) {
  const sql = read(file);

  // ③ 幂等守卫：每个 UPDATE / 标记写入都必须带 @todo 条件
  // 按语句切分后逐条判定 —— 不能直接数 `@todo;` 出现次数，
  // 因为末尾的 `INSERT INTO schema_migrations ... WHERE @todo;` 也带守卫，会把计数多算 1。
  const updateStmts = sql.split(';').filter((s) => /^\s*UPDATE\s+/im.test(s));
  const guardedUpdates = updateStmts.filter((s) => /@todo/.test(s)).length;
  const markerWrite = /INSERT\s+INTO\s+schema_migrations[\s\S]*?WHERE\s+@todo\s*;/i.test(sql);
  check(`${file} 声明了标记表 schema_migrations`, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+schema_migrations/i.test(sql));
  check(`${file} 存在标记写入（幂等记账）`, markerWrite);
  check(
    `${file} 每条 UPDATE 都带 @todo 守卫`,
    updateStmts.length > 0 && guardedUpdates === updateStmts.length,
    `带守卫 ${guardedUpdates}/${updateStmts.length} 条`
  );
  check(`${file} 语义为 +8 小时（UTC→CST）`, /DATE_ADD\([^)]*INTERVAL\s+8\s+HOUR\)/i.test(sql));
  check(
    `${file} 未混入反向的 DATE_SUB（回滚才是 -8h）`,
    !/DATE_SUB\(/i.test(sql)
  );

  // ④ posts.updated_at 是 ON UPDATE CURRENT_TIMESTAMP：UPDATE 它必须显式赋值
  if (postsTable) {
    const stmts = sql.split(';').filter((s) => /UPDATE\s+posts\b/i.test(s));
    check(`${file} 含 posts 的 UPDATE 语句`, stmts.length > 0, `${stmts.length} 条`);
    stmts.forEach((s, i) => {
      const setClause = s.slice(s.search(/\bSET\b/i));
      check(
        `${file} 第 ${i + 1} 条 UPDATE posts 显式赋值 updated_at（规避 ON UPDATE 陷阱）`,
        /updated_at\s*=/i.test(setClause)
      );
    });
    // 抓取行与手工行的 created_at 处理必须不同：前者迁移、后者保持
    check(
      `${file} 抓取行(created_at 迁移)与手工行(仅 updated_at)分开处理`,
      /WHERE\s+source\s+IS\s+NOT\s+NULL/i.test(sql) && /WHERE\s+source\s+IS\s+NULL/i.test(sql)
    );
  }
}

// 回滚脚本必须能清除标记，否则守卫会挡住反向更新
for (const file of [
  'scripts/migrate-tz-cst.rollback.sql',
  'scripts/migrate-tz-cst-tools-api.rollback.sql',
]) {
  const sql = read(file);
  check(`${file} 先删标记再回退`, /DELETE\s+FROM\s+schema_migrations[\s\S]*?DATE_SUB\(/i.test(sql));
}

// 迁移脚本不得直接引用别的库名：本机也存在同名 tools_api / personal_hub 库，
// 带库名前缀的脚本一旦在开发机误跑就会改到本机数据。库上下文由执行时指定。
for (const { file } of MIGRATIONS) {
  const sql = read(file);
  const qualified = sql.match(/`?(personal_hub|tools_api)`?\s*\./gi);
  check(
    `${file} 不写死库名前缀（避免本机误伤同名库）`,
    !qualified,
    qualified ? qualified.join(' ') : ''
  );
}

/* ── 汇总 ───────────────────────────────────────────────────────────────── */

console.log(`\n${'='.repeat(60)}`);
if (failed > 0) {
  console.error(`失败 ${failed} 项。`);
  process.exit(1);
}
console.log('全部通过。');
process.exit(0);
