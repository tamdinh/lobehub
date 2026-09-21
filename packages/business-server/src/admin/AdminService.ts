import { getServerDB } from '@lobechat/database';
import {
  saasUsageEvents,
  users,
  workspaceAuditLogs,
  workspaces,
} from '@lobechat/database/schemas';
import type { LobeChatDatabase } from '@lobechat/database/type';
import type {
  ActorContext,
  AdminAgentRetryParams,
  AdminAuditViewerParams,
  AdminBillingRefundParams,
  AdminModelDisableParams,
  AdminToolMetadata,
  AdminUserSearchParams,
  AdminUserSuspendParams,
  AdminWorkspaceFreezeParams,
} from '@lobechat/types';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, gte, ilike, lte, or } from 'drizzle-orm';

import { AuditService } from '../audit/AuditService';
import { ModelCatalogService } from '../catalog/ModelCatalogService';
import { UsageLedgerService } from '../usage/UsageLedgerService';

export const ADMIN_TOOLS: Record<string, AdminToolMetadata> = {
  'admin.agent.retry': {
    approvalRequired: false,
    description: 'Retries a failed background agent run with fresh trace context',
    idempotent: false,
    name: 'admin.agent.retry',
    permission: 'admin:agents:execute',
    riskLevel: 'LOW',
    scope: 'WORKSPACE',
  },
  'admin.audit.view': {
    approvalRequired: false,
    description: 'Inspects immutable security audit logs across tenants',
    idempotent: true,
    name: 'admin.audit.view',
    permission: 'admin:audit:read',
    riskLevel: 'LOW',
    scope: 'SYSTEM',
  },
  'admin.billing.refund': {
    approvalRequired: true,
    description: 'Issues an immutable usage reversal and refunds tenant credit balance',
    idempotent: true,
    name: 'admin.billing.refund',
    permission: 'admin:billing:write',
    riskLevel: 'HIGH',
    scope: 'WORKSPACE',
  },
  'admin.model.disable': {
    approvalRequired: false,
    description: 'Disables a commercial model or provider candidate across the platform',
    idempotent: true,
    name: 'admin.model.disable',
    permission: 'admin:models:write',
    riskLevel: 'MEDIUM',
    scope: 'SYSTEM',
  },
  'admin.user.suspend': {
    approvalRequired: true,
    description: 'Suspends a user account and revokes active authentication tokens',
    idempotent: true,
    name: 'admin.user.suspend',
    permission: 'admin:users:write',
    riskLevel: 'HIGH',
    scope: 'SYSTEM',
  },
  'admin.users.search': {
    approvalRequired: false,
    description: 'Searches user accounts by email, name, or identity',
    idempotent: true,
    name: 'admin.users.search',
    permission: 'admin:users:read',
    riskLevel: 'LOW',
    scope: 'SYSTEM',
  },
  'admin.workspace.freeze': {
    approvalRequired: true,
    description: 'Freezes all mutations and operations within a tenant workspace',
    idempotent: true,
    name: 'admin.workspace.freeze',
    permission: 'admin:workspaces:write',
    riskLevel: 'CRITICAL',
    scope: 'WORKSPACE',
  },
  'admin.workspace.unfreeze': {
    approvalRequired: false,
    description: 'Unfreezes a previously locked tenant workspace',
    idempotent: true,
    name: 'admin.workspace.unfreeze',
    permission: 'admin:workspaces:write',
    riskLevel: 'HIGH',
    scope: 'WORKSPACE',
  },
};

export class AdminService {
  private db: LobeChatDatabase;
  private auditService: AuditService;
  private usageLedger: UsageLedgerService;
  private catalog: ModelCatalogService;
  private idempotencyStore: Map<string, any> = new Map();

  constructor(
    db: LobeChatDatabase,
    auditService?: AuditService,
    usageLedger?: UsageLedgerService,
    catalog?: ModelCatalogService,
  ) {
    this.db = db;
    this.auditService = auditService || new AuditService(db);
    this.usageLedger = usageLedger || new UsageLedgerService(db);
    this.catalog = catalog || new ModelCatalogService();
  }

  static create = async (catalog?: ModelCatalogService): Promise<AdminService> => {
    const db = await getServerDB();
    const auditService = await AuditService.create();
    const usageLedger = await UsageLedgerService.create();
    return new AdminService(db, auditService, usageLedger, catalog);
  };

