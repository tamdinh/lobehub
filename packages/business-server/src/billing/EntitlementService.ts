import { getServerDB } from '@lobechat/database';
import {
  type SaasPlanItem,
  saasPlans,
  type SaasSubscriptionItem,
  saasSubscriptions,
} from '@lobechat/database/schemas';
import type { LobeChatDatabase } from '@lobechat/database/type';
import type { ModelTier, TenantQuotaCheckResult } from '@lobechat/types';
import { and, desc, eq } from 'drizzle-orm';

import { UsageLedgerService } from '../usage/UsageLedgerService';

export const DEFAULT_PLANS: Record<string, SaasPlanItem> = {
  enterprise: {
    backgroundAgents: true,
    createdAt: new Date(),
    description: 'Custom limits, dedicated support, and enterprise models',
    id: 'enterprise',
    maxAgents: 100,
    maxWorkspaces: 50,
    metadata: {},
    monthlyTokens: 50_000_000,
    name: 'Enterprise Plan',
    premiumModels: true,
    updatedAt: new Date(),
  },
  free: {
    backgroundAgents: false,
    createdAt: new Date(),
    description: 'Free tier for personal exploration',
    id: 'free',
    maxAgents: 3,
    maxWorkspaces: 1,
    metadata: {},
    monthlyTokens: 100_000,
    name: 'Free Plan',
    premiumModels: false,
    updatedAt: new Date(),
  },
  pro: {
    backgroundAgents: true,
    createdAt: new Date(),
    description: 'Professional tier with premium models and increased limits',
    id: 'pro',
    maxAgents: 20,
    maxWorkspaces: 5,
    metadata: {},
    monthlyTokens: 2_000_000,
    name: 'Pro Plan',
    premiumModels: true,
    updatedAt: new Date(),
  },
};

export class EntitlementService {
  private db: LobeChatDatabase;
  private usageLedger: UsageLedgerService;

  constructor(db: LobeChatDatabase, usageLedger?: UsageLedgerService) {
    this.db = db;
    this.usageLedger = usageLedger || new UsageLedgerService(db);
  }

  static create = async (): Promise<EntitlementService> => {
    const db = await getServerDB();
    return new EntitlementService(db);
  };

  /**
   * Retrieves active subscription for a workspace.
   */
  getTenantSubscription = async (workspaceId: string): Promise<SaasSubscriptionItem | null> => {
    if (!this.db?.query?.saasSubscriptions?.findMany) {
      return null;
    }

    const [sub] = await this.db.query.saasSubscriptions.findMany({
      limit: 1,
      orderBy: [desc(saasSubscriptions.createdAt)],
      where: and(
        eq(saasSubscriptions.workspaceId, workspaceId),
        eq(saasSubscriptions.status, 'active'),
      ),
    });

    return sub || null;
  };

  /**
   * Resolves the effective plan and entitlement limits for a workspace.
   */
  getTenantPlan = async (workspaceId: string): Promise<SaasPlanItem> => {
    const subscription = await this.getTenantSubscription(workspaceId);
    const planId = subscription?.planId || 'free';

    // Try finding custom plan definition in database
    if (this.db?.query?.saasPlans?.findMany) {
      const [dbPlan] = await this.db.query.saasPlans.findMany({
        limit: 1,
        where: eq(saasPlans.id, planId),
      });

      if (dbPlan) return dbPlan;
    }

    // Fall back to default predefined plans
    return DEFAULT_PLANS[planId] || DEFAULT_PLANS.free;
  };

  /**
   * Checks whether the tenant's plan allows access to a model tier.
   */
  checkModelAccess = async (
    workspaceId: string,
    modelTier: ModelTier,
  ): Promise<{ allowed: boolean; reason?: string }> => {
    if (modelTier === 'standard') {
      return { allowed: true };
    }

    const plan = await this.getTenantPlan(workspaceId);

    if (modelTier === 'premium') {
      if (plan.premiumModels) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: 'PLAN_UPGRADE_REQUIRED: Premium models require a Pro or Enterprise plan.',
      };
    }

    if (modelTier === 'enterprise') {
      if (plan.id === 'enterprise') {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: 'PLAN_UPGRADE_REQUIRED: Enterprise models require an Enterprise subscription.',
      };
    }

    return { allowed: true };
  };

  /**
   * Checks token quota against plan limits and prepaid credits.
   */
  checkTokenQuota = async (
    workspaceId: string,
    requestedTokens: number = 0,
  ): Promise<TenantQuotaCheckResult> => {
    const subscription = await this.getTenantSubscription(workspaceId);
    const plan = await this.getTenantPlan(workspaceId);

    // Period dates: subscription period or current month
    const now = new Date();
    const startDate =
      subscription?.currentPeriodStart || new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate =
      subscription?.currentPeriodEnd || new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const usage = await this.usageLedger.getTenantUsageSummary({
      endDate,
      startDate,
      workspaceId,
    });

    const current = usage.netTotalTokens;
    const limit = plan.monthlyTokens;

    if (current + requestedTokens <= limit) {
      return {
        allowed: true,
        current,
        limit,
      };
    }

    // Check if overage can be absorbed by credit balance
    const creditBalance = await this.usageLedger.getCreditBalance(workspaceId);
    if (creditBalance.netBalanceMicros > 0) {
      return {
        allowed: true,
        current,
        limit,
        reason: 'OVERAGE_COVERED_BY_CREDITS',
      };
    }

    return {
      allowed: false,
      current,
      limit,
      reason: `TOKEN_QUOTA_EXCEEDED: Plan limit of ${limit} tokens reached (${current} used).`,
    };
  };

  /**
   * Checks if tenant has reached the maximum allowed agents.
   */
  checkAgentQuota = async (
    workspaceId: string,
    currentAgentCount: number,
  ): Promise<TenantQuotaCheckResult> => {
    const plan = await this.getTenantPlan(workspaceId);

    const limit = plan.maxAgents;
    if (currentAgentCount >= limit) {
      return {
        allowed: false,
        current: currentAgentCount,
        limit,
        reason: `AGENT_LIMIT_REACHED: Tenant reached maximum agent limit of ${limit} for plan '${plan.name}'.`,
      };
    }

    return {
      allowed: true,
      current: currentAgentCount,
      limit,
    };
  };
}
