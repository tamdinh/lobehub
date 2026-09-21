import { getServerDB } from '@lobechat/database';
import { AgentModel } from '@lobechat/database/models/agent';
import { AgentOperationModel } from '@lobechat/database/models/agentOperation';
import type { LobeChatDatabase } from '@lobechat/database/type';
import type { SecurityContext } from '@lobechat/types';
import { TRPCError } from '@trpc/server';
import { randomUUID } from 'node:crypto';

import { AuthorizationService } from '../auth/AuthorizationService';
import { EntitlementService } from '../billing/EntitlementService';
import { ModelCatalogService } from '../catalog/ModelCatalogService';

export interface ExecuteAgentOptions {
  agentId: string;
  context: SecurityContext;
  sessionId?: string;
  topicId?: string;
  input?: Record<string, unknown>;
}

export interface AgentRunRecord {
  actorId: string;
  agentId: string;
  completedAt?: Date;
  metadata?: Record<string, unknown>;
  organizationId?: string;
  requestId: string;
  runId: string;
  startedAt: Date;
  status: 'dispatched' | 'running' | 'completed' | 'failed';
  traceId?: string;
  workspaceId?: string;
}

export class AgentService {
  private db: LobeChatDatabase;
  private authService: AuthorizationService;

  constructor(db: LobeChatDatabase) {
    this.db = db;
    this.authService = new AuthorizationService(db);
  }

  static create = async (): Promise<AgentService> => {
    const db = await getServerDB();
    return new AgentService(db);
  };

  /**
   * Pre-flight validation and execution wrapper for an AI Agent.
   * Enforces the architectural boundary:
   * Request -> Identity -> Actor -> Scope -> Authorization -> AgentService -> Agent Runtime.
   */
  prepareAgentRun = async (params: ExecuteAgentOptions): Promise<AgentRunRecord> => {
    const { agentId, context } = params;

    // 1. Authorization check: actor must have agent execution rights
    if (!context.actor || !context.actor.actorId) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
    }

    if (context.workspaceId) {
      const hasExecPerm = await this.authService.hasEffectivePermission(
        context.actor.actorId,
        context.workspaceId,
        'agent:execute',
      );

      // If explicit check misses, verify if member has general execution rights
      if (!hasExecPerm && context.workspaceRole === 'viewer') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'INSUFFICIENT_PERMISSIONS: Viewer cannot execute agents',
        });
      }
    }

    // 2. Tenant isolation: verify agent belongs to the caller's workspace
    const agentModel = new AgentModel(
      this.db,
      context.actor.actorId,
      context.workspaceId ?? undefined,
    );

    const agent = await this.db.query.agents.findFirst({
      where: (t, { and, eq, isNull, or }) => {
        if (context.workspaceId) {
          // In workspace mode, must belong to current workspace or be system agent
          return and(eq(t.id, agentId), or(eq(t.workspaceId, context.workspaceId), isNull(t.workspaceId)));
        }
        // In personal mode, must belong to current user
        return and(eq(t.id, agentId), eq(t.userId, context.actor.actorId));
      },
    });

    if (!agent) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'AGENT_ACCESS_DENIED: Agent does not exist in the active tenant scope',
      });
    }

    // 2.5 Commercial Entitlements & Quota Gating
    if (context.workspaceId) {
      const entitlementService = new EntitlementService(this.db);
      const catalog = new ModelCatalogService();

      // Check model tier entitlements if model is specified
      if (agent.model) {
        const commercialModel = catalog.getModel(agent.model);
        const tier = commercialModel?.tier || 'standard';
        const modelCheck = await entitlementService.checkModelAccess(context.workspaceId, tier);

        if (!modelCheck.allowed) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: modelCheck.reason || 'PLAN_UPGRADE_REQUIRED: Model access restricted by plan',
          });
        }
      }

      // Check token quota & prepaid credit balance
      const quotaCheck = await entitlementService.checkTokenQuota(context.workspaceId, 0);
      if (!quotaCheck.allowed) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: quotaCheck.reason || 'TOKEN_QUOTA_EXCEEDED: Workspace quota exceeded',
        });
      }
    }

    // 3. Allocate Run ID and correlate with request/trace context
    const runId = `run_${randomUUID().replace(/-/g, '')}`;

    const runRecord: AgentRunRecord = {
      actorId: context.actor.actorId,
      agentId,
      metadata: {
        sessionId: params.sessionId,
        topicId: params.topicId,
      },
      organizationId: context.organizationId,
      requestId: context.requestId,
      runId,
      startedAt: new Date(),
      status: 'dispatched',
      traceId: context.traceId,
      workspaceId: context.workspaceId,
    };

    return runRecord;
  };
}
