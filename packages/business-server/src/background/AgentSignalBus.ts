import { randomUUID } from 'node:crypto';

export interface AgentSignal<T = unknown> {
  actorId: string;
  id: string;
  organizationId?: string;
  payload: T;
  runId: string;
  timestamp: Date;
  traceId: string;
  type: string;
  workspaceId: string;
}

export type SignalHandler<T = unknown> = (signal: AgentSignal<T>) => Promise<void> | void;

interface Subscription {
  handler: SignalHandler<any>;
  id: string;
  type: string;
  workspaceId: string;
}

export class AgentSignalBus {
  private subscriptions: Map<string, Subscription> = new Map();

  /**
   * Dispatches a typed agent signal strictly scoped to a workspace.
   */
  emit = <T = unknown>(signal: Omit<AgentSignal<T>, 'id' | 'timestamp'>): AgentSignal<T> => {
    const fullSignal: AgentSignal<T> = {
      ...signal,
      id: `sig_${randomUUID().replace(/-/g, '')}`,
      timestamp: new Date(),
    };

    // Dispatch asynchronously to matching workspace subscribers only
    for (const sub of this.subscriptions.values()) {
      if (sub.type === fullSignal.type && sub.workspaceId === fullSignal.workspaceId) {
        Promise.resolve().then(() => sub.handler(fullSignal)).catch((err) => {
          console.error(`[AgentSignalBus] Error in handler for ${sub.type}:`, err);
        });
      }
    }

    return fullSignal;
  };

  /**
   * Subscribes to a signal type within a tenant workspace boundary.
   * Cross-tenant invariant: Handlers only receive events matching their registered workspaceId.
   */
  subscribe = <T = unknown>(
    type: string,
    workspaceId: string,
    handler: SignalHandler<T>,
  ): (() => void) => {
    const id = `sub_${randomUUID().replace(/-/g, '')}`;
    this.subscriptions.set(id, { handler, id, type, workspaceId });

    return () => {
      this.subscriptions.delete(id);
    };
  };

  getSubscriptionsCount = (): number => this.subscriptions.size;
}
