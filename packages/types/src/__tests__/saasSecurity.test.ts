import { describe, expect, it } from 'vitest';

import { type ActorContext, type SecurityContext } from '../saasSecurity';

describe('SaaS Security Types', () => {
  it('should instantiate valid ActorContext', () => {
    const userActor: ActorContext = {
      actorId: 'usr_123',
      actorType: 'USER',
      authSource: 'BETTER_AUTH',
    };

    expect(userActor.actorType).toBe('USER');
    expect(userActor.actorId).toBe('usr_123');
  });

  it('should instantiate valid SecurityContext with tenant scoping', () => {
    const secCtx: SecurityContext = {
      actor: {
        actorId: 'usr_123',
        actorType: 'USER',
        authSource: 'BETTER_AUTH',
      },
      organizationId: 'org_abc',
      permissions: ['agent:read', 'workspace:read'],
      requestId: 'req_xyz',
      workspaceId: 'ws_789',
      workspaceRole: 'member',
    };

    expect(secCtx.workspaceId).toBe('ws_789');
    expect(secCtx.workspaceRole).toBe('member');
    expect(secCtx.permissions).toContain('agent:read');
  });
});
