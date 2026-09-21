// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceAccountService } from '@/business/server/auth/ServiceAccountService';
import { AgentSignalBus } from '@/business/server/background/AgentSignalBus';
import { BackgroundAgentService } from '@/business/server/background/BackgroundAgentService';
import type { LobeChatDatabase } from '@/database/type';
import type { ActorContext, SecurityContext } from '@lobechat/types';

describe('SaaS Background Operations (Mission 4)', () => {
  let mockDb: any;
  let auditLogsStore: any[];
  let usageEventsStore: any[];

  beforeEach(() => {
    auditLogsStore = [];
    usageEventsStore = [];
    mockDb = {
      query: {
        agents: {
          findFirst: vi.fn(async () => ({
            id: 'agent_bg_1',
            model: 'gpt-4o-mini',
            userId: 'usr_sa_1',
            workspaceId: 'ws_pro_1',
          })),
        },
        saasSubscriptions: {
          findMany: vi.fn(async () => []),
        },
      },
    };
  });

  describe('ServiceAccountService', () => {
    it('creates service account and authenticates scoped API key into unprivileged ActorContext', async () => {
      const saService = new ServiceAccountService(mockDb as unknown as LobeChatDatabase);

      // 1. Provision service account
      const sa = await saService.createServiceAccount({
        name: 'CI/CD Sync Worker',
        organizationId: 'org_enterprise',
        permissions: ['agent:read', 'agent:execute'],
        workspaceId: 'ws_pro_1',
      });

      expect(sa.id).toMatch(/^sa_/);
      expect(sa.status).toBe('active');

      // 2. Generate API key
      const { apiKey, keyId } = await saService.generateApiKey(sa.id);
      expect(apiKey).toMatch(/^sk_saas_/);
      expect(keyId).toMatch(/^key_/);

      // 3. Authenticate with generated key
      const { actor, workspaceId } = await saService.authenticateApiKey(apiKey);
      expect(actor.actorId).toBe(sa.id);
      expect(actor.actorType).toBe('SERVICE');
      expect(actor.authSource).toBe('API_KEY');
      expect(actor.permissions).toEqual(['agent:read', 'agent:execute']);
      expect(actor.roles).toEqual(['service_account']);
      expect(workspaceId).toBe('ws_pro_1');

      // 4. Invalid key is rejected
      await expect(saService.authenticateApiKey('sk_saas_invalid_secret')).rejects.toThrowError(
        /AUTHENTICATION_FAILED/,
      );
    });

    it('builds explicit background SecurityContext without default privileges', async () => {
      const saService = new ServiceAccountService(mockDb as unknown as LobeChatDatabase);

      const actor: ActorContext = {
        actorId: 'sa_worker_1',
        actorType: 'SERVICE',
        authSource: 'API_KEY',
        organizationId: 'org_1',
        permissions: ['agent:execute'],
        roles: ['service_account'],
      };

      const ctx = saService.createBackgroundSecurityContext({
        actor,
        workspaceId: 'ws_pro_1',
      });

      expect(ctx.actor.actorId).toBe('sa_worker_1');
      expect(ctx.workspaceId).toBe('ws_pro_1');
      expect(ctx.runId).toMatch(/^run_bg_/);
      expect(ctx.traceId).toMatch(/^trace_bg_/);
      expect(ctx.requestId).toMatch(/^req_bg_/);
      expect(ctx.systemRole).toBe('user');
    });
  });

  describe('AgentSignalBus Cross-Tenant Isolation', () => {
    it('isolates signals strictly within workspace boundary', async () => {
      const signalBus = new AgentSignalBus();

      const receivedTenant1: any[] = [];
      const receivedTenant2: any[] = [];

      // Subscriber 1 in ws_tenant_1
      signalBus.subscribe('task.progress', 'ws_tenant_1', (sig) => {
        receivedTenant1.push(sig);
      });

      // Subscriber 2 in ws_tenant_2
      signalBus.subscribe('task.progress', 'ws_tenant_2', (sig) => {
        receivedTenant2.push(sig);
      });

      // Emit event targeted to ws_tenant_1
      signalBus.emit({
        actorId: 'usr_1',
        payload: { progress: 50 },
        runId: 'run_123',
        traceId: 'trace_123',
        type: 'task.progress',
        workspaceId: 'ws_tenant_1',
      });

      // Allow microtasks to complete
      await new Promise((r) => setTimeout(r, 10));

      // Assert tenant 1 received the signal, tenant 2 received NOTHING
      expect(receivedTenant1).toHaveLength(1);
      expect(receivedTenant1[0].payload).toEqual({ progress: 50 });
      expect(receivedTenant2).toHaveLength(0);
    });
  });

  describe('BackgroundAgentService', () => {
    it('rejects background agent jobs if tenant plan lacks backgroundAgents entitlement', async () => {
      const mockEntitlements: any = {
        getTenantPlan: vi.fn(async () => ({
          backgroundAgents: false, // Free plan
          id: 'free',
          name: 'Free Plan',
        })),
      };

      const bgService = new BackgroundAgentService(
        mockDb as unknown as LobeChatDatabase,
        undefined,
        mockEntitlements,
      );

      const mockContext: SecurityContext = {
        actor: {
          actorId: 'usr_1',
          actorType: 'USER',
          authSource: 'SESSION',
          permissions: ['agent:execute'],
          roles: ['member'],
        },
        permissions: ['agent:execute'],
        requestId: 'req_1',
        workspaceId: 'ws_free_1',
      };

      await expect(
        bgService.executeBackgroundJob({
          agentId: 'agent_1',
          context: mockContext,
          name: 'Nightly Sync',
          workspaceId: 'ws_free_1',
        }),
      ).rejects.toThrowError(/PLAN_UPGRADE_REQUIRED/);
    });

    it('executes background agent job, emits lifecycle signals, and records usage/audit', async () => {
      const signalBus = new AgentSignalBus();
      const emittedSignals: any[] = [];

      signalBus.subscribe('workflow.started', 'ws_pro_1', (sig) => emittedSignals.push(sig));
      signalBus.subscribe('workflow.completed', 'ws_pro_1', (sig) => emittedSignals.push(sig));

      const mockEntitlements: any = {
        checkModelAccess: vi.fn(async () => ({ allowed: true })),
        checkTokenQuota: vi.fn(async () => ({ allowed: true })),
        getTenantPlan: vi.fn(async () => ({
          backgroundAgents: true, // Pro plan
          id: 'pro',
          name: 'Pro Plan',
        })),
      };

      const mockAgentService: any = {
        prepareAgentRun: vi.fn(async () => ({
          runId: 'run_bg_verified_123',
          startedAt: new Date(),
          status: 'dispatched',
        })),
      };

      const mockUsageLedger: any = {
        recordUsageEvent: vi.fn(async (event: any) => {
          usageEventsStore.push(event);
        }),
      };

      const mockAuditService: any = {
        recordAuditEvent: vi.fn(async (ev: any) => {
          auditLogsStore.push(ev);
        }),
      };

      const bgService = new BackgroundAgentService(
        mockDb as unknown as LobeChatDatabase,
        mockAgentService,
        mockEntitlements,
        mockUsageLedger,
        mockAuditService,
        signalBus,
      );

      const mockContext: SecurityContext = {
        actor: {
          actorId: 'sa_worker_1',
          actorType: 'SERVICE',
          authSource: 'API_KEY',
          permissions: ['agent:execute'],
          roles: ['service_account'],
        },
        permissions: ['agent:execute'],
        requestId: 'req_bg_exec',
        traceId: 'trace_bg_exec',
        workspaceId: 'ws_pro_1',
      };

      const result = await bgService.executeBackgroundJob({
        agentId: 'agent_bg_1',
        context: mockContext,
        name: 'Document Analysis Worker',
        workspaceId: 'ws_pro_1',
      });

      expect(result.status).toBe('completed');
      expect(result.totalTokensUsed).toBe(1200);

      // Verify usage and audit were recorded
      expect(usageEventsStore).toHaveLength(1);
      expect(usageEventsStore[0].runId).toBe('run_bg_verified_123');
      expect(auditLogsStore).toHaveLength(1);
      expect(auditLogsStore[0].action).toBe('agent.background.run');

      // Wait for async signal handlers
      await new Promise((r) => setTimeout(r, 10));
      expect(emittedSignals).toHaveLength(2);
      expect(emittedSignals.map((s) => s.type)).toEqual(['workflow.started', 'workflow.completed']);
    });
  });
});
