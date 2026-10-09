import { FailureInjector, FaultPointRegistration, FaultType } from "./injector";

const faultPointRegistry = new Map<string, FaultPointRegistration>();

export function registerFaultPoints(points: FaultPointRegistration[]): void {
  const injector = new FailureInjector();
  for (const point of points) {
    if (faultPointRegistry.has(point.name)) {
      throw new Error(`Fault point ${point.name} already registered`);
    }
    faultPointRegistry.set(point.name, point);
    injector.registerFaultPoint(point);
  }
}

export function getRegisteredFaultPoints(): FaultPointRegistration[] {
  return Array.from(faultPointRegistry.values());
}

export function getRegisteredFaultPointsBySubsystem(subsystem: string): FaultPointRegistration[] {
  return Array.from(faultPointRegistry.values()).filter(fp => fp.subsystem === subsystem);
}

export function clearFaultPoints(): void {
  faultPointRegistry.clear();
}

export const peernetFaultPoints: FaultPointRegistration[] = [
  {
    name: "peernet.send_message",
    subsystem: "peernet",
    description: "Sending a message to a peer",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.Partition, FaultType.MessageLoss, FaultType.MessageDuplication, FaultType.MessageReordering],
  },
  {
    name: "peernet.receive_message",
    subsystem: "peernet",
    description: "Receiving a message from a peer",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.MessageLoss, FaultType.MessageDuplication, FaultType.MessageReordering, FaultType.DataCorruption],
  },
  {
    name: "peernet.dial",
    subsystem: "peernet",
    description: "Dialing a peer connection",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.Partition],
  },
  {
    name: "peernet.accept",
    subsystem: "peernet",
    description: "Accepting an incoming peer connection",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout],
  },
];

export const syncEngineFaultPoints: FaultPointRegistration[] = [
  {
    name: "sync-engine.propose",
    subsystem: "sync-engine",
    description: "Proposing a new value for consensus",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.Crash],
  },
  {
    name: "sync-engine.commit",
    subsystem: "sync-engine",
    description: "Committing a decided value",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.DataCorruption],
  },
  {
    name: "sync-engine.catchup",
    subsystem: "sync-engine",
    description: "Catching up missing log entries",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.ResourceExhaustion],
  },
  {
    name: "sync-engine.replicate",
    subsystem: "sync-engine",
    description: "Replicating log entries to followers",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.MessageLoss, FaultType.MessageDuplication],
  },
];

export const gossipFaultPoints: FaultPointRegistration[] = [
  {
    name: "gossip.disseminate",
    subsystem: "gossip",
    description: "Disseminating a message via gossip",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.MessageLoss, FaultType.MessageDuplication, FaultType.MessageReordering],
  },
  {
    name: "gossip.receive",
    subsystem: "gossip",
    description: "Receiving a gossip message",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.MessageLoss, FaultType.DataCorruption],
  },
  {
    name: "gossip.merge_state",
    subsystem: "gossip",
    description: "Merging received gossip state",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.DataCorruption, FaultType.ResourceExhaustion],
  },
];

export const membershipLogFaultPoints: FaultPointRegistration[] = [
  {
    name: "membership-log.commit_decision",
    subsystem: "membership-log",
    description: "Committing a membership decision",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.Crash, FaultType.DataCorruption],
  },
  {
    name: "membership-log.get_quorum",
    subsystem: "membership-log",
    description: "Getting current quorum configuration",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout],
  },
  {
    name: "membership-log.propose_change",
    subsystem: "membership-log",
    description: "Proposing a membership change",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.Crash],
  },
  {
    name: "membership-log.validate_signature",
    subsystem: "membership-log",
    description: "Validating a membership signature",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.DataCorruption, FaultType.ClockSkew],
  },
];

export const runCoordinatorFaultPoints: FaultPointRegistration[] = [
  {
    name: "run-coordinator.acquire_lease",
    subsystem: "run-coordinator",
    description: "Acquiring a run lease",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.Crash],
  },
  {
    name: "run-coordinator.renew_lease",
    subsystem: "run-coordinator",
    description: "Renewing an existing lease",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout],
  },
  {
    name: "run-coordinator.submit_run",
    subsystem: "run-coordinator",
    description: "Submitting a new run",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.ResourceExhaustion],
  },
  {
    name: "run-coordinator.dispatch",
    subsystem: "run-coordinator",
    description: "Dispatching a run to a worker",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.MessageLoss],
  },
];

export const workerRuntimeFaultPoints: FaultPointRegistration[] = [
  {
    name: "worker-runtime.execute",
    subsystem: "worker-runtime",
    description: "Executing a workload",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.Crash, FaultType.ResourceExhaustion],
  },
  {
    name: "worker-runtime.stream_logs",
    subsystem: "worker-runtime",
    description: "Streaming logs from a workload",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.MessageLoss, FaultType.MessageReordering],
  },
  {
    name: "worker-runtime.pull_image",
    subsystem: "worker-runtime",
    description: "Pulling a container image",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.ResourceExhaustion],
  },
  {
    name: "worker-runtime.cleanup",
    subsystem: "worker-runtime",
    description: "Cleaning up after workload completion",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.ResourceExhaustion],
  },
];

export const nodeStoreFaultPoints: FaultPointRegistration[] = [
  {
    name: "node-store.read",
    subsystem: "node-store",
    description: "Reading from the node store",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.DataCorruption],
  },
  {
    name: "node-store.write",
    subsystem: "node-store",
    description: "Writing to the node store",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.DataCorruption, FaultType.ResourceExhaustion],
  },
  {
    name: "node-store.delete",
    subsystem: "node-store",
    description: "Deleting from the node store",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.ResourceExhaustion],
  },
  {
    name: "node-store.transaction",
    subsystem: "node-store",
    description: "Executing a transaction",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.Crash, FaultType.DataCorruption],
  },
];

export const secretBrokerFaultPoints: FaultPointRegistration[] = [
  {
    name: "secret-broker.get_secret",
    subsystem: "secret-broker",
    description: "Retrieving a secret",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.DataCorruption],
  },
  {
    name: "secret-broker.store_secret",
    subsystem: "secret-broker",
    description: "Storing a secret",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.ResourceExhaustion],
  },
  {
    name: "secret-broker.rotate_secret",
    subsystem: "secret-broker",
    description: "Rotating a secret",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.DataCorruption],
  },
];

export const contentStoreFaultPoints: FaultPointRegistration[] = [
  {
    name: "content-store.write_chunk",
    subsystem: "content-store",
    description: "Writing a content chunk",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.DataCorruption, FaultType.ResourceExhaustion],
  },
  {
    name: "content-store.read_chunk",
    subsystem: "content-store",
    description: "Reading a content chunk",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.DataCorruption],
  },
  {
    name: "content-store.delete_chunk",
    subsystem: "content-store",
    description: "Deleting a content chunk",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.ResourceExhaustion],
  },
  {
    name: "content-store.list_chunks",
    subsystem: "content-store",
    description: "Listing content chunks",
    supportedFaultTypes: [FaultType.Latency, FaultType.Error, FaultType.Timeout, FaultType.ResourceExhaustion],
  },
];

export function registerAllFaultPoints(): void {
  registerFaultPoints([
    ...peernetFaultPoints,
    ...syncEngineFaultPoints,
    ...gossipFaultPoints,
    ...membershipLogFaultPoints,
    ...runCoordinatorFaultPoints,
    ...workerRuntimeFaultPoints,
    ...nodeStoreFaultPoints,
    ...secretBrokerFaultPoints,
    ...contentStoreFaultPoints,
  ]);
}