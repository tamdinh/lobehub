// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BillingService,
  MockBillingAdapter,
} from '@/business/server/billing/BillingService';
import { EntitlementService } from '@/business/server/billing/EntitlementService';
import type { LobeChatDatabase } from '@/database/type';
import type { ActorContext } from '@lobechat/types';

describe('SaaS Entitlements, Quotas, and Billing Boundary', () => {
  let mockDb: any;
  let subscriptionsStore: any[];
  let plansStore: any[];
  let usageSummary: any;
  let creditBalance: any;
  let auditLogsStore: any[];

  beforeEach(() => {
    subscriptionsStore = [];
    plansStore = [];
    auditLogsStore = [];
    usageSummary = {
      count: 0,
      netCostMicros: 0,
      netInputTokens: 0,
      netOutputTokens: 0,
      netTotalTokens: 50_000, // 50k tokens used
    };
    creditBalance = {
      netBalanceMicros: 0,
      totalConsumedMicros: 0,
      totalGrantedMicros: 0,
    };

    mockDb = {
      insert: vi.fn(() => ({
        values: vi.fn((val: any) => {
          const row = { id: `id-${subscriptionsStore.length + 1}`, createdAt: new Date(), ...val };
          subscriptionsStore.push(row);
          return Object.assign(Promise.resolve([row]), {
            returning: vi.fn(async () => [row]),
          });
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((val: any) => ({
          where: vi.fn(async () => {
            if (subscriptionsStore.length > 0) {
              Object.assign(subscriptionsStore[0], val);
            }
          }),
        })),
      })),
      query: {
        saasPlans: {
          findMany: vi.fn(async () => plansStore),
        },
        saasSubscriptions: {
          findMany: vi.fn(async () => subscriptionsStore),
        },
      },
    };
  });

  const mockActor: ActorContext = {
    actorId: 'usr-owner-1',
    actorType: 'USER',
    authSource: 'SESSION',
    organizationId: 'org-tenant-1',
    permissions: ['*'],
    roles: ['owner'],
  };

  describe('EntitlementService', () => {
    it('restricts free plan tenants from accessing premium models', async () => {
      const mockUsageLedger = {
        getCreditBalance: vi.fn(async () => creditBalance),
        getTenantUsageSummary: vi.fn(async () => usageSummary),
      };

      const entitlements = new EntitlementService(
        mockDb as unknown as LobeChatDatabase,
        mockUsageLedger as any,
      );

      // Standard model (e.g. gpt-4o-mini) -> allowed
      const standardCheck = await entitlements.checkModelAccess('ws-free', 'standard');
      expect(standardCheck.allowed).toBe(true);

      // Premium model (e.g. claude-3-5-sonnet) -> denied for free tier
      const premiumCheck = await entitlements.checkModelAccess('ws-free', 'premium');
      expect(premiumCheck.allowed).toBe(false);
      expect(premiumCheck.reason).toMatch(/PLAN_UPGRADE_REQUIRED/);
    });

    it('allows pro plan tenants access to premium models', async () => {
      // Set active Pro subscription
      subscriptionsStore.push({
        id: 'sub-pro-1',
        planId: 'pro',
        status: 'active',
        workspaceId: 'ws-pro',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });

      const mockUsageLedger = {
        getCreditBalance: vi.fn(async () => creditBalance),
        getTenantUsageSummary: vi.fn(async () => usageSummary),
      };

      const entitlements = new EntitlementService(
        mockDb as unknown as LobeChatDatabase,
        mockUsageLedger as any,
      );

      const premiumCheck = await entitlements.checkModelAccess('ws-pro', 'premium');
      expect(premiumCheck.allowed).toBe(true);
    });

    it('enforces monthly token quota and allows overage with prepaid credits', async () => {
      // Free plan limit is 100,000 tokens
      usageSummary.netTotalTokens = 95_000;

      const mockUsageLedger = {
        getCreditBalance: vi.fn(async () => creditBalance),
        getTenantUsageSummary: vi.fn(async () => usageSummary),
      };

      const entitlements = new EntitlementService(
        mockDb as unknown as LobeChatDatabase,
        mockUsageLedger as any,
      );

      // Requesting 4,000 tokens (95k + 4k <= 100k) -> allowed
      const checkUnder = await entitlements.checkTokenQuota('ws-free', 4000);
      expect(checkUnder.allowed).toBe(true);

      // Requesting 10,000 tokens (95k + 10k > 100k) -> quota exceeded
      const checkOver = await entitlements.checkTokenQuota('ws-free', 10000);
      expect(checkOver.allowed).toBe(false);
      expect(checkOver.reason).toMatch(/TOKEN_QUOTA_EXCEEDED/);

      // When tenant has credit balance -> allowed overage
      creditBalance.netBalanceMicros = 50_000_000;
      const checkWithCredits = await entitlements.checkTokenQuota('ws-free', 10000);
      expect(checkWithCredits.allowed).toBe(true);
      expect(checkWithCredits.reason).toBe('OVERAGE_COVERED_BY_CREDITS');
    });

    it('enforces maximum agent limits per plan', async () => {
      const entitlements = new EntitlementService(mockDb as unknown as LobeChatDatabase);

      // Free plan limit is 3 agents
      const allowed = await entitlements.checkAgentQuota('ws-free', 2);
      expect(allowed.allowed).toBe(true);

      const blocked = await entitlements.checkAgentQuota('ws-free', 3);
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toMatch(/AGENT_LIMIT_REACHED/);
    });
  });

  describe('BillingService Boundary', () => {
    it('creates checkout session and preserves payment provider isolation', async () => {
      const mockAuditService: any = {
        recordAuditEvent: vi.fn(async (event: any) => {
          auditLogsStore.push(event);
        }),
      };

      const billing = new BillingService(
        mockDb as unknown as LobeChatDatabase,
        new MockBillingAdapter(),
        mockAuditService,
      );

      const res = await billing.createCheckoutSession(
        {
          planId: 'pro',
          returnUrl: 'https://app.lobechat.local/settings/billing',
          workspaceId: 'ws-free',
        },
        mockActor,
      );

      expect(res.checkoutUrl).toContain('checkout.billing.local');
      expect(mockAuditService.recordAuditEvent).toHaveBeenCalled();
      expect(auditLogsStore[0].action).toBe('billing.checkout.create');
    });

    it('processes webhooks to activate new subscription and supports cancellation', async () => {
      const mockAuditService: any = {
        recordAuditEvent: vi.fn(async (event: any) => {
          auditLogsStore.push(event);
        }),
      };

      const billing = new BillingService(
        mockDb as unknown as LobeChatDatabase,
        new MockBillingAdapter(),
        mockAuditService,
      );

      // Ingest subscription created webhook
      await billing.processWebhook({
        customerId: 'cus_123',
        planId: 'pro',
        status: 'active',
        subscriptionId: 'sub_stripe_abc',
        type: 'customer.subscription.created',
        workspaceId: 'ws-checkout-1',
      });

      expect(subscriptionsStore).toHaveLength(1);
      expect(subscriptionsStore[0].planId).toBe('pro');
      expect(subscriptionsStore[0].status).toBe('active');

      // Cancel subscription
      await billing.cancelSubscription('ws-checkout-1', mockActor);
      expect(subscriptionsStore[0].status).toBe('canceled');
      expect(auditLogsStore.some((a) => a.action === 'billing.subscription.cancel')).toBe(true);
    });
  });
});
