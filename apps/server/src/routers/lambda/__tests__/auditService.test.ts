// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '@/business/server/audit/AuditService';
import type { LobeChatDatabase } from '@/database/type';
import type { ActorContext } from '@lobechat/types';

describe('SaaS Correlated Audit Service', () => {
  let mockDb: any;
  let auditLogsStore: any[];

  beforeEach(() => {
    auditLogsStore = [];
    mockDb = {
      insert: vi.fn(() => ({
        values: vi.fn((val: any) => ({
          returning: vi.fn(async () => {
            const row = {
              id: `audit-${auditLogsStore.length + 1}`,
              createdAt: new Date(),
              ...val,
            };
            auditLogsStore.push(row);
            return [row];
          }),
        })),
      })),
      query: {
        workspaceAuditLogs: {
          findMany: vi.fn(async (queryOptions?: any) => {
            return auditLogsStore.filter((log) => {
              if (queryOptions?.where) {
                // Return matching logs in mock
                return true;
              }
              return true;
            });
          }),
        },
      },
    };
  });

  const mockActor: ActorContext = {
    actorId: 'usr_sec_admin',
    actorType: 'USER',
    authSource: 'SESSION',
    organizationId: 'org_enterprise',
    roles: ['admin'],
    permissions: ['workspace:audit:read', 'workspace:audit:write'],
  };

  it('records an immutable audit event correlated with requestId, traceId, and runId', async () => {
    const service = new AuditService(mockDb as unknown as LobeChatDatabase);

    const event = await service.recordAuditEvent({
      action: 'agent.create',
      actor: mockActor,
      ipAddress: '192.168.1.100',
      organizationId: 'org_enterprise',
      requestId: 'req_xyz_123',
      resourceId: 'agent_abc',
      resourceType: 'agent',
      result: 'SUCCESS',
      runId: 'run_trace_456',
      traceId: 'trace_789',
      workspaceId: 'ws_tenant_1',
      metadata: {
        agentModel: 'claude-3-5-sonnet',
      },
    });

    expect(event).toBeDefined();
    expect(auditLogsStore).toHaveLength(1);
    const recorded = auditLogsStore[0];
    expect(recorded.action).toBe('agent.create');
    expect(recorded.userId).toBe('usr_sec_admin');
    expect(recorded.workspaceId).toBe('ws_tenant_1');
    expect(recorded.resourceId).toBe('agent_abc');
    expect(recorded.resourceType).toBe('agent');
    expect(recorded.ipAddress).toBe('192.168.1.100');
    expect(recorded.metadata).toEqual({
      actorType: 'USER',
      authSource: 'SESSION',
      organizationId: 'org_enterprise',
      requestId: 'req_xyz_123',
      result: 'SUCCESS',
      runId: 'run_trace_456',
      traceId: 'trace_789',
      agentModel: 'claude-3-5-sonnet',
    });
  });

  it('records security denial events with actor context', async () => {
    const service = new AuditService(mockDb as unknown as LobeChatDatabase);

    const denialActor: ActorContext = {
      actorId: 'usr_attacker',
      actorType: 'USER',
      authSource: 'API_KEY',
      organizationId: 'org_other',
      roles: ['member'],
      permissions: [],
    };

    const event = await service.recordAuditEvent({
      action: 'workspace.settings.update',
      actor: denialActor,
      requestId: 'req_denied_999',
      result: 'DENIED',
      workspaceId: 'ws_tenant_1',
      metadata: {
        denialReason: 'INSUFFICIENT_PERMISSIONS',
      },
    });

    const meta = event.metadata as Record<string, any>;
    expect(meta.result).toBe('DENIED');
    expect(meta.denialReason).toBe('INSUFFICIENT_PERMISSIONS');
    expect(event.userId).toBe('usr_attacker');
  });

  it('queries audit logs with workspace scoping', async () => {
    const service = new AuditService(mockDb as unknown as LobeChatDatabase);

    await service.listAuditLogs({
      workspaceId: 'ws_tenant_1',
      action: 'agent.create',
      limit: 20,
    });

    expect(mockDb.query.workspaceAuditLogs.findMany).toHaveBeenCalled();
    const callArgs = mockDb.query.workspaceAuditLogs.findMany.mock.calls[0][0];
    expect(callArgs.limit).toBe(20);
    expect(callArgs.where).toBeDefined();
  });
});
