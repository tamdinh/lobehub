import { getServerDB, type LobeChatDatabase } from '@lobechat/database';
import {
  type NewSaasUsageEvent,
  saasUsageEvents,
  type SaasUsageEventItem,
} from '@lobechat/database/schemas';
import { and, eq, gte, lte, sql } from 'drizzle-orm';

export interface UsageSummary {
  netCostMicros: number;
  netInputTokens: number;
  netOutputTokens: number;
  netTotalTokens: number;
  totalEvents: number;
}

export class UsageLedgerService {
  private db: LobeChatDatabase;

  constructor(db: LobeChatDatabase) {
    this.db = db;
  }

  static create = async (): Promise<UsageLedgerService> => {
    const db = await getServerDB();
    return new UsageLedgerService(db);
  };

  /**
   * Records a raw, immutable usage event emitted at the end of an Agent Run.
   */
  recordUsageEvent = async (event: Omit<NewSaasUsageEvent, 'id' | 'createdAt' | 'eventType'>): Promise<SaasUsageEventItem> => {
    const [record] = await this.db
      .insert(saasUsageEvents)
      .values({
        ...event,
        eventType: 'USAGE',
        totalTokens: event.totalTokens || (event.totalInputTokens || 0) + (event.totalOutputTokens || 0),
      })
      .returning();

    return record;
  };

  /**
   * Records an immutable adjustment to a previous usage event.
   * e.g. retroactive price correction or token reconciliation.
   */
  recordAdjustment = async (params: {
    actorId: string;
    adjustmentCostMicros: number;
    adjustmentTokens: number;
    reason: string;
    referenceEventId: string;
    workspaceId?: string;
  }): Promise<SaasUsageEventItem> => {
    const [record] = await this.db
      .insert(saasUsageEvents)
      .values({
        actorId: params.actorId,
        costMicros: params.adjustmentCostMicros,
        eventType: 'ADJUSTMENT',
        metadata: { reason: params.reason },
        referenceEventId: params.referenceEventId,
        totalTokens: params.adjustmentTokens,
        workspaceId: params.workspaceId,
      })
      .returning();

    return record;
  };

  /**
   * Records an immutable reversal (credit or full refund) of a previous usage event.
   */
  recordReversal = async (params: {
    actorId: string;
    originalEvent: SaasUsageEventItem;
    reason: string;
  }): Promise<SaasUsageEventItem> => {
    const [record] = await this.db
      .insert(saasUsageEvents)
      .values({
        actorId: params.actorId,
        costMicros: -Math.abs(params.originalEvent.costMicros),
        eventType: 'REVERSAL',
        metadata: { reason: params.reason },
        referenceEventId: params.originalEvent.id,
        totalInputTokens: -Math.abs(params.originalEvent.totalInputTokens),
        totalOutputTokens: -Math.abs(params.originalEvent.totalOutputTokens),
        totalTokens: -Math.abs(params.originalEvent.totalTokens),
        workspaceId: params.originalEvent.workspaceId,
      })
      .returning();

    return record;
  };

  /**
   * Aggregates usage events into an immutable financial summary.
   */
  getTenantUsageSummary = async (params: {
    endDate?: Date;
    startDate?: Date;
    workspaceId: string;
  }): Promise<UsageSummary> => {
    const conditions = [eq(saasUsageEvents.workspaceId, params.workspaceId)];

    if (params.startDate) {
      conditions.push(gte(saasUsageEvents.createdAt, params.startDate));
    }
    if (params.endDate) {
      conditions.push(lte(saasUsageEvents.createdAt, params.endDate));
    }

    if (!this.db?.select) {
      return {
        netCostMicros: 0,
        netInputTokens: 0,
        netOutputTokens: 0,
        netTotalTokens: 0,
        totalEvents: 0,
      };
    }

    const [result] = await this.db
      .select({
        count: sql<number>`count(*)::int`,
        netCostMicros: sql<number>`coalesce(sum(${saasUsageEvents.costMicros}), 0)::bigint`,
        netInputTokens: sql<number>`coalesce(sum(${saasUsageEvents.totalInputTokens}), 0)::int`,
        netOutputTokens: sql<number>`coalesce(sum(${saasUsageEvents.totalOutputTokens}), 0)::int`,
        netTotalTokens: sql<number>`coalesce(sum(${saasUsageEvents.totalTokens}), 0)::int`,
      })
      .from(saasUsageEvents)
      .where(and(...conditions));

    return {
      netCostMicros: Number(result?.netCostMicros ?? 0),
      netInputTokens: Number(result?.netInputTokens ?? 0),
      netOutputTokens: Number(result?.netOutputTokens ?? 0),
      netTotalTokens: Number(result?.netTotalTokens ?? 0),
      totalEvents: Number(result?.count ?? 0),
    };
  };

