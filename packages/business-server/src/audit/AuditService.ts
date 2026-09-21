import { getServerDB, type LobeChatDatabase } from '@lobechat/database';
import {
  type NewWorkspaceAuditLog,
  workspaceAuditLogs,
  type WorkspaceAuditLogItem,
} from '@lobechat/database/schemas';
import type { ActorContext } from '@lobechat/types';
import { and, desc, eq, gte, lte } from 'drizzle-orm';

export interface AuditEventParams {
  action: string;
  actor: ActorContext;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
  organizationId?: string;
  requestId: string;
  resourceId?: string;
  resourceType?: string;
  result: 'SUCCESS' | 'DENIED' | 'FAILED';
  runId?: string;
  traceId?: string;
  workspaceId: string;
}

export class AuditService {
  private db: LobeChatDatabase;

  constructor(db: LobeChatDatabase) {
    this.db = db;
  }

  static create = async (): Promise<AuditService> => {
    const db = await getServerDB();
    return new AuditService(db);
  };

  /**
   * Records an immutable security audit event correlated with request, trace, and run IDs.
   */
  recordAuditEvent = async (params: AuditEventParams): Promise<WorkspaceAuditLogItem> => {
    const [log] = await this.db
      .insert(workspaceAuditLogs)
      .values({
        action: params.action,
        ipAddress: params.ipAddress,
        metadata: {
          actorType: params.actor.actorType,
          authSource: params.actor.authSource,
          organizationId: params.organizationId,
          requestId: params.requestId,
          result: params.result,
          runId: params.runId,
          traceId: params.traceId,
          ...params.metadata,
        },
        resourceId: params.resourceId,
        resourceType: params.resourceType,
        userId: params.actor.actorId,
        workspaceId: params.workspaceId,
      } satisfies NewWorkspaceAuditLog)
      .returning();

    return log;
  };

  /**
   * Query audit logs for a workspace with correlation filtering.
   */
  listAuditLogs = async (params: {
    action?: string;
    endDate?: Date;
    limit?: number;
    startDate?: Date;
    workspaceId: string;
  }): Promise<WorkspaceAuditLogItem[]> => {
    const conditions = [eq(workspaceAuditLogs.workspaceId, params.workspaceId)];

    if (params.action) {
      conditions.push(eq(workspaceAuditLogs.action, params.action));
    }
    if (params.startDate) {
      conditions.push(gte(workspaceAuditLogs.createdAt, params.startDate));
    }
    if (params.endDate) {
      conditions.push(lte(workspaceAuditLogs.createdAt, params.endDate));
    }

    return this.db.query.workspaceAuditLogs.findMany({
      limit: params.limit || 50,
      orderBy: [desc(workspaceAuditLogs.createdAt)],
      where: and(...conditions),
    });
  };
}
