import { getServerDB } from '@lobechat/database';
import {
  type SaasSubscriptionItem,
  saasSubscriptions,
} from '@lobechat/database/schemas';
import type { LobeChatDatabase } from '@lobechat/database/type';
import type { ActorContext } from '@lobechat/types';
import { and, desc, eq } from 'drizzle-orm';

import { AuditService } from '../audit/AuditService';

export interface CheckoutSessionParams {
  planId: string;
  returnUrl: string;
  userEmail?: string;
  workspaceId: string;
}

export interface WebhookResult {
  currentPeriodEnd?: Date;
  currentPeriodStart?: Date;
  eventType: string;
  planId?: string;
  status?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  workspaceId?: string;
}

export interface BillingAdapter {
  cancelSubscription(subscriptionId: string): Promise<boolean>;
  createCheckoutSession(
    params: CheckoutSessionParams,
  ): Promise<{ checkoutUrl: string; sessionId: string }>;
  createCustomerPortalSession(params: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ portalUrl: string }>;
  handleWebhookEvent(payload: any, signature?: string): Promise<WebhookResult>;
}

/**
 * Mock Billing Adapter for testing and local environments.
 */
export class MockBillingAdapter implements BillingAdapter {
  createCheckoutSession = async (
    params: CheckoutSessionParams,
  ): Promise<{ checkoutUrl: string; sessionId: string }> => {
    return {
      checkoutUrl: `https://checkout.billing.local/session_mock_${params.workspaceId}_${params.planId}`,
      sessionId: `sess_mock_${Date.now()}`,
    };
  };

  createCustomerPortalSession = async (params: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ portalUrl: string }> => {
    return {
      portalUrl: `https://billing.local/portal/${params.customerId}?return=${encodeURIComponent(params.returnUrl)}`,
    };
  };

  cancelSubscription = async (_subscriptionId: string): Promise<boolean> => {
    return true;
  };

  handleWebhookEvent = async (payload: any, _signature?: string): Promise<WebhookResult> => {
    return {
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      currentPeriodStart: new Date(),
      eventType: payload.type || 'customer.subscription.updated',
      planId: payload.planId || 'pro',
      status: payload.status || 'active',
      stripeCustomerId: payload.customerId || 'cus_mock_123',
      stripeSubscriptionId: payload.subscriptionId || 'sub_mock_123',
      workspaceId: payload.workspaceId,
    };
  };
}

/**
 * Authoritative SaaS Billing Service
 * Invariant: Runtimes and data plane must never interact with Stripe or payment vendors directly.
 */
export class BillingService {
  private db: LobeChatDatabase;
  private adapter: BillingAdapter;
  private auditService?: AuditService;

  constructor(db: LobeChatDatabase, adapter: BillingAdapter = new MockBillingAdapter(), auditService?: AuditService) {
    this.db = db;
    this.adapter = adapter;
    this.auditService = auditService;
  }

  static create = async (adapter?: BillingAdapter): Promise<BillingService> => {
    const db = await getServerDB();
    const auditService = await AuditService.create();
    return new BillingService(db, adapter || new MockBillingAdapter(), auditService);
  };

  /**
   * Generates a checkout URL for plan upgrade / subscription.
   */
  createCheckoutSession = async (
    params: CheckoutSessionParams,
    actor: ActorContext,
  ): Promise<{ checkoutUrl: string }> => {
    const session = await this.adapter.createCheckoutSession(params);

    if (this.auditService) {
      await this.auditService.recordAuditEvent({
        action: 'billing.checkout.create',
        actor,
        metadata: { planId: params.planId },
        requestId: `req_checkout_${Date.now()}`,
        result: 'SUCCESS',
        workspaceId: params.workspaceId,
      });
    }

    return { checkoutUrl: session.checkoutUrl };
  };

  /**
   * Processes inbound webhooks from payment provider and synchronizes database state.
   */
  processWebhook = async (payload: any, signature?: string): Promise<void> => {
    const event = await this.adapter.handleWebhookEvent(payload, signature);

    if (!event.workspaceId) {
      return;
    }

    const [existing] = await this.db.query.saasSubscriptions.findMany({
      limit: 1,
      where: eq(saasSubscriptions.workspaceId, event.workspaceId),
    });

    const now = new Date();
    const periodStart = event.currentPeriodStart || now;
    const periodEnd = event.currentPeriodEnd || new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    if (existing) {
      await this.db
        .update(saasSubscriptions)
        .set({
          currentPeriodEnd: periodEnd,
          currentPeriodStart: periodStart,
          planId: event.planId || existing.planId,
          status: (event.status as any) || existing.status,
          stripeCustomerId: event.stripeCustomerId || existing.stripeCustomerId,
          stripeSubscriptionId: event.stripeSubscriptionId || existing.stripeSubscriptionId,
          updatedAt: now,
        })
        .where(eq(saasSubscriptions.id, existing.id));
    } else {
      await this.db.insert(saasSubscriptions).values({
        currentPeriodEnd: periodEnd,
        currentPeriodStart: periodStart,
        planId: event.planId || 'pro',
        status: (event.status as any) || 'active',
        stripeCustomerId: event.stripeCustomerId,
        stripeSubscriptionId: event.stripeSubscriptionId,
        workspaceId: event.workspaceId,
      });
    }
  };

  /**
   * Cancels a workspace subscription.
   */
  cancelSubscription = async (workspaceId: string, actor: ActorContext): Promise<void> => {
    const [existing] = await this.db.query.saasSubscriptions.findMany({
      limit: 1,
      where: and(
        eq(saasSubscriptions.workspaceId, workspaceId),
        eq(saasSubscriptions.status, 'active'),
      ),
    });

    if (existing && existing.stripeSubscriptionId) {
      await this.adapter.cancelSubscription(existing.stripeSubscriptionId);

      await this.db
        .update(saasSubscriptions)
        .set({ cancelAtPeriodEnd: true, status: 'canceled', updatedAt: new Date() })
        .where(eq(saasSubscriptions.id, existing.id));

      if (this.auditService) {
        await this.auditService.recordAuditEvent({
          action: 'billing.subscription.cancel',
          actor,
          metadata: { subscriptionId: existing.id },
          requestId: `req_cancel_${Date.now()}`,
          result: 'SUCCESS',
          workspaceId,
        });
      }
    }
  };
}
