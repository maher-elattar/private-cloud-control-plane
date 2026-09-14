export { FakeProvider } from './fake-provider.js';
export type {
  FakeProviderCall,
  FakeProviderConfiguration,
  FakeProviderMode,
  FakeProviderStep,
} from './fake-provider.js';
export { ProxmoxProvider } from './proxmox-provider.js';
export type { ProxmoxProviderConfiguration } from './proxmox-provider.js';
export { evaluatePlan, isRecoverableByUntaint } from './terraform/plan-gate.js';
export type {
  GateDecision,
  GateObjection,
  GateOptions,
  GateResult,
  PlanAction,
  PlanResourceChange,
  TerraformPlan,
} from './terraform/plan-gate.js';
