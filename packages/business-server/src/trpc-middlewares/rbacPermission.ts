import { getServerDB, type LobeChatDatabase } from '@lobechat/database';
import { RbacModel } from '@lobechat/database/models/rbac';
import { TRPCError } from '@trpc/server';

import { trpc } from '@/libs/trpc/lambda/init';

/**
 * Authoritative RBAC permission middleware for SaaS platform.
 * Verifies that the caller holds the exact permission code in the workspace or globally.
 */
export const withRbacPermission = (code: string) =>
  trpc.middleware(async ({ ctx, next }) => {
    if (!ctx.userId) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
    }

    const db: LobeChatDatabase = (ctx as any).serverDB || (await getServerDB());
    const rbac = new RbacModel(db, ctx.userId);
    const hasPerm = await rbac.hasPermission(code, {
      workspaceId: ctx.workspaceId ?? undefined,
    });

    if (!hasPerm) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `PERMISSION_DENIED: ${code}`,
      });
    }

    return next();
  });

/**
 * Checks whether the caller holds any of the provided permission codes (OR logic).
 */
export const withAnyRbacPermission = (codes: string[]) =>
  trpc.middleware(async ({ ctx, next }) => {
    if (!ctx.userId) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
    }

    const db: LobeChatDatabase = (ctx as any).serverDB || (await getServerDB());
    const rbac = new RbacModel(db, ctx.userId);
    const hasPerm = await rbac.hasAnyPermission(codes, {
      workspaceId: ctx.workspaceId ?? undefined,
    });

    if (!hasPerm) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `PERMISSION_DENIED: required one of [${codes.join(', ')}]`,
      });
    }

    return next();
  });

/**
 * Checks whether the caller holds all of the provided permission codes (AND logic).
 */
export const withAllRbacPermissions = (codes: string[]) =>
  trpc.middleware(async ({ ctx, next }) => {
    if (!ctx.userId) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
    }

    const db: LobeChatDatabase = (ctx as any).serverDB || (await getServerDB());
    const rbac = new RbacModel(db, ctx.userId);

    for (const code of codes) {
      const hasPerm = await rbac.hasPermission(code, {
        workspaceId: ctx.workspaceId ?? undefined,
      });

      if (!hasPerm) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `PERMISSION_DENIED: missing ${code}`,
        });
      }
    }

    return next();
  });

/**
 * Sugar for the "member-or-owner" gate: fans the action code out into
 * the `:all | :owner` scope pair so a member with the `:owner` grant
 * passes alongside an owner/admin with the `:all` grant.
 */
export const withScopedPermission = (action: string) =>
  trpc.middleware(async ({ ctx, next }) => {
    if (!ctx.userId) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
    }

    const db: LobeChatDatabase = (ctx as any).serverDB || (await getServerDB());
    const rbac = new RbacModel(db, ctx.userId);
    const candidates = [action, `${action}:all`, `${action}:owner`];
    const hasPerm = await rbac.hasAnyPermission(candidates, {
      workspaceId: ctx.workspaceId ?? undefined,
    });

    if (!hasPerm) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `PERMISSION_DENIED: requires permission for ${action}`,
      });
    }

    return next();
  });
