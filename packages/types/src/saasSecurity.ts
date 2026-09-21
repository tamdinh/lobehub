/**
 * Identity and Actor Context for SaaS Control Plane.
 * Conforms to Master Prompt Section 26 & 27.
 */

export type ActorType =
  | 'USER'
  | 'SERVICE'
  | 'AGENT'
  | 'SYSTEM'
  | 'ADMIN';

export interface ActorContext {
  /**
   * The kind of actor initiating the operation.
   */
  actorType: ActorType;

  /**
   * Unique identifier of the actor (e.g., user id, service account id, or agent id).
   */
  actorId: string;

  /**
   * Authentication source or credential mechanism used.
   * e.g., 'BETTER_AUTH' | 'OIDC' | 'API_KEY' | 'SYSTEM' | 'INTERNAL_JWT'
   */
  authSource: string;

  /**
   * Organization scope if applicable.
   */
  organizationId?: string;

  /**
   * Workspace scope if applicable.
   */
  workspaceId?: string;

  /**
   * List of permissions granted directly to the actor.
   */
  permissions?: string[];

  /**
   * List of roles assigned to the actor.
   */
  roles?: string[];
}

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface SecurityContext {
  /**
   * The authenticated actor.
   */
  actor: ActorContext;

  /**
   * Optional top-level Organization identity.
   */
  organizationId?: string;

  /**
   * Active tenant partition / Workspace scope.
   */
  workspaceId?: string;

  /**
   * Active membership identifier or composite key.
   */
  membershipId?: string;

  /**
   * System-wide administrative role, e.g., 'super_admin' or 'user'.
   */
  systemRole?: string;

  /**
   * Effective role within the active workspace ('owner' | 'admin' | 'member' | 'viewer').
   */
  workspaceRole?: WorkspaceRole | string;

  /**
   * List of effective permissions granted in this context.
   */
  permissions?: string[];

  /**
   * Correlation ID for the incoming HTTP / RPC request.
   */
  requestId: string;

  /**
   * Distributed OpenTelemetry trace identifier.
   */
  traceId?: string;

  /**
   * Identifier of the current agent execution run.
   */
  runId?: string;

  /**
   * Target or executing agent identifier.
   */
  agentId?: string;
}