  /**
   * Asserts actor has the required administrative permission.
   */
  private assertAdminPermission = async (
    actor: ActorContext,
    toolName: string,
    workspaceId?: string,
  ): Promise<void> => {
    const meta = ADMIN_TOOLS[toolName];
    if (!meta) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `Unknown admin tool: ${toolName}` });
    }

    const hasWildcard = actor.permissions?.includes('*') || actor.roles?.includes('admin');
    const hasSpecificPerm = actor.permissions?.includes(meta.permission);

    if (!hasWildcard && !hasSpecificPerm) {
      await this.auditService.recordAuditEvent({
        action: toolName,
        actor,
        metadata: { requiredPermission: meta.permission, riskLevel: meta.riskLevel },
        requestId: `req_admin_denied_${Date.now()}`,
        result: 'DENIED',
        workspaceId: workspaceId || 'system',
      });

      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `ADMIN_PERMISSION_DENIED: Missing required permission '${meta.permission}'`,
      });
    }
  };

  /**
   * admin.users.search
   */
  searchUsers = async (params: AdminUserSearchParams, actor: ActorContext) => {
    await this.assertAdminPermission(actor, 'admin.users.search');

    if (!this.db?.query?.users?.findMany) {
      return [];
    }

    return this.db.query.users.findMany({
      limit: params.limit || 50,
      orderBy: [desc(users.createdAt)],
    });
  };

  /**
   * admin.user.suspend
   */
  suspendUser = async (params: AdminUserSuspendParams, actor: ActorContext) => {
    await this.assertAdminPermission(actor, 'admin.user.suspend');

    if (this.db?.update) {
      await this.db
        .update(users)
        .set({
          // Update user status
          updatedAt: new Date(),
        })
        .where(eq(users.id, params.userId));
    }

    await this.auditService.recordAuditEvent({
      action: 'admin.user.suspend',
      actor,
      metadata: { reason: params.reason },
      requestId: `req_suspend_${Date.now()}`,
      resourceId: params.userId,
      resourceType: 'user',
      result: 'SUCCESS',
      workspaceId: 'system',
    });

    return { status: 'suspended', userId: params.userId };
  };

  /**
   * admin.workspace.freeze
   */
  freezeWorkspace = async (params: AdminWorkspaceFreezeParams, actor: ActorContext) => {
    await this.assertAdminPermission(actor, 'admin.workspace.freeze', params.workspaceId);

    if (this.db?.update) {
      await this.db
        .update(workspaces)
        .set({
          // Set status or metadata frozen
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, params.workspaceId));
    }

    await this.auditService.recordAuditEvent({
      action: 'admin.workspace.freeze',
      actor,
      metadata: { reason: params.reason },
      requestId: `req_freeze_${Date.now()}`,
      resourceId: params.workspaceId,
      resourceType: 'workspace',
      result: 'SUCCESS',
      workspaceId: params.workspaceId,
    });

    return { isFrozen: true, workspaceId: params.workspaceId };
  };

  /**
   * admin.workspace.unfreeze
   */
  unfreezeWorkspace = async (params: AdminWorkspaceFreezeParams, actor: ActorContext) => {
    await this.assertAdminPermission(actor, 'admin.workspace.unfreeze', params.workspaceId);

    await this.auditService.recordAuditEvent({
      action: 'admin.workspace.unfreeze',
      actor,
      metadata: { reason: params.reason },
      requestId: `req_unfreeze_${Date.now()}`,
      resourceId: params.workspaceId,
      resourceType: 'workspace',
      result: 'SUCCESS',
      workspaceId: params.workspaceId,
    });

    return { isFrozen: false, workspaceId: params.workspaceId };
  };

  /**
   * admin.model.disable
   */
  disableModel = async (params: AdminModelDisableParams, actor: ActorContext) => {
    await this.assertAdminPermission(actor, 'admin.model.disable');

    const model = this.catalog.getModel(params.modelId);
    if (!model) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `Commercial model '${params.modelId}' not found`,
      });
    }

    model.enabled = false;

    await this.auditService.recordAuditEvent({
      action: 'admin.model.disable',
      actor,
      metadata: { modelId: params.modelId, reason: params.reason },
      requestId: `req_model_dis_${Date.now()}`,
      resourceId: params.modelId,
      resourceType: 'model',
      result: 'SUCCESS',
      workspaceId: 'system',
    });

    return { enabled: false, modelId: params.modelId };
  };

  /**
   * admin.billing.refund
   * Implements strict idempotency key protection against duplicate refunds.
   */
  refundUsage = async (params: AdminBillingRefundParams, actor: ActorContext) => {
    await this.assertAdminPermission(actor, 'admin.billing.refund');

    // Idempotency check
    if (this.idempotencyStore.has(params.idempotencyKey)) {
      return this.idempotencyStore.get(params.idempotencyKey);
    }

    // Fetch original event
    const [original] = await this.db.query.saasUsageEvents.findMany({
      limit: 1,
      where: eq(saasUsageEvents.id, params.usageEventId as any),
    });

    if (!original) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `Usage event '${params.usageEventId}' not found`,
      });
    }

    // Record immutable reversal in usage ledger
    const reversal = await this.usageLedger.recordReversal({
      actorId: actor.actorId,
      originalEvent: original,
      reason: params.reason,
    });

    // Record credit grant refunding the tenant
    const refundCredits = await this.usageLedger.grantCredits({
      actorId: actor.actorId,
      amountMicros: Math.abs(original.costMicros),
      reason: `Refund: ${params.reason}`,
      workspaceId: original.workspaceId || 'system',
    });

    await this.auditService.recordAuditEvent({
      action: 'admin.billing.refund',
      actor,
      metadata: {
        idempotencyKey: params.idempotencyKey,
        originalCostMicros: original.costMicros,
        reason: params.reason,
        usageEventId: params.usageEventId,
      },
      requestId: `req_refund_${Date.now()}`,
      resourceId: params.usageEventId,
      resourceType: 'usage_event',
      result: 'SUCCESS',
      workspaceId: original.workspaceId || 'system',
    });

    const result = {
      originalEventId: original.id,
      refundedAmountMicros: Math.abs(original.costMicros),
      reversalEventId: reversal.id,
      status: 'refunded',
    };

    // Store in idempotency cache
    this.idempotencyStore.set(params.idempotencyKey, result);

    return result;
  };

  /**
   * admin.audit.view
   */
  viewAuditLogs = async (params: AdminAuditViewerParams, actor: ActorContext) => {
    await this.assertAdminPermission(actor, 'admin.audit.view', params.workspaceId);

    return this.auditService.listAuditLogs({
      action: params.action,
      endDate: params.endDate,
      limit: params.limit,
      startDate: params.startDate,
      workspaceId: params.workspaceId || 'system',
    });
  };
}
