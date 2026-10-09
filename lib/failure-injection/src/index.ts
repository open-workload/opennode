export {
  FailureInjector,
  FaultType,
  type FaultConfig,
  type FaultInjection,
  type FaultPointRegistration,
} from "./injector";

export {
  FailureInjectionHarness,
  type HarnessConfig,
  type HarnessScenario,
} from "./harness";

export {
  registerFaultPoints,
  getRegisteredFaultPoints,
  clearFaultPoints,
} from "./registry";