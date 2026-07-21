import type { FastifyInstance } from 'fastify';
import type { AdminOverview, AdminUserOverview } from '../../../shared/api-types';
import { requireOwner } from '../auth/middleware';
import { config } from '../config';
import { getDb } from '../db';
import { dataUsageBytes } from '../storage';

const ACTIVE_GENERATION_STATUSES = ['queued', 'uploading_assets', 'submitted', 'rendering', 'downloading'];

interface AdminUserRow {
  id: string;
  telegram_id: number;
  tg_username: string;
  tg_first_name: string;
  tg_photo_url: string;
  status: 'active' | 'blocked';
  created_at: string;
  last_login_at: string | null;
  balance_cents: number;
  held_cents: number;
  projects: number;
  models: number;
  renders: number;
  done_renders: number;
  failed_renders: number;
  active_renders: number;
  latest_project_title: string | null;
  latest_project_status: string | null;
  latest_generation_status: string | null;
  last_activity_at: string;
}

const usd = (cents: number): number => Math.round(cents) / 100;

function toAdminUser(row: AdminUserRow): AdminUserOverview {
  return {
    id: row.id,
    telegramId: row.telegram_id,
    username: row.tg_username,
    firstName: row.tg_first_name,
    photoUrl: row.tg_photo_url,
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    lastActivityAt: row.last_activity_at,
    balance: {
      balanceUsd: usd(row.balance_cents),
      heldUsd: usd(row.held_cents),
      availableUsd: usd(row.balance_cents - row.held_cents),
    },
    projects: row.projects,
    models: row.models,
    renders: row.renders,
    doneRenders: row.done_renders,
    failedRenders: row.failed_renders,
    activeRenders: row.active_renders,
    latestProjectTitle: row.latest_project_title,
    latestProjectStatus: row.latest_project_status,
    latestGenerationStatus: row.latest_generation_status,
  };
}

