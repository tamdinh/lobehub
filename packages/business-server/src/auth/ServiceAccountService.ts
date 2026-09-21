import { getServerDB, type LobeChatDatabase } from '@lobechat/database';
import type { ActorContext, SecurityContext } from '@lobechat/types';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export interface ServiceAccount {
  createdAt: Date;
  description?: string;
  id: string;
  name: string;
  organizationId?: string;
  permissions: string[];
  status: 'active' | 'revoked';
  workspaceId: string;
}

export interface ApiKeyRecord {
  createdAt: Date;
  id: string;
  keyHash: string;
  keyPrefix: string;
  lastUsedAt?: Date;
  serviceAccountId: string;
  status: 'active' | 'revoked';
  workspaceId: string;
}

export class ServiceAccountService {
  private db: LobeChatDatabase;
  private serviceAccounts: Map<string, ServiceAccount> = new Map();
  private keyStore: Map<string, ApiKeyRecord> = new Map(); // keyHash -> ApiKeyRecord

  constructor(db: LobeChatDatabase) {
    this.db = db;
  }

  static create = async (): Promise<ServiceAccountService> => {
    const db = await getServerDB();
    return new ServiceAccountService(db);
  };

  /**
   * Provisions a new scoped service account within a workspace.
   */
  createServiceAccount = async (params: {
    description?: string;
    name: string;
    organizationId?: string;
    permissions: string[];
    workspaceId: string;
  }): Promise<ServiceAccount> => {
    const account: ServiceAccount = {
      createdAt: new Date(),
      description: params.description,
      id: `sa_${randomUUID().replace(/-/g, '')}`,
      name: params.name,
      organizationId: params.organizationId,
      permissions: params.permissions,
      status: 'active',
      workspaceId: params.workspaceId,
    };

    this.serviceAccounts.set(account.id, account);
    return account;
  };

  /**
   * Generates a secure API key bound to a service account.
   * Returns plaintext key once (prefix + secret).
   */
  generateApiKey = async (serviceAccountId: string): Promise<{ apiKey: string; keyId: string }> => {
    const account = this.serviceAccounts.get(serviceAccountId);
    if (!account || account.status !== 'active') {
      throw new Error(`SERVICE_ACCOUNT_NOT_FOUND: Active service account '${serviceAccountId}' not found.`);
    }

    const secret = randomBytes(24).toString('hex');
    const keyPrefix = 'sk_saas_';
    const plaintextKey = `${keyPrefix}${secret}`;
    const keyHash = createHash('sha256').update(plaintextKey).digest('hex');

    const keyRecord: ApiKeyRecord = {
      createdAt: new Date(),
      id: `key_${randomUUID().replace(/-/g, '')}`,
      keyHash,
      keyPrefix: plaintextKey.slice(0, 12),
      serviceAccountId,
      status: 'active',
      workspaceId: account.workspaceId,
    };

    this.keyStore.set(keyHash, keyRecord);
    return { apiKey: plaintextKey, keyId: keyRecord.id };
  };

  /**
   * Authenticates an API key and builds an unprivileged, scoped ActorContext.
   */
  authenticateApiKey = async (plaintextKey: string): Promise<{ actor: ActorContext; workspaceId: string }> => {
    const keyHash = createHash('sha256').update(plaintextKey).digest('hex');
    const keyRecord = this.keyStore.get(keyHash);

    if (!keyRecord || keyRecord.status !== 'active') {
      throw new Error('AUTHENTICATION_FAILED: Invalid or revoked API key.');
    }

    const account = this.serviceAccounts.get(keyRecord.serviceAccountId);
    if (!account || account.status !== 'active') {
      throw new Error('SERVICE_ACCOUNT_SUSPENDED: Associated service account is inactive.');
    }

    // Update last used timestamp
    keyRecord.lastUsedAt = new Date();

    const actor: ActorContext = {
      actorId: account.id,
      actorType: 'SERVICE',
      authSource: 'API_KEY',
      organizationId: account.organizationId,
      permissions: account.permissions,
      roles: ['service_account'],
    };

    return { actor, workspaceId: account.workspaceId };
  };

  /**
   * Builds an explicit SecurityContext for background execution.
   */
  createBackgroundSecurityContext = (params: {
    actor: ActorContext;
    traceId?: string;
    workspaceId: string;
  }): SecurityContext => {
    return {
      actor: params.actor,
      organizationId: params.actor.organizationId,
      permissions: params.actor.permissions,
      requestId: `req_bg_${randomUUID().replace(/-/g, '')}`,
      runId: `run_bg_${randomUUID().replace(/-/g, '')}`,
      systemRole: 'user',
      traceId: params.traceId || `trace_bg_${randomUUID().replace(/-/g, '')}`,
      workspaceId: params.workspaceId,
      workspaceRole: 'member',
    };
  };
}
