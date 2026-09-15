/**
 * 每日抓取的命令行入口（手动执行 / 干跑验证 / 外部 crontab 兜底）。
 *
 * 用法（项目根目录）：
 *   npm run feed:daily -- --dry-run              # 只抓取解析，不写库
 *   npm run feed:daily -- --source=sspai         # 只跑指定来源
 *   npm run feed:daily -- --json                 # 输出机器可读结果（便于脚本消费）
 *   node dist/services/daily-feed/cli.js --dry-run   # 生产镜像内使用编译产物
 */
import { runMigrations } from '../../db/migrate';
import { closePool } from '../../db/connection';
import { logger } from '../../utils/logger';
import { runDailyFeed } from './index';

interface CliArgs {
  dryRun: boolean;
  json: boolean;
  sourceIds: string[];
  noMigrate: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, json: false, sourceIds: [], noMigrate: false };
  for (const raw of argv) {
    const a = raw.trim();
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a === '--json') args.json = true;
    else if (a === '--no-migrate') args.noMigrate = true;
    else if (a.startsWith('--source=')) {
      args.sourceIds.push(
        ...a
          .slice('--source='.length)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      );
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          '每日抓取 CLI',
          '',
          '  --dry-run, -n        干跑：只抓取与解析，不写库、不推送',
          '  --source=a,b         仅运行指定来源（内置 id: sspai / infoq / ithome / 36kr）',
          '  --json               以 JSON 输出运行结果',
          '  --no-migrate         跳过启动前的表结构检查',
          '  --help, -h           显示本帮助',
        ].join('\n')
      );
      process.exit(0);
    } else {
      logger.warn({ arg: a }, '未知参数，已忽略');
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.noMigrate) {
    // 幂等；保证首次在空库上也能直接跑
    await runMigrations();
  }

  const result = await runDailyFeed({
    dryRun: args.dryRun,
    sourceIds: args.sourceIds,
    trigger: 'cli',
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const t = result.totals;
    console.log(
      `\n运行 ${result.runId}（${result.startedAt} → ${result.finishedAt}）${args.dryRun ? ' [干跑]' : ''}`
    );
    for (const s of result.sources) {
      console.log(
        `  ${s.ok ? '✓' : '✗'} ${s.sourceName}(${s.source})  解析 ${s.itemsFound} · 新增 ${s.itemsNew} · 更新 ${s.itemsUpdated} · 跳过 ${s.itemsSkipped}  ${s.durationMs}ms` +
          (s.ok ? '' : `\n      失败原因：${s.error ?? '未知'}`)
      );
      if (s.preview?.length) {
        for (const p of s.preview) console.log(`      - [${p.action}] ${p.title}`);
      }
    }
    console.log(
      `\n合计：新增 ${t.created} · 更新 ${t.updated} · 跳过 ${t.skipped} · 失败源 ${t.failedSources}\n`
    );
    if (!args.dryRun && t.created > 0) {
      console.log('新增条目已入库为草稿，请在控制台确认后发布：/console?tab=posts\n');
    }
  }

  await closePool();
  process.exit(result.totals.failedSources > 0 ? 1 : 0);
}

main().catch(async (e) => {
  logger.error({ err: e }, '抓取 CLI 执行失败');
  try {
    await closePool();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
