// @vitest-environment node
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthorizationService } from '@/business/server/auth/AuthorizationService';
import {
  wsAdminProcedure,
  wsProcedure,
} from '@/business/server/trpc-middlewares/workspaceAuth';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { AgentModel } from '@/database/models/agent';

describe('Mission 1: Cross-Tenant Isolation & BOLA/IDOR Defense', () => {
  // Mock In-Memory Database State for 2 Tenants: Org/Workspace A and Org/Workspace B
  const mockTenantData = {
    workspaces: [
      { id: 'ws-tenant-a', slug: 'tenant-a', name: 'Tenant A', primaryOwnerId: 'user-a', frozen: false },
      { id: 'ws-tenant-b', slug: 'tenant-b', name: 'Tenant B', primaryOwnerId: 'user-b', frozen: false },
    ],
    workspaceMembers: [
      { workspaceId: 'ws-tenant-a', userId: 'user-a', role: 'owner' },
      { workspaceId: 'ws-tenant-b', userId: 'user-b', role: 'owner' },
    ],
    users: [
      { id: 'user-a', email: 'user-a@tenant-a.com', banned: false },
      { id: 'user-b', email: 'user-b@tenant-b.com', banned: false },
    ],
    agents: [
      { id: 'agent-a', title: 'Agent A', workspaceId: 'ws-tenant-a', userId: 'user-a' },
      { id: 'agent-b', title: 'Agent B', workspaceId: 'ws-tenant-b', userId: 'user-b' },
    ],
  };

  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      query: {
        users: {
          findFirst: vi.fn(async ({ where }: any) => {
            // Find by user id
            return mockTenantData.users.find((u) => u.id === 'user-a' || u.id === 'user-b');
          }),
        },
        workspaces: {
          findFirst: vi.fn(async () => mockTenantData.workspaces[0]),
        },
        workspaceMembers: {
          findFirst: vi.fn(),
          findMany: vi.fn(),
        },
        agents: {
          findFirst: vi.fn(),
          findMany: vi.fn(),
        },
      },
      select: vi.fn(({ role }: any = {}) => ({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() => ({
              limit: vi.fn().mockImplementation(async () => {
                // Return membership based on query parameters
                return [];
              }),
            })),
          }),
        }),
      })),
    };
  });

  // Simulated tRPC Router representing tenant-isolated operations
  const tenantRouter = router({
    getWorkspaceDetail: wsProcedure.query(({ ctx }) => {
      return { workspaceId: ctx.workspaceId };
    }),

    updateWorkspaceSettings: wsAdminProcedure.mutation(({ ctx }) => {
      return { updated: true, workspaceId: ctx.workspaceId };
    }),

    getAgent: wsProcedure.input((val: any) => val).query(async ({ ctx, input }) => {
      // Must use composite tenant scoping: (agentId, workspaceId)
      const agent = mockTenantData.agents.find(
        (a) => a.id === input.agentId && a.workspaceId === ctx.workspaceId,
      );
      if (!agent) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found in workspace' });
      }
      return agent;
    }),

    executeAgent: wsProcedure.input((val: any) => val).mutation(async ({ ctx, input }) => {
      // Must enforce agent belongs to caller's workspace
      const agent = mockTenantData.agents.find(
        (a) => a.id === input.agentId && a.workspaceId === ctx.workspaceId,
      );
      if (!agent) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'AGENT_ACCESS_DENIED' });
      }
      return { runId: `run-${Date.now()}`, status: 'dispatched' };
    }),
  });

  it('allows User A to access Workspace A resources', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ role: 'owner', primaryOwnerId: 'user-a' }]),
          }),
        }),
      }),
    });

    const callerA = tenantRouter.createCaller({
      serverDB: mockDb,
      userId: 'user-a',
      workspaceId: 'ws-tenant-a',
    } as any);

    const ws = await callerA.getWorkspaceDetail();
    expect(ws.workspaceId).toBe('ws-tenant-a');

    const agent = await callerA.getAgent({ agentId: 'agent-a' });
    expect(agent.id).toBe('agent-a');

    const run = await callerA.executeAgent({ agentId: 'agent-a' });
    expect(run.status).toBe('dispatched');
  });

  it('BLOCKED: User A cannot access Workspace B via substituted header (IDOR/BOLA)', async () => {
    // User A attempts to claim workspaceId = 'ws-tenant-b' in header
    // The membership query returns empty because User A is NOT in Workspace B
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    });

    const maliciousCaller = tenantRouter.createCaller({
      serverDB: mockDb,
      userId: 'user-a',
      workspaceId: 'ws-tenant-b', // FORGED HEADER
    } as any);

    await expect(maliciousCaller.getWorkspaceDetail()).rejects.toThrow('WORKSPACE_ACCESS_DENIED');
    await expect(maliciousCaller.updateWorkspaceSettings()).rejects.toThrow('WORKSPACE_ACCESS_DENIED');
    await expect(maliciousCaller.getAgent({ agentId: 'agent-b' })).rejects.toThrow('WORKSPACE_ACCESS_DENIED');
    await expect(maliciousCaller.executeAgent({ agentId: 'agent-b' })).rejects.toThrow('WORKSPACE_ACCESS_DENIED');
  });

  it('BLOCKED: User A cannot read or execute Agent B even from within Workspace A (Cross-Tenant Resource Poisoning)', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ role: 'owner', primaryOwnerId: 'user-a' }]),
          }),
        }),
      }),
    });

    const callerA = tenantRouter.createCaller({
      serverDB: mockDb,
      userId: 'user-a',
      workspaceId: 'ws-tenant-a',
    } as any);

    // Caller A sends Agent B's ID
    await expect(callerA.getAgent({ agentId: 'agent-b' })).rejects.toThrow('Agent not found in workspace');
    await expect(callerA.executeAgent({ agentId: 'agent-b' })).rejects.toThrow('AGENT_ACCESS_DENIED');
  });

  it('BLOCKED: Non-member cannot mutate membership or settings', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    });

    const unauthedCaller = tenantRouter.createCaller({
      serverDB: mockDb,
      userId: 'user-attacker',
      workspaceId: 'ws-tenant-a',
    } as any);

    await expect(unauthedCaller.updateWorkspaceSettings()).rejects.toThrow('WORKSPACE_ACCESS_DENIED');
  });
});