export function registerAdminRoutes(app: FastifyInstance): void {
  app.get('/api/admin/overview', { preHandler: requireOwner }, async (): Promise<AdminOverview> => {
    const db = getDb();
    const activePlaceholders = ACTIVE_GENERATION_STATUSES.map(() => '?').join(',');
    const rows = db
      .prepare(
        `WITH ledger_stats AS (
           SELECT user_id, COALESCE(SUM(delta_credits), 0) AS balance_cents,
                  MAX(created_at) AS last_ledger_at
             FROM credit_ledger GROUP BY user_id
         ), hold_stats AS (
           SELECT user_id, COALESCE(SUM(credits), 0) AS held_cents
             FROM credit_holds WHERE status = 'open' GROUP BY user_id
         ), project_stats AS (
           SELECT user_id, COUNT(*) AS projects, MAX(created_at) AS last_project_at
             FROM projects GROUP BY user_id
         ), model_stats AS (
           SELECT user_id, COUNT(*) AS models FROM models GROUP BY user_id
         ), generation_stats AS (
           SELECT user_id,
                  COUNT(*) AS renders,
                  SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_renders,
                  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_renders,
                  SUM(CASE WHEN status IN (${activePlaceholders}) THEN 1 ELSE 0 END) AS active_renders,
                  MAX(COALESCE(finished_at, submitted_at, created_at)) AS last_generation_at
             FROM generations GROUP BY user_id
         )
         SELECT u.id, u.telegram_id, u.tg_username, u.tg_first_name, u.tg_photo_url,
                u.status, u.created_at, u.last_login_at,
                COALESCE(ls.balance_cents, 0) AS balance_cents,
                COALESCE(hs.held_cents, 0) AS held_cents,
                COALESCE(ps.projects, 0) AS projects,
                COALESCE(ms.models, 0) AS models,
                COALESCE(gs.renders, 0) AS renders,
                COALESCE(gs.done_renders, 0) AS done_renders,
                COALESCE(gs.failed_renders, 0) AS failed_renders,
                COALESCE(gs.active_renders, 0) AS active_renders,
                (SELECT p.title FROM projects p WHERE p.user_id = u.id
                  ORDER BY p.created_at DESC, p.rowid DESC LIMIT 1) AS latest_project_title,
                (SELECT p.status FROM projects p WHERE p.user_id = u.id
                  ORDER BY p.created_at DESC, p.rowid DESC LIMIT 1) AS latest_project_status,
                (SELECT g.status FROM generations g WHERE g.user_id = u.id
                  ORDER BY g.created_at DESC, g.rowid DESC LIMIT 1) AS latest_generation_status,
                MAX(u.created_at,
                    COALESCE(u.last_login_at, ''),
                    COALESCE(ps.last_project_at, ''),
                    COALESCE(gs.last_generation_at, ''),
                    COALESCE(ls.last_ledger_at, '')) AS last_activity_at
           FROM users u
           LEFT JOIN ledger_stats ls ON ls.user_id = u.id
           LEFT JOIN hold_stats hs ON hs.user_id = u.id
           LEFT JOIN project_stats ps ON ps.user_id = u.id
           LEFT JOIN model_stats ms ON ms.user_id = u.id
           LEFT JOIN generation_stats gs ON gs.user_id = u.id
          WHERE u.role = 'user'
          ORDER BY active_renders DESC, last_activity_at DESC, u.created_at DESC`,
      )
      .all(...ACTIVE_GENERATION_STATUSES) as unknown as AdminUserRow[];

    const users = rows.map(toAdminUser);
    const count = (sql: string, ...params: string[]) =>
      (db.prepare(sql).get(...params) as { n: number }).n;
    const pendingPayments = count(
      `SELECT COUNT(*) AS n FROM payment_intents WHERE status IN ('creating','pending','paid')`,
    );
    const quarantinedPayments = count(
      `SELECT COUNT(*) AS n FROM payment_intents WHERE status='quarantined'`,
    );
    const staleJobs = count(
      `SELECT COUNT(*) AS n FROM jobs WHERE status='running' AND lease_expires_at < datetime('now')`,
    );
    const stuckRenders = count(
      `SELECT COUNT(*) AS n FROM generations
        WHERE status IN ('queued','uploading_assets','submitted','rendering','downloading')
          AND created_at < datetime('now','-45 minutes')`,
    );
    const staleHolds = count(
      `SELECT COUNT(*) AS n FROM credit_holds
        WHERE status='open' AND created_at < datetime('now','-30 minutes')`,
    );
    const failedJobs24h = count(
      `SELECT COUNT(*) AS n FROM jobs
        WHERE status='failed' AND finished_at >= datetime('now','-24 hours')`,
    );
    const diskUsedPct = Math.round((dataUsageBytes() / config.storageCapBytes) * 100);
    const alerts: string[] = [];
    if (quarantinedPayments) alerts.push(`Платежи в карантине: ${quarantinedPayments}`);
    if (staleJobs) alerts.push(`Просроченные lease задач: ${staleJobs}`);
    if (stuckRenders) alerts.push(`Рендеры без terminal state >45 мин: ${stuckRenders}`);
    if (staleHolds) alerts.push(`Открытые резервы >30 мин: ${staleHolds}`);
    if (diskUsedPct >= 80) alerts.push(`Хранилище заполнено на ${diskUsedPct}%`);
    return {
      generatedAt: new Date().toISOString(),
      summary: users.reduce(
        (summary, user) => ({
          users: summary.users + 1,
          totalBalanceUsd: summary.totalBalanceUsd + user.balance.balanceUsd,
          heldUsd: summary.heldUsd + user.balance.heldUsd,
          activeRenders: summary.activeRenders + user.activeRenders,
          completedRenders: summary.completedRenders + user.doneRenders,
        }),
        { users: 0, totalBalanceUsd: 0, heldUsd: 0, activeRenders: 0, completedRenders: 0 },
      ),
      operations: {
        pendingPayments,
        quarantinedPayments,
        staleJobs,
        stuckRenders,
        staleHolds,
        failedJobs24h,
        diskUsedPct,
        alerts,
      },
      users,
    };
  });
}