  /**
   * Grants immutable credits to a tenant (promotional, prepaid, or subscription-allocated).
   */
  grantCredits = async (params: {
    actorId: string;
    amountMicros: number;
    expiresAt?: Date;
    metadata?: Record<string, unknown>;
    organizationId?: string;
    reason: string;
    workspaceId: string;
  }): Promise<SaasUsageEventItem> => {
    if (params.amountMicros <= 0) {
      throw new Error('INVALID_CREDIT_AMOUNT: Grant amount must be greater than zero.');
    }

    const [record] = await this.db
      .insert(saasUsageEvents)
      .values({
        actorId: params.actorId,
        creditMicros: params.amountMicros,
        eventType: 'CREDIT_GRANT',
        expiresAt: params.expiresAt,
        metadata: { ...params.metadata, reason: params.reason },
        organizationId: params.organizationId,
        reason: params.reason,
        workspaceId: params.workspaceId,
      })
      .returning();

    return record;
  };

  /**
   * Consumes immutable credits from a tenant's balance.
   */
  consumeCredits = async (params: {
    actorId: string;
    amountMicros: number;
    metadata?: Record<string, unknown>;
    reason: string;
    runId?: string;
    workspaceId: string;
  }): Promise<SaasUsageEventItem> => {
    if (params.amountMicros <= 0) {
      throw new Error('INVALID_CREDIT_AMOUNT: Consumption amount must be greater than zero.');
    }

    const balance = await this.getCreditBalance(params.workspaceId);
    if (balance.netBalanceMicros < params.amountMicros) {
      throw new Error(
        `INSUFFICIENT_CREDITS: Required ${params.amountMicros} micros but available balance is ${balance.netBalanceMicros} micros.`,
      );
    }

    const [record] = await this.db
      .insert(saasUsageEvents)
      .values({
        actorId: params.actorId,
        creditMicros: params.amountMicros,
        eventType: 'CREDIT_CONSUMPTION',
        metadata: { ...params.metadata, reason: params.reason },
        reason: params.reason,
        runId: params.runId,
        workspaceId: params.workspaceId,
      })
      .returning();

    return record;
  };

  /**
   * Computes real-time credit balance from the immutable ledger.
   */
  getCreditBalance = async (
    workspaceId: string,
  ): Promise<{ netBalanceMicros: number; totalConsumedMicros: number; totalGrantedMicros: number }> => {
    if (!this.db?.query?.saasUsageEvents?.findMany) {
      return { netBalanceMicros: 0, totalConsumedMicros: 0, totalGrantedMicros: 0 };
    }

    const events = await this.db.query.saasUsageEvents.findMany({
      where: and(
        eq(saasUsageEvents.workspaceId, workspaceId),
        sql`${saasUsageEvents.eventType} IN ('CREDIT_GRANT', 'CREDIT_CONSUMPTION')`,
      ),
    });

    const now = new Date();
    let totalGrantedMicros = 0;
    let totalConsumedMicros = 0;

    for (const ev of events) {
      if (ev.eventType === 'CREDIT_GRANT') {
        // Exclude expired grants if expiration date is past
        if (ev.expiresAt && new Date(ev.expiresAt) < now) {
          continue;
        }
        totalGrantedMicros += ev.creditMicros || 0;
      } else if (ev.eventType === 'CREDIT_CONSUMPTION') {
        totalConsumedMicros += ev.creditMicros || 0;
      }
    }

    return {
      netBalanceMicros: Math.max(0, totalGrantedMicros - totalConsumedMicros),
      totalConsumedMicros,
      totalGrantedMicros,
    };
  };
}
