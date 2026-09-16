/**
 * 时区基线门禁。
 *
 * 为什么需要它：时区错配**不报错、不影响任何功能**，只会静默地把时间写成另一种口径。
 * 本次故障就是这样长出来的 —— 库内时间列全是 DATETIME（原样存墙上时间、不做换算），
 * 而 `DEFAULT CURRENT_TIMESTAMP` 取容器时区（UTC）、app 又用 `dbDateTimeInTz` 写北京时间，
 * 于是 `posts.created_at` 一列里同时存在相差 8 小时的两类值。
 * 这类问题在本地开发环境**看不出来**：本机 MySQL 的时区就是 +08:00，怎么试都对。
 *
 * 所以把「改动时区时必须同时成立的十一条约束」固化下来，纯文本分析即可验证：
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
 *   ⑤ `posts` 必须按**三种来源**分别处理，而不是只按 `source` 两分：抓取行（UTC）、
 *      控制台手工行（UTC）、seed 手工行（北京时间展示日期）。首版漏了第三类判别，
 *      会把控制台创建的文章永久漏迁移。
 *   ⑥ SQL 里硬编码的 seed 清单必须与 `seed-blog-posts.mjs` 逐条一致 —— 两边分叉后
 *      迁移同样是静默错。
 *   ⑦ 四个 SQL 脚本都必须 `SET NAMES utf8mb4` —— 用户变量的排序规则取自连接，
 *      不固定就等于把脚本行为交给客户端默认值（实测：MySQL 8 默认连接报 1267，
 *      Windows mysql CLI 默认 gbk 把中文字面量写坏）。
 *   ⑧ 回滚脚本必须镜像迁移的三分类（seed 清单 + `FIND_IN_SET` 判别），
 *      否则回滚会漏改控制台文章或误改 seed 展示日期。
 *   ⑨ `src/` 不得用「进程本地时区」格式化时间 —— 禁止不带 `timeZone` 的 `toLocale*`、
 *      禁止裸取 `getHours()/getDate()` 等分量。容器里 Node 认 `TZ`（ICU 自带时区库，
 *      不需要 tzdata），所以当下结果恰好对 —— 但这把「TZ 没丢」变成了正确性的必要条件，
 *      TZ 一旦丢失就静默偏 8 小时。展示一律走 `formatInTz(d, config.businessTz)`。
 *   ⑩ 连接层必须显式声明「库内 DATETIME 是什么口径」（mysql2 的 `timezone`）。
 *      驱动默认 `'local'` 同样是隐式依赖进程 TZ。
 *   ⑪ 时区口径只有一个来源，且跨文件对账：`BUSINESS_TZ`（config）⇄ `DB_TZ_OFFSET`
 *      （连接层）⇄ compose 的 `TZ`；`FEED_TZ` 必须回落到 `BUSINESS_TZ`，不得各写默认值。
 *      另外 Dockerfile 必须装 tzdata —— 缺它时容器内 `date` 输出 UTC 而日志是北京时间，
 *      两个时间基准并存，排查时极易把正常的 8 小时差误判成故障（本次就误判过一次）。
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

    // ⑤ posts 必须按「三种来源」分别处理，不能只按 source 两分。
    //    线上实际有三种：抓取行（UTC）、控制台手工行（UTC）、seed 手工行（北京时间展示日期）。
    //    首版只按 source 两分，会把控制台创建的第一篇（`站点上线-半山日志-改版发布`）
    //    误判为 seed 行而永久漏迁移 —— 判别依据必须是 slug 是否在 seed 清单内。
    const byFeed = stmts.filter((s) => /source\s+IS\s+NOT\s+NULL/i.test(s) && /created_at\s*=/i.test(s));
    const byConsole = stmts.filter(
      (s) => /source\s+IS\s+NULL/i.test(s) && /FIND_IN_SET\(slug,\s*@seed_slugs\)\s*=\s*0/i.test(s)
    );
    const bySeed = stmts.filter(
      (s) => /source\s+IS\s+NULL/i.test(s) && /FIND_IN_SET\(slug,\s*@seed_slugs\)\s*>\s*0/i.test(s)
    );
    check(`${file} ① 抓取行迁移 created_at`, byFeed.length === 1, `命中 ${byFeed.length} 条`);
    check(`${file} ② 控制台手工行迁移 created_at（非 seed 清单）`, byConsole.length === 1, `命中 ${byConsole.length} 条`);
    check(`${file} ③ seed 手工行只动 updated_at`, bySeed.length === 1, `命中 ${bySeed.length} 条`);
    // ③ 必须**不**赋值 created_at：它是 seed 写的人为展示日期，+8h 就毁了这个语义
    if (bySeed.length === 1) {
      const setClause = bySeed[0].slice(bySeed[0].search(/\bSET\b/i));
      check(`${file} ③ seed 行不迁移 created_at（展示日期须保持原值）`, !/created_at\s*=/i.test(setClause));
    }
    // seed 行若从未被刷新，updated_at 与 created_at 同为北京时间 → 必须排除
    check(
      `${file} ③ seed 行以 updated_at <> created_at 排除「从未被刷新」的行`,
      bySeed.length === 1 && /updated_at\s*<>\s*created_at/i.test(bySeed[0])
    );
    // 清单必须存在且可解析
    check(`${file} 声明了 seed 清单 @seed_slugs`, /SET\s+@seed_slugs\s*:=\s*'/i.test(sql));

    // 抓取行自检必须用容差，而不是断言「created_at 完全等于 fetched_at」——
    // 后者在线上永远是 17/18（fetched_at 是抓取开始时一次打上的，created_at 是逐行插入
    // 那一刻的 DB 默认值，末行天然晚 1 秒）。写死相等只会长期挂着一条假红。
    check(
      `${file} 抓取行自检用容差（>60 秒才判坏），未写死「完全相等」`,
      /rows_bad/i.test(sql) && /TIMESTAMPDIFF\(SECOND,\s*created_at,\s*fetched_at\)/i.test(sql)
    );
  }
}

// ⑥ seed 清单防漂移：SQL 里硬编码的 slug 集合必须与 seed-blog-posts.mjs 的完全一致。
//    两边一旦分叉，迁移要么漏迁控制台文章、要么把展示日期也 +8h —— 都是静默错误。
{
  const file = 'scripts/migrate-tz-cst.sql';
  const sql = read(file);
  const seedSrc = read('scripts/seed-blog-posts.mjs');

  const fromSeed = new Set<string>();
  for (const m of seedSrc.matchAll(/slug:\s*'([^']+)'/g)) fromSeed.add(m[1]);

  const listMatch = /SET\s+@seed_slugs\s*:=\s*'([^']*)'/i.exec(sql);
  const fromSql = new Set<string>(
    listMatch ? listMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : []
  );

  const missing = [...fromSeed].filter((s) => !fromSql.has(s));
  const extra = [...fromSql].filter((s) => !fromSeed.has(s));
  check(
    `${file} 的 seed 清单与 seed-blog-posts.mjs 逐条一致`,
    listMatch !== null && fromSeed.size > 0 && missing.length === 0 && extra.length === 0,
    `seed=${fromSeed.size} sql=${fromSql.size}` +
      (missing.length ? ` 缺失=[${missing.join(',')}]` : '') +
      (extra.length ? ` 多余=[${extra.join(',')}]` : '')
  );
}

// 回滚脚本必须能清除标记，否则守卫会挡住反向更新
for (const file of [
  'scripts/migrate-tz-cst.rollback.sql',
  'scripts/migrate-tz-cst-tools-api.rollback.sql',
]) {
  const sql = read(file);
  check(`${file} 先删标记再回退`, /DELETE\s+FROM\s+schema_migrations[\s\S]*?DATE_SUB\(/i.test(sql));
}

// ⑦ 四个 SQL 脚本都必须固定连接字符集/排序规则。
//    这是实测踩出来的：用户变量的字符集/排序规则取自**连接**，MySQL 8 的 utf8mb4 连接
//    默认 utf8mb4_0900_ai_ci，与库里 utf8mb4_unicode_ci 的列相比直接
//    `ERROR 1267 Illegal mix of collations` —— 整条事务回滚、迁移静默不做；
//    而 Windows mysql CLI 默认 gbk 连接又会让脚本正文里的中文字面量写坏（且不报错）。
//    没有这行，脚本行为就取决于客户端默认值，本地怎么试都可能与线上不同。
for (const file of [
  ...MIGRATIONS.map((m) => m.file),
  'scripts/migrate-tz-cst.rollback.sql',
  'scripts/migrate-tz-cst-tools-api.rollback.sql',
]) {
  const sql = read(file);
  check(
    `${file} 固定了连接字符集（SET NAMES utf8mb4，否则可能 1267 或中文乱码）`,
    /SET\s+NAMES\s+utf8mb4\b/i.test(sql)
  );
}

// ⑧ 回滚必须镜像迁移的三分类：seed 清单与 FIND_IN_SET 判别都要在，
//    否则回滚会漏改控制台文章 / 误改 seed 展示日期。
{
  const mig = read('scripts/migrate-tz-cst.sql');
  const rb = read('scripts/migrate-tz-cst.rollback.sql');
  const listOf = (sql: string) => {
    const m = /SET\s+@seed_slugs\s*:=\s*'([^']*)'/i.exec(sql);
    return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean).sort() : [];
  };
  const ml = listOf(mig);
  const rl = listOf(rb);
  check(
    '回滚脚本的 seed 清单与迁移脚本逐条一致',
    ml.length > 0 && ml.join(',') === rl.join(','),
    `迁移=${ml.length} 回滚=${rl.length}`
  );
  const rbStmts = rb.split(';').filter((s) => /UPDATE\s+posts\b/i.test(s));
  check('回滚脚本与迁移一样把 posts 分三类处理', rbStmts.length === 3, `${rbStmts.length} 条`);
  check(
    '回滚脚本的 seed 行同样以 updated_at <> created_at 为条件（与迁移镜像）',
    /updated_at\s*<>\s*created_at[\s\S]*?DATE_SUB|FIND_IN_SET\(slug,\s*@seed_slugs\)\s*>\s*0[\s\S]*?updated_at\s*<>\s*created_at/i.test(rb)
  );
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

/* ── ⑨⑩⑪ 展示层 / 连接层 / 镜像：不得隐式依赖进程本地时区 ───────────────── */

