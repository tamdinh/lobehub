import { getServerDB, type LobeChatDatabase } from '@lobechat/database';
import { getActiveWorkspaceMembershipRole } from '@lobechat/database/models/workspace';
import { TRPCError } from '@trpc/server';

import { authedProcedure } from '@/libs/trpc/lambda';
import { trpc } from '@/libs/trpc/lambda/init';

export type WorkspaceRole = 'admin' | 'member' | 'owner' | 'viewer';

const roleRanks: Record<WorkspaceRole, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

export const cloudWorkspaceAuth = trpc.middleware(async ({ ctx, next }) => {
  let workspaceSlug: string | undefined = undefined;

  if (ctx.workspaceId) {
    try {
      const db: LobeChatDatabase = (ctx as any).serverDB || (await getServerDB());
      const ws = await db.query.workspaces.findFirst({
        columns: { slug: true },
        where: (t: any, { eq }: any) => eq(t.id, ctx.workspaceId!),
      });
      if (ws) {
        workspaceSlug = ws.slug;
      }
    } catch {
      // In tests or offline modes without database, fallback gracefully
      workspaceSlug = undefined;
    }
  }

  return next({
    ctx: {
      workspaceSlug,
    },
  });
});

export const lobeWorkspaceAuth = trpc.middleware(async (opts) => opts.next());

export const requireWorkspaceRole = (minRole: WorkspaceRole) =>
  trpc.middleware(async ({ ctx, next }) => {
    if (!ctx.workspaceId) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'workspaceId is required' });
    }
    if (!ctx.userId) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
    }

    const db: LobeChatDatabase = (ctx as any).serverDB || (await getServerDB());
    const role = (await getActiveWorkspaceMembershipRole(db, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    })) as WorkspaceRole | null;

    if (!role) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'WORKSPACE_ACCESS_DENIED',
      });
    }

    const currentRank = roleRanks[role] || 0;
    const requiredRank = roleRanks[minRole] || 0;

    if (currentRank < requiredRank) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `INSUFFICIENT_WORKSPACE_ROLE: requires ${minRole}, holds ${role}`,
      });
    }

    return next({
      ctx: {
        workspaceId: ctx.workspaceId,
        workspaceRole: role,
      },
    });
  });

export const requireWorkspaceRoleWhenScoped = (minRole: WorkspaceRole) =>
  trpc.middleware(async ({ ctx, next }) => {
    if (!ctx.workspaceId) {
      return next();
    }
    if (!ctx.userId) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
    }

    const db: LobeChatDatabase = (ctx as any).serverDB || (await getServerDB());
    const role = (await getActiveWorkspaceMembershipRole(db, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    })) as WorkspaceRole | null;

    if (!role) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'WORKSPACE_ACCESS_DENIED',
      });
    }

    const currentRank = roleRanks[role] || 0;
    const requiredRank = roleRanks[minRole] || 0;

    if (currentRank < requiredRank) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `INSUFFICIENT_WORKSPACE_ROLE: requires ${minRole}, holds ${role}`,
      });
    }

    return next({
      ctx: {
        workspaceRole: role,
      },
    });
  });

const requireWorkspaceId = trpc.middleware(async ({ ctx, next }) => {
  if (!ctx.workspaceId) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'workspaceId is required' });
  }
  return next({ ctx: { workspaceId: ctx.workspaceId } });
});

export const wsProcedure = authedProcedure.use(requireWorkspaceRole('member'));

export const wsMemberProcedure = authedProcedure.use(requireWorkspaceRoleWhenScoped('member'));

export const wsOwnerProcedure = authedProcedure.use(requireWorkspaceRole('owner'));

export const wsAdminProcedure = authedProcedure.use(requireWorkspaceRole('admin'));

export const wsCompatProcedure = authedProcedure.use(cloudWorkspaceAuth);
