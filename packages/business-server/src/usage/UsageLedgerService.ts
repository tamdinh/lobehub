import { getServerDB } from '@lobechat/database';
import {
  type NewSaasUsageEvent,
  saasUsageEvents,
  type SaasUsageEventItem,
} from '@lobechat/database/schemas';
import type { LobeChatDatabase } from '@lobechat/database/type';
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
}
