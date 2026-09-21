import {
  PERMISSION_ACTIONS,
  WORKSPACE_ROLE_PERMISSIONS,
  WORKSPACE_SYSTEM_ROLES,
} from '@lobechat/const/rbac';
import { getServerDB } from '@lobechat/database';
import {
  getActiveWorkspaceMembershipRole,
  hasActiveWorkspaceMembership,
  hasWorkspaceAdminAccess,
  hasWorkspaceOwnerAccess,
  WorkspaceModel,
} from '@lobechat/database/models/workspace';
import { RbacModel } from '@lobechat/database/models/rbac';
import { UserModel } from '@lobechat/database/models/user';
import type { LobeChatDatabase } from '@lobechat/database';
import type { ActorContext, ActorType, SecurityContext, WorkspaceRole } from '@lobechat/types';
import { TRPCError } from '@trpc/server';

export interface AuthorizeOptions {
  requiredPermission?: string;
  requiredRole?: WorkspaceRole;
  requireActiveWorkspace?: boolean;
}

export class AuthorizationService {
  private db: LobeChatDatabase;

  constructor(db: LobeChatDatabase) {
    this.db = db;
  }

  static create = async (): Promise<AuthorizationService> => {
    const db = await getServerDB();
    return new AuthorizationService(db);
  };

  /**
   * Resolve an ActorContext from identity information.
   */
  resolveActor = (
    actorId: string,
    authSource = 'BETTER_AUTH',
    actorType: ActorType = 'USER',
  ): ActorContext => {
    return {
      actorId,
      actorType,
      authSource,
    };
  };

  /**
   * Authorize a request against a workspace and optional permission/role requirement.
   * Returns a fully-populated SecurityContext.
   */
  authorize = async (params: {
    actor: ActorContext;
    organizationId?: string;
    requestId: string;
    traceId?: string;
    workspaceId?: string;
    options?: AuthorizeOptions;
  }): Promise<SecurityContext> => {
    const { actor, organizationId, requestId, traceId, workspaceId, options } = params;

    // 1. Verify actor exists and is not banned
    if (actor.actorType === 'USER') {
      const user = await this.db.query.users.findFirst({
        where: (t: any, { eq }: any) => eq(t.id, actor.actorId),
      });
      if (!user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'USER_NOT_FOUND',
        });
      }
      if (user.banned) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `ACCOUNT_BANNED: ${user.banReason || 'Access restricted'}`,
        });
      }
    }

    let workspaceRole: WorkspaceRole | undefined;
    let permissions: string[] = [];

    // 2. If workspaceId is provided, enforce workspace tenant boundary
    if (workspaceId) {
      const workspace = await this.db.query.workspaces.findFirst({
        where: (t: any, { eq }: any) => eq(t.id, workspaceId),
      });

      if (!workspace) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'WORKSPACE_NOT_FOUND',
        });
      }

      // Check if workspace is frozen
      if (workspace.frozen) {
        // Block state-changing requests if workspace is frozen
        if (options?.requiredRole && options.requiredRole !== 'viewer') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `WORKSPACE_FROZEN: ${workspace.frozenReason || 'Workspace is frozen'}`,
          });
        }
      }

      // Check membership
      const role = await getActiveWorkspaceMembershipRole(this.db, {
        userId: actor.actorId,
        workspaceId,
      });

      if (!role) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'WORKSPACE_ACCESS_DENIED',
        });
      }

      workspaceRole = role as WorkspaceRole;

      // Check minimum required role if specified
      if (options?.requiredRole) {
        const roleOrder: Record<WorkspaceRole, number> = {
          owner: 4,
          admin: 3,
          member: 2,
          viewer: 1,
        };

        const currentRank = roleOrder[workspaceRole] || 0;
        const requiredRank = roleOrder[options.requiredRole] || 0;

        if (currentRank < requiredRank) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `INSUFFICIENT_WORKSPACE_PERMISSIONS: required ${options.requiredRole}, held ${workspaceRole}`,
          });
        }
      }

      // Resolve effective permissions
      const rbacModel = new RbacModel(this.db, actor.actorId);
      permissions = await rbacModel.getUserPermissions({ workspaceId });

      // Check required permission if specified
      if (options?.requiredPermission) {
        const normalizedPerm = this.normalizePermission(options.requiredPermission);
        const hasPerm = await this.hasEffectivePermission(actor.actorId, workspaceId, normalizedPerm);

        if (!hasPerm) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `PERMISSION_DENIED: missing required permission ${options.requiredPermission}`,
          });
        }
      }
    } else if (options?.requireActiveWorkspace) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'WORKSPACE_REQUIRED',
      });
    }

    return {
      actor,
      membershipId: workspaceId ? `${workspaceId}:${actor.actorId}` : undefined,
      organizationId: organizationId || workspaceId,
      permissions,
      requestId,
      traceId,
      workspaceId,
      workspaceRole,
    };
  };

  /**
   * Check whether a user has a specific permission in a workspace or globally.
   */
  hasEffectivePermission = async (
    userId: string,
    workspaceId: string | undefined,
    permission: string,
  ): Promise<boolean> => {
    const rbacModel = new RbacModel(this.db, userId);

    // Support both canonical colon-delimited and dot-delimited formats
    const candidates = this.expandPermissionVariants(permission);

    return rbacModel.hasAnyPermission(candidates, { workspaceId });
  };

  /**
   * Check workspace access helper.
   */
  checkWorkspaceAccess = async (
    userId: string,
    workspaceId: string,
    requiredRole?: WorkspaceRole,
  ): Promise<boolean> => {
    if (!requiredRole || requiredRole === 'viewer' || requiredRole === 'member') {
      return hasActiveWorkspaceMembership(this.db, { userId, workspaceId });
    }
    if (requiredRole === 'admin') {
      return hasWorkspaceAdminAccess(this.db, { userId, workspaceId });
    }
    if (requiredRole === 'owner') {
      return hasWorkspaceOwnerAccess(this.db, { userId, workspaceId });
    }
    return false;
  };

  private normalizePermission = (perm: string): string => {
    // Map dot-syntax e.g. "agent.execute" to LobeHub RBAC action syntax "agent:execute"
    return perm.replace(/\./g, ':');
  };

  private expandPermissionVariants = (perm: string): string[] => {
    const normalized = this.normalizePermission(perm);
    const variants = new Set<string>([
      perm,
      normalized,
      `${normalized}:all`,
      `${normalized}:owner`,
    ]);
    return [...variants];
  };
}