console.log('\n── ⑨⑩⑪ 进程本地时区依赖与口径对账 ──────');

/** 递归收集 src/ 下的 .ts 文件（posix 风格相对路径）。 */
function collectSrc(dir = 'src'): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...collectSrc(rel));
    else if (e.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

/**
 * 剥离注释后再扫。注释里出现的反例（如 tz.ts 顶部写「不要用 new Date().getHours()」）
 * 不该被判成违规 —— 门禁误报会训练人忽略它，比漏报更糟。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

const srcFiles = collectSrc();

// ⑨-a 禁止不带 timeZone 的 toLocale* —— 它取进程本地时区。
//     实测：容器内 TZ=Asia/Shanghai 时 Node 靠 ICU 认这个变量，结果恰好对；
//     但 TZ 一旦丢失就静默偏 8 小时，而正确性不该押在环境变量上。
const localeOffenders: string[] = [];
for (const f of srcFiles) {
  const code = stripComments(read(f));
  for (const m of code.matchAll(/\.toLocale(?:String|DateString|TimeString)\s*\(([\s\S]{0,240}?)\)/g)) {
    if (!/timeZone/.test(m[1])) localeOffenders.push(`${f} → .toLocale*(${m[1].trim().slice(0, 60)})`);
  }
}
check(
  'src/ 无不带 timeZone 的 toLocale* 调用（统一走 formatInTz）',
  localeOffenders.length === 0,
  localeOffenders.join(' | ')
);

// ⑨-b 禁止裸取进程本地的日期/时间分量
const partOffenders: string[] = [];
for (const f of srcFiles) {
  const code = stripComments(read(f));
  for (const m of code.matchAll(/\.(getHours|getMinutes|getSeconds|getDate|getMonth|getFullYear|getDay)\s*\(/g)) {
    partOffenders.push(`${f} → ${m[0]}`);
  }
}
check(
  'src/ 无 getHours()/getDate() 等裸本地分量（改用 tz.ts 的 partsInTz/formatInTz）',
  partOffenders.length === 0,
  partOffenders.join(' | ')
);

// ⑩ 连接层必须显式声明「库内 DATETIME 是什么口径」，不交给驱动的 'local' 默认值
const conn = read('src/db/connection.ts');
check(
  'src/db/connection.ts 显式设了 mysql2 的 timezone（不依赖驱动默认 local）',
  /timezone:\s*config\.db\.timezoneOffset/.test(conn)
);

// ⑪ 时区口径的单一事实来源 + 跨文件对账
const cfg = read('src/config/index.ts');
check(
  'config 有 businessTz 且默认 Asia/Shanghai',
  /businessTz:\s*BUSINESS_TZ/.test(cfg) && /const BUSINESS_TZ = strOr\('BUSINESS_TZ', 'Asia\/Shanghai'\)/.test(cfg)
);
check(
  'config.db.timezoneOffset 默认 +08:00',
  /timezoneOffset:\s*strOr\('DB_TZ_OFFSET', '\+08:00'\)/.test(cfg)
);
// 两处各自写默认值就会分叉：FEED_TZ 必须回落到 BUSINESS_TZ
check(
  'FEED_TZ 回落到 BUSINESS_TZ（避免调度与展示两处默认值分叉）',
  /tz:\s*strOr\('FEED_TZ', BUSINESS_TZ\)/.test(cfg)
);
const offsetHit = /timezoneOffset:\s*strOr\('DB_TZ_OFFSET', '([^']+)'\)/.exec(cfg);
check(
  '连接层偏移与 compose 的 TZ 同口径（Asia/Shanghai ≡ +08:00，中国无夏令时）',
  offsetHit !== null && offsetHit[1] === '+08:00' && tzOf.db === 'Asia/Shanghai',
  `offset=${offsetHit ? offsetHit[1] : '?'} composeTZ=${tzOf.db}`
);
check(
  'tz.ts 导出 formatInTz（展示层统一入口）',
  /export function formatInTz\(/.test(read('src/utils/tz.ts'))
);
// 镜像层：缺 tzdata 时 busybox 的 date 输出 UTC，而应用日志是北京时间 ——
// 两个时间基准并存，排查时极易把正常的 8 小时差误判成故障。
check(
  'Dockerfile 装了 tzdata（让容器内 date 与日志同基准）',
  /apk add --no-cache tzdata/.test(read('Dockerfile'))
);

/* ── 汇总 ───────────────────────────────────────────────────────────────── */

console.log(`\n${'='.repeat(60)}`);
if (failed > 0) {
  console.error(`失败 ${failed} 项。`);
  process.exit(1);
}
console.log('全部通过。');
process.exit(0);
