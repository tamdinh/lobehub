// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentService } from '@/business/server/agent-run/AgentService';
import type { LobeChatDatabase } from '@/database/type';
import type { SecurityContext } from '@lobechat/types';

describe('SaaS AgentService Execution Boundary', () => {
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      query: {
        agents: {
          findFirst: vi.fn(),
        },
        users: {
          findFirst: vi.fn(),
        },
        workspaces: {
          findFirst: vi.fn(),
        },
      },
    };
  });

  it('allocates runId and correlates trace/request context on authorized run', async () => {
    const agentService = new AgentService(mockDb as unknown as LobeChatDatabase);
    vi.spyOn((agentService as any).authService, 'hasEffectivePermission').mockResolvedValue(true);

    // Agent belongs to Workspace A
    mockDb.query.agents.findFirst.mockResolvedValue({
      id: 'agent-123',
      workspaceId: 'ws-a',
      userId: 'user-a',
    });

    const context: SecurityContext = {
      actor: { actorId: 'user-a', actorType: 'USER', authSource: 'BETTER_AUTH' },
      organizationId: 'org-a',
      permissions: ['agent:execute:all'],
      requestId: 'req-abc-999',
      traceId: 'trace-def-111',
      workspaceId: 'ws-a',
      workspaceRole: 'member',
    };

    const run = await agentService.prepareAgentRun({
      agentId: 'agent-123',
      context,
      sessionId: 'sess-1',
    });

    expect(run.runId).toMatch(/^run_/);
    expect(run.actorId).toBe('user-a');
    expect(run.agentId).toBe('agent-123');
    expect(run.workspaceId).toBe('ws-a');
    expect(run.organizationId).toBe('org-a');
    expect(run.requestId).toBe('req-abc-999');
    expect(run.traceId).toBe('trace-def-111');
    expect(run.status).toBe('dispatched');
  });

  it('BLOCKED: rejects when caller is a viewer without execution rights', async () => {
    const agentService = new AgentService(mockDb as unknown as LobeChatDatabase);
    vi.spyOn((agentService as any).authService, 'hasEffectivePermission').mockResolvedValue(false);

    const context: SecurityContext = {
      actor: { actorId: 'viewer-user', actorType: 'USER', authSource: 'BETTER_AUTH' },
      requestId: 'req-2',
      workspaceId: 'ws-a',
      workspaceRole: 'viewer',
    };

    await expect(
      agentService.prepareAgentRun({
        agentId: 'agent-123',
        context,
      }),
    ).rejects.toThrow('Viewer cannot execute agents');
  });

  it('BLOCKED: rejects when agent belongs to another workspace (Cross-Tenant Execution Poisoning)', async () => {
    const agentService = new AgentService(mockDb as unknown as LobeChatDatabase);
    vi.spyOn((agentService as any).authService, 'hasEffectivePermission').mockResolvedValue(true);

    // Agent lookup returns null because agent belongs to another workspace
    mockDb.query.agents.findFirst.mockResolvedValue(null);

    const context: SecurityContext = {
      actor: { actorId: 'user-a', actorType: 'USER', authSource: 'BETTER_AUTH' },
      requestId: 'req-3',
      workspaceId: 'ws-a',
      workspaceRole: 'member',
    };

    await expect(
      agentService.prepareAgentRun({
        agentId: 'agent-foreign-b',
        context,
      }),
    ).rejects.toThrow('AGENT_ACCESS_DENIED');
  });
});
