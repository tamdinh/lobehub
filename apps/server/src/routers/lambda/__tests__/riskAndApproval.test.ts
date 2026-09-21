// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { ApprovalEngine, computeParametersHash } from '@/business/server/governance/ApprovalEngine';
import { RiskEngine } from '@/business/server/governance/RiskEngine';
import type { ActorContext, RiskFactors } from '@lobechat/types';

describe('SaaS Contextual Risk Engine & Parameter-Bound Approval (Mission 6)', () => {
  const requesterActor: ActorContext = {
    actorId: 'usr-requester',
    actorType: 'USER',
    authSource: 'SESSION',
    organizationId: 'org-1',
    permissions: ['admin:workspaces:write'],
    roles: ['admin'],
  };

  const approverActor: ActorContext = {
    actorId: 'usr-security-officer',
    actorType: 'ADMIN',
    authSource: 'SESSION',
    organizationId: 'org-platform',
    permissions: ['admin:approvals:write'],
    roles: ['admin'],
  };

  describe('RiskEngine (Contextual Multi-Dimensional Evaluation)', () => {
    it('evaluates low risk for reversible, single-resource read operations', () => {
      const riskEngine = new RiskEngine();

      const lowRiskFactors: RiskFactors = {
        action: 'admin.users.search',
        actor: requesterActor,
        blastRadius: 'SINGLE_RESOURCE',
        confidence: 0.95,
        dataSensitivity: 'PUBLIC',
        environment: 'DEVELOPMENT',
        financialImpactMicros: 0,
        reversibility: 'REVERSIBLE',
        scope: 'WORKSPACE',
        target: 'users',
      };

      const assessment = riskEngine.evaluateRisk(lowRiskFactors);
      expect(assessment.riskLevel).toBe('LOW');
      expect(assessment.requiresApproval).toBe(false);
      expect(assessment.score).toBeLessThan(25);
    });

    it('evaluates CRITICAL risk for irreversible, high financial, global production actions', () => {
      const riskEngine = new RiskEngine();

      const criticalRiskFactors: RiskFactors = {
        action: 'admin.billing.mass_refund',
        actor: requesterActor,
        blastRadius: 'GLOBAL',
        confidence: 0.75,
        dataSensitivity: 'RESTRICTED',
        environment: 'PRODUCTION',
        financialImpactMicros: 500_000_000, // $500
        reversibility: 'IRREVERSIBLE',
        scope: 'SYSTEM',
        target: 'global_billing_ledger',
      };

      const assessment = riskEngine.evaluateRisk(criticalRiskFactors);
      expect(assessment.riskLevel).toBe('CRITICAL');
      expect(assessment.requiresApproval).toBe(true);
      expect(assessment.score).toBeGreaterThanOrEqual(75);
    });
  });

  describe('ApprovalEngine (Cryptographic Binding & Anti-Tampering)', () => {
    it('strictly rejects generic approval tokens like "Approved" or "true"', () => {
      const approvalEngine = new ApprovalEngine();

      expect(() =>
        approvalEngine.validateAndConsumeApproval('Approved', 'action.x', 'target.y', {}),
      ).toThrowError(/INVALID_APPROVAL_TOKEN/);

      expect(() =>
        approvalEngine.validateAndConsumeApproval('true', 'action.x', 'target.y', {}),
      ).toThrowError(/INVALID_APPROVAL_TOKEN/);
    });

    it('enforces dual-control: requester cannot approve their own high-risk request', () => {
      const approvalEngine = new ApprovalEngine();
      const riskEngine = new RiskEngine();

      const assessment = riskEngine.evaluateRisk({
        action: 'admin.workspace.freeze',
        actor: requesterActor,
        blastRadius: 'WORKSPACE',
        confidence: 0.9,
        dataSensitivity: 'INTERNAL',
        environment: 'PRODUCTION',
        financialImpactMicros: 0,
        reversibility: 'PARTIALLY_REVERSIBLE',
        scope: 'WORKSPACE',
        target: 'ws-delinquent',
      });

      const request = approvalEngine.createApprovalRequest({
        action: 'admin.workspace.freeze',
        parameters: { reason: 'delinquency', workspaceId: 'ws-delinquent' },
        riskAssessment: assessment,
        target: 'ws-delinquent',
      });

      // Requester attempts to approve their own request -> DUAL_CONTROL_VIOLATION
      expect(() => approvalEngine.approveRequest(request.id, requesterActor)).toThrowError(
        /DUAL_CONTROL_VIOLATION/,
      );
    });

    it('detects parameter tampering via cryptographic parameter hash comparison', () => {
      const approvalEngine = new ApprovalEngine();
      const riskEngine = new RiskEngine();

      const assessment = riskEngine.evaluateRisk({
        action: 'admin.billing.refund',
        actor: requesterActor,
        blastRadius: 'WORKSPACE',
        confidence: 0.9,
        dataSensitivity: 'CONFIDENTIAL',
        environment: 'PRODUCTION',
        financialImpactMicros: 50_000_000,
        reversibility: 'REVERSIBLE',
        scope: 'WORKSPACE',
        target: 'ev-usage-123',
      });

      // 1. Create approval request for $50 (50,000,000 micros)
      const request = approvalEngine.createApprovalRequest({
        action: 'admin.billing.refund',
        parameters: { refundMicros: 50_000_000, usageId: 'ev-usage-123' },
        riskAssessment: assessment,
        target: 'ev-usage-123',
      });

      // 2. Approver grants approval
      approvalEngine.approveRequest(request.id, approverActor);

      // 3. Execution attempts to run with tampered parameter ($500 instead of $50)
      expect(() =>
        approvalEngine.validateAndConsumeApproval(
          request.id,
          'admin.billing.refund',
          'ev-usage-123',
          { refundMicros: 500_000_000, usageId: 'ev-usage-123' }, // Tampered parameter!
        ),
      ).toThrowError(/APPROVAL_PARAMETER_MISMATCH/);

      // 4. Execution with EXACT matching parameters succeeds cleanly
      expect(() =>
        approvalEngine.validateAndConsumeApproval(
          request.id,
          'admin.billing.refund',
          'ev-usage-123',
          { refundMicros: 50_000_000, usageId: 'ev-usage-123' },
        ),
      ).not.toThrow();
    });

    it('rejects execution when approval request has expired', () => {
      const approvalEngine = new ApprovalEngine();
      const riskEngine = new RiskEngine();

      const assessment = riskEngine.evaluateRisk({
        action: 'admin.model.disable',
        actor: requesterActor,
        blastRadius: 'GLOBAL',
        confidence: 0.95,
        dataSensitivity: 'INTERNAL',
        environment: 'PRODUCTION',
        financialImpactMicros: 0,
        reversibility: 'REVERSIBLE',
        scope: 'SYSTEM',
        target: 'gpt-4o',
      });

      // Expired in 0 seconds (already expired)
      const request = approvalEngine.createApprovalRequest({
        action: 'admin.model.disable',
        parameters: { modelId: 'gpt-4o' },
        riskAssessment: assessment,
        target: 'gpt-4o',
        ttlSeconds: -1, // Expired immediately
      });

      expect(() => approvalEngine.approveRequest(request.id, approverActor)).toThrowError(
        /APPROVAL_EXPIRED/,
      );
    });
  });
});
