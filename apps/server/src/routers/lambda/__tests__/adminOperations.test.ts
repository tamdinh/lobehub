// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_TOOLS, AdminService } from '@/business/server/admin/AdminService';
import { ModelCatalogService } from '@/business/server/catalog/ModelCatalogService';
import type { LobeChatDatabase } from '@/database/type';
import type { ActorContext } from '@lobechat/types';

describe('SaaS Typed Administration Operations (Mission 3)', () => {
  let mockDb: any;
  let auditLogsStore: any[];
  let usageEventsStore: any[];
  let catalog: ModelCatalogService;

  beforeEach(() => {
    auditLogsStore = [];
    usageEventsStore = [
      {
        actorId: 'usr-1',
        costMicros: 25_000,
        eventType: 'USAGE',
        id: 'ev-usage-100',
        model: 'gpt-4o',
        provider: 'openai',
        totalTokens: 2500,
        workspaceId: 'ws-tenant-1',
      },
    ];
    catalog = new ModelCatalogService();

    mockDb = {
      insert: vi.fn(() => ({
        values: vi.fn((val: any) => {
          const row = { id: `ev-${usageEventsStore.length + 1}`, createdAt: new Date(), ...val };
          usageEventsStore.push(row);
          return Object.assign(Promise.resolve([row]), {
            returning: vi.fn(async () => [row]),
          });
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(async () => []),
        })),
      })),
      query: {
        saasUsageEvents: {
          findMany: vi.fn(async (options?: any) => {
            return usageEventsStore;
          }),
        },
        users: {
          findMany: vi.fn(async () => [
            { id: 'usr-target', email: 'target@example.com', name: 'Target User' },
          ]),
        },
        workspaceAuditLogs: {
          findMany: vi.fn(async () => auditLogsStore),
        },
      },
    };
  });

  const adminActor: ActorContext = {
    actorId: 'usr-platform-admin',
    actorType: 'ADMIN',
    authSource: 'SESSION',
    organizationId: 'org-platform',
    permissions: ['*'],
    roles: ['admin'],
  };

  const regularActor: ActorContext = {
    actorId: 'usr-unprivileged',
    actorType: 'USER',
    authSource: 'SESSION',
    organizationId: 'org-tenant-1',
    permissions: ['agent:read'],
    roles: ['member'],
  };

  it('verifies typed admin tools metadata', () => {
    expect(ADMIN_TOOLS['admin.workspace.freeze'].riskLevel).toBe('CRITICAL');
    expect(ADMIN_TOOLS['admin.workspace.freeze'].approvalRequired).toBe(true);
    expect(ADMIN_TOOLS['admin.billing.refund'].riskLevel).toBe('HIGH');
    expect(ADMIN_TOOLS['admin.billing.refund'].idempotent).toBe(true);
    expect(ADMIN_TOOLS['admin.users.search'].riskLevel).toBe('LOW');
  });

  it('rejects unprivileged actors with ADMIN_PERMISSION_DENIED and logs denial audit', async () => {
    const mockAuditService: any = {
      recordAuditEvent: vi.fn(async (ev: any) => {
        auditLogsStore.push(ev);
      }),
    };

    const adminService = new AdminService(
      mockDb as unknown as LobeChatDatabase,
      mockAuditService,
      undefined,
      catalog,
    );

    // Regular actor attempting user suspension
    await expect(
      adminService.suspendUser({ reason: 'Malicious activity', userId: 'usr-bad' }, regularActor),
    ).rejects.toThrowError(/ADMIN_PERMISSION_DENIED/);

    expect(mockAuditService.recordAuditEvent).toHaveBeenCalled();
    const denialLog = auditLogsStore.find((l) => l.result === 'DENIED');
    expect(denialLog).toBeDefined();
    expect(denialLog.action).toBe('admin.user.suspend');
  });

  it('suspends users and freezes workspaces with correlated audit records', async () => {
    const mockAuditService: any = {
      recordAuditEvent: vi.fn(async (ev: any) => {
        auditLogsStore.push(ev);
      }),
    };

    const adminService = new AdminService(
      mockDb as unknown as LobeChatDatabase,
      mockAuditService,
      undefined,
      catalog,
    );

    // 1. Suspend User
    const suspendResult = await adminService.suspendUser(
      { reason: 'TOS violation', userId: 'usr-target' },
      adminActor,
    );
    expect(suspendResult.status).toBe('suspended');

    // 2. Freeze Workspace
    const freezeResult = await adminService.freezeWorkspace(
      { reason: 'Billing delinquency lock', workspaceId: 'ws-tenant-1' },
      adminActor,
    );
    expect(freezeResult.isFrozen).toBe(true);

    // 3. Unfreeze Workspace
    const unfreezeResult = await adminService.unfreezeWorkspace(
      { reason: 'Payment received', workspaceId: 'ws-tenant-1' },
      adminActor,
    );
    expect(unfreezeResult.isFrozen).toBe(false);

    expect(auditLogsStore.some((l) => l.action === 'admin.user.suspend')).toBe(true);
    expect(auditLogsStore.some((l) => l.action === 'admin.workspace.freeze')).toBe(true);
    expect(auditLogsStore.some((l) => l.action === 'admin.workspace.unfreeze')).toBe(true);
  });

  it('disables commercial model in catalog and records audit log', async () => {
    const mockAuditService: any = {
      recordAuditEvent: vi.fn(async (ev: any) => {
        auditLogsStore.push(ev);
      }),
    };

    const adminService = new AdminService(
      mockDb as unknown as LobeChatDatabase,
      mockAuditService,
      undefined,
      catalog,
    );

    expect(catalog.getModel('gpt-4o')?.enabled).toBe(true);

    await adminService.disableModel(
      { modelId: 'gpt-4o', reason: 'Provider incident upstream' },
      adminActor,
    );

    expect(catalog.getModel('gpt-4o')?.enabled).toBe(false);
    expect(auditLogsStore.some((l) => l.action === 'admin.model.disable')).toBe(true);
  });

  it('processes refund idempotently without duplicate reversals', async () => {
    const mockAuditService: any = {
      recordAuditEvent: vi.fn(async (ev: any) => {
        auditLogsStore.push(ev);
      }),
    };

    const mockUsageLedger: any = {
      grantCredits: vi.fn(async (params: any) => ({
        id: 'credit-refund-1',
        ...params,
      })),
      recordReversal: vi.fn(async (params: any) => ({
        id: 'rev-1',
        ...params,
      })),
    };

    const adminService = new AdminService(
      mockDb as unknown as LobeChatDatabase,
      mockAuditService,
      mockUsageLedger,
      catalog,
    );

    const idempotencyKey = 'idem_refund_unique_123';

    // First call
    const res1 = await adminService.refundUsage(
      {
        idempotencyKey,
        reason: 'Customer reported partial stream dropout',
        usageEventId: 'ev-usage-100',
      },
      adminActor,
    );

    expect(res1.status).toBe('refunded');
    expect(res1.refundedAmountMicros).toBe(25_000);
    expect(mockUsageLedger.recordReversal).toHaveBeenCalledTimes(1);
    expect(mockUsageLedger.grantCredits).toHaveBeenCalledTimes(1);

    // Second call with identical idempotencyKey
    const res2 = await adminService.refundUsage(
      {
        idempotencyKey,
        reason: 'Customer reported partial stream dropout',
        usageEventId: 'ev-usage-100',
      },
      adminActor,
    );

    expect(res2).toEqual(res1);
    // Crucial: recordReversal and grantCredits are NOT called again
    expect(mockUsageLedger.recordReversal).toHaveBeenCalledTimes(1);
    expect(mockUsageLedger.grantCredits).toHaveBeenCalledTimes(1);
  });
});
