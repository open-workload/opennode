export {
  FailureInjector,
  FaultType,
  globalFailureInjector,
  type FaultConfig,
  type FaultInjection,
  type FaultPointRegistration,
} from "./injector";

export {
  FailureInjectionHarness,
  createDefaultHarness,
  type HarnessConfig,
  type HarnessScenario,
} from "./harness";

export {
  registerFaultPoints,
  registerAllFaultPoints,
  getRegisteredFaultPoints,
  clearFaultPoints,
} from "./registry";