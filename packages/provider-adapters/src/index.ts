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
export { describeTfvars, renderTfvars, workspaceNameFor } from './terraform/tfvars.js';
export type { InstanceTfvars } from './terraform/tfvars.js';
export { hasError, parseDiagnostics, redactSecrets } from './terraform/diagnostics.js';
export type { TerraformDiagnostic } from './terraform/diagnostics.js';
export { TerraformRunner } from './terraform/runner.js';
export type {
  ApplyOutcome,
  InvocationResult,
  TerraformRunnerConfiguration,
} from './terraform/runner.js';
export { INSTANCE_ADDRESS, TerraformProxmoxProvider } from './terraform-proxmox-provider.js';
export type {
  TerraformProxmoxConfiguration,
  TerraformRunReader,
} from './terraform-proxmox-provider.js';
export {
  describedWithTrailer,
  diskGiB,
  markersMatch,
  ownershipDescription,
  parseOwnership,
} from './proxmox-provider.js';
