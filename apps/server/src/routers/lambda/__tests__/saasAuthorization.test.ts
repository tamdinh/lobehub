// @vitest-environment node
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthorizationService } from '@/business/server/auth/AuthorizationService';
import {
  wsAdminProcedure,
  wsMemberProcedure,
  wsOwnerProcedure,
  wsProcedure,
} from '@/business/server/trpc-middlewares/workspaceAuth';
import { withRbacPermission } from '@/business/server/trpc-middlewares/rbacPermission';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure, router } from '@/libs/trpc/lambda';

const testRouter = router({
  adminOnly: wsAdminProcedure.query(({ ctx }) => ({ role: (ctx as any).workspaceRole })),
  memberOnly: wsProcedure.query(({ ctx }) => ({ role: (ctx as any).workspaceRole })),
  ownerOnly: wsOwnerProcedure.query(({ ctx }) => ({ role: (ctx as any).workspaceRole })),
  scopedMember: wsMemberProcedure.query(({ ctx }) => ({ role: (ctx as any).workspaceRole })),
  withPerm: authedProcedure
    .use(withRbacPermission('agent:execute'))
    .query(() => ({ ok: true })),
});

describe('SaaS AuthorizationService & Middlewares', () => {
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      query: {
        users: {
          findFirst: vi.fn(),
        },
        workspaces: {
          findFirst: vi.fn(),
        },
        workspaceMembers: {
          findFirst: vi.fn(),
          findMany: vi.fn(),
        },
      },
      select: vi.fn(),
    };
  });

  describe('AuthorizationService.authorize', () => {
    it('rejects when user does not exist', async () => {
      const authService = new AuthorizationService(mockDb as unknown as LobeChatDatabase);
      mockDb.query.users.findFirst.mockResolvedValue(null);

      await expect(
        authService.authorize({
          actor: { actorId: 'user-unknown', actorType: 'USER', authSource: 'BETTER_AUTH' },
          requestId: 'req-1',
        }),
      ).rejects.toThrow('USER_NOT_FOUND');
    });

    it('rejects when user is banned', async () => {
      const authService = new AuthorizationService(mockDb as unknown as LobeChatDatabase);
      mockDb.query.users.findFirst.mockResolvedValue({
        id: 'user-banned',
        banned: true,
        banReason: 'Fraudulent activity',
      });

      await expect(
        authService.authorize({
          actor: { actorId: 'user-banned', actorType: 'USER', authSource: 'BETTER_AUTH' },
          requestId: 'req-2',
        }),
      ).rejects.toThrow('ACCOUNT_BANNED');
    });

    it('rejects non-member from accessing workspace', async () => {
      const authService = new AuthorizationService(mockDb as unknown as LobeChatDatabase);
      mockDb.query.users.findFirst.mockResolvedValue({ id: 'user-1', banned: false });
      mockDb.query.workspaces.findFirst.mockResolvedValue({ id: 'ws-1', frozen: false });

      // Mock getActiveWorkspaceMembershipRole returning null
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });

      await expect(
        authService.authorize({
          actor: { actorId: 'user-1', actorType: 'USER', authSource: 'BETTER_AUTH' },
          requestId: 'req-3',
          workspaceId: 'ws-1',
        }),
      ).rejects.toThrow('WORKSPACE_ACCESS_DENIED');
    });

    it('rejects state mutation when workspace is frozen', async () => {
      const authService = new AuthorizationService(mockDb as unknown as LobeChatDatabase);
      mockDb.query.users.findFirst.mockResolvedValue({ id: 'user-1', banned: false });
      mockDb.query.workspaces.findFirst.mockResolvedValue({
        id: 'ws-frozen',
        frozen: true,
        frozenReason: 'Unpaid invoice',
      });

      await expect(
        authService.authorize({
          actor: { actorId: 'user-1', actorType: 'USER', authSource: 'BETTER_AUTH' },
          options: { requiredRole: 'member' },
          requestId: 'req-4',
          workspaceId: 'ws-frozen',
        }),
      ).rejects.toThrow('WORKSPACE_FROZEN');
    });

    it('rejects member with insufficient role rank', async () => {
      const authService = new AuthorizationService(mockDb as unknown as LobeChatDatabase);
      mockDb.query.users.findFirst.mockResolvedValue({ id: 'user-1', banned: false });
      mockDb.query.workspaces.findFirst.mockResolvedValue({ id: 'ws-1', frozen: false });

      // Member holds role 'viewer'
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ role: 'viewer', primaryOwnerId: 'other-user' }]),
            }),
          }),
        }),
      });

      // Requires 'admin'
      await expect(
        authService.authorize({
          actor: { actorId: 'user-1', actorType: 'USER', authSource: 'BETTER_AUTH' },
          options: { requiredRole: 'admin' },
          requestId: 'req-5',
          workspaceId: 'ws-1',
        }),
      ).rejects.toThrow('INSUFFICIENT_WORKSPACE_PERMISSIONS');
    });
  });

  describe('workspaceAuth & rbacPermission procedures', () => {
    it('wsProcedure throws when workspaceId is missing', async () => {
      const caller = testRouter.createCaller({
        serverDB: mockDb,
        userId: 'user-1',
        workspaceId: undefined,
      } as any);

      await expect(caller.memberOnly()).rejects.toThrow('workspaceId is required');
    });

    it('wsProcedure throws when caller is not an active workspace member', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });

      const caller = testRouter.createCaller({
        serverDB: mockDb,
        userId: 'user-attacker',
        workspaceId: 'ws-victim',
      } as any);

      await expect(caller.memberOnly()).rejects.toThrow('WORKSPACE_ACCESS_DENIED');
    });

    it('wsProcedure succeeds when caller is an active workspace member', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ role: 'member', primaryOwnerId: 'owner-1' }]),
            }),
          }),
        }),
      });

      const caller = testRouter.createCaller({
        serverDB: mockDb,
        userId: 'user-1',
        workspaceId: 'ws-1',
      } as any);

      const result = await caller.memberOnly();
      expect(result).toEqual({ role: 'member' });
    });

    it('wsAdminProcedure blocks regular member', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ role: 'member', primaryOwnerId: 'owner-1' }]),
            }),
          }),
        }),
      });

      const caller = testRouter.createCaller({
        serverDB: mockDb,
        userId: 'user-1',
        workspaceId: 'ws-1',
      } as any);

      await expect(caller.adminOnly()).rejects.toThrow('INSUFFICIENT_WORKSPACE_ROLE');
    });

    it('wsAdminProcedure permits admin', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ role: 'admin', primaryOwnerId: 'owner-1' }]),
            }),
          }),
        }),
      });

      const caller = testRouter.createCaller({
        serverDB: mockDb,
        userId: 'admin-1',
        workspaceId: 'ws-1',
      } as any);

      const result = await caller.adminOnly();
      expect(result).toEqual({ role: 'admin' });
    });

    it('wsOwnerProcedure blocks admin and permits only unique owner', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ role: 'admin', primaryOwnerId: 'owner-1' }]),
            }),
          }),
        }),
      });

      const caller = testRouter.createCaller({
        serverDB: mockDb,
        userId: 'admin-1',
        workspaceId: 'ws-1',
      } as any);

      await expect(caller.ownerOnly()).rejects.toThrow('INSUFFICIENT_WORKSPACE_ROLE');
    });

    it('wsMemberProcedure passes when no workspaceId is supplied', async () => {
      const caller = testRouter.createCaller({
        serverDB: mockDb,
        userId: 'user-1',
        workspaceId: undefined,
      } as any);

      const result = await caller.scopedMember();
      expect(result).toEqual({ role: undefined });
    });
  });
});
