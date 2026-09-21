import type {
  ActorContext,
  ApprovalRequest,
  RiskAssessment,
} from '@lobechat/types';
import { createHash, randomUUID } from 'node:crypto';

export function computeParametersHash(parameters: Record<string, unknown>): string {
  // Deterministic serialization with sorted keys
  const sortedKeys = Object.keys(parameters).sort();
  const canonicalObj: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    canonicalObj[k] = parameters[k];
  }
  return createHash('sha256').update(JSON.stringify(canonicalObj)).digest('hex');
}

export class ApprovalEngine {
  private requests: Map<string, ApprovalRequest> = new Map();

  /**
   * Creates a parameter-bound, time-expiring approval request.
   */
  createApprovalRequest = (params: {
    action: string;
    parameters: Record<string, unknown>;
    riskAssessment: RiskAssessment;
    target: string;
    ttlSeconds?: number;
  }): ApprovalRequest => {
    const id = `apr_${randomUUID().replace(/-/g, '')}`;
    const ttl = params.ttlSeconds || 3600; // 1 hour default
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 1000);

    const request: ApprovalRequest = {
      action: params.action,
      createdAt: now,
      expiresAt,
      id,
      parametersHash: computeParametersHash(params.parameters),
      riskAssessment: params.riskAssessment,
      status: 'PENDING',
      target: params.target,
    };

    this.requests.set(id, request);
    return request;
  };

  /**
   * Grants human dual-control approval for a pending request.
   */
  approveRequest = (requestId: string, approver: ActorContext): ApprovalRequest => {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`APPROVAL_NOT_FOUND: Request '${requestId}' not found.`);
    }

    if (request.status !== 'PENDING') {
      throw new Error(`APPROVAL_INVALID_STATE: Request is already '${request.status}'.`);
    }

    if (new Date() > request.expiresAt) {
      request.status = 'EXPIRED';
      throw new Error('APPROVAL_EXPIRED: Approval request has expired.');
    }

    // Dual-control: Actor cannot approve their own high-risk request if they were the requester
    if (request.riskAssessment.factors.actor.actorId === approver.actorId) {
      throw new Error('DUAL_CONTROL_VIOLATION: Requester cannot approve their own action.');
    }

    request.status = 'APPROVED';
    request.approvedBy = approver.actorId;
    request.approvedAt = new Date();

    return request;
  };

  /**
   * Rejects an approval request.
   */
  rejectRequest = (requestId: string, approver: ActorContext, reason: string): ApprovalRequest => {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`APPROVAL_NOT_FOUND: Request '${requestId}' not found.`);
    }

    request.status = 'REJECTED';
    request.rejectionReason = reason;
    request.approvedBy = approver.actorId;
    request.approvedAt = new Date();

    return request;
  };

  /**
   * Cryptographically validates that execution matches the approved request.
   * Invariant: Generic tokens like "Approved" or "true" are strictly rejected.
   */
  validateAndConsumeApproval = (
    approvalToken: string,
    action: string,
    target: string,
    parameters: Record<string, unknown>,
  ): void => {
    // 1. Prohibit generic tokens
    if (!approvalToken || !approvalToken.startsWith('apr_')) {
      throw new Error(
        `INVALID_APPROVAL_TOKEN: Generic or malformed approval token '${approvalToken}' is prohibited. Must provide a valid bound ApprovalRequest ID.`,
      );
    }

    const request = this.requests.get(approvalToken);
    if (!request) {
      throw new Error(`APPROVAL_NOT_FOUND: Approval request '${approvalToken}' does not exist.`);
    }

    // 2. Check Expiration
    if (new Date() > request.expiresAt) {
      request.status = 'EXPIRED';
      throw new Error('APPROVAL_EXPIRED: Approval request has expired.');
    }

    // 3. Check Status
    if (request.status !== 'APPROVED') {
      throw new Error(`APPROVAL_NOT_GRANTED: Request status is '${request.status}', expected 'APPROVED'.`);
    }

    // 4. Check Action & Target binding
    if (request.action !== action) {
      throw new Error(
        `APPROVAL_ACTION_MISMATCH: Approved action was '${request.action}', but execution attempted '${action}'.`,
      );
    }

    if (request.target !== target) {
      throw new Error(
        `APPROVAL_TARGET_MISMATCH: Approved target was '${request.target}', but execution attempted '${target}'.`,
      );
    }

    // 5. Check Cryptographic Parameters Binding
    const currentHash = computeParametersHash(parameters);
    if (currentHash !== request.parametersHash) {
      throw new Error(
        'APPROVAL_PARAMETER_MISMATCH: Execution parameters do not match the cryptographically approved parameters.',
      );
    }
  };
}
