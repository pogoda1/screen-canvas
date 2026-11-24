export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export interface Diagnostic {
  code: string;
  message: string;
  path?: string;
}
export interface Observation {
  method: string;
  path: string;
  status: number;
}
export interface Evidence {
  status: 'static' | 'confirmed' | 'unverified';
  reason?: string;
  actualTarget?: string;
  expectedPath?: string;
  actualPath?: string;
  requests?: Observation[];
  transitionObserved?: boolean;
  targetReady?: boolean;
  targetReason?: string;
  requestCheck?: 'verified' | 'unverified';
  actionFailure?: Diagnostic;
  backgroundFailure?: Diagnostic;
  actionPending?: boolean;
  backgroundPending?: boolean;
  /** Normalized coordinates on the verified source frame. */
  origin?: { x: number; y: number };
}
export interface CaptureRule {
  source: string;
  /** Exact scenario mode. If omitted, the rule applies to every mode. */
  role?: string;
  target: string;
  /** Exact local pathname, including concrete parameter values. */
  path: string;
  /** Caption for a distinct, intentionally captured product state. */
  state?: string;
}
export interface CaptureEvidence {
  outcome: 'captured' | 'special-state' | 'transition' | 'blocked' | 'different-screen';
  phase: 'navigation' | 'readiness' | 'frame' | 'request' | 'complete';
  expectedNode: string;
  expectedPath?: string;
  actualNode?: string;
  actualPath?: string;
  targetReady: boolean;
  transition?: 'verified' | 'observed-url' | 'unexpected';
  state?: string;
  reason: Diagnostic;
  observations: Diagnostic[];
}
export interface GraphNode {
  id: string;
  path: string;
  label: string;
  parentId?: string;
  index?: boolean;
  state?: string;
  group?: string;
  source?: string;
  component?: string;
  diagnostics?: Diagnostic[];
  screenshot?: string;
  capture?: CaptureEvidence;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  condition?: string;
  role?: string;
  action?: string;
  displayValues?: Array<string | number | boolean>;
  evidence: Evidence;
  expectedPath?: string;
}
export interface FieldSchema {
  kind: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'unknown';
  sources: Array<{ kind: 'typescript' | 'openapi' | 'adapter'; path: string }>;
  fields?: Record<string, FieldSchema>;
  items?: FieldSchema;
  enum?: Json[];
  nullable?: boolean;
  optional?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  binding?: { kind: 'api' | 'props' | 'state'; key: string };
  readOnlyReason?: string;
  diagnostics?: Diagnostic[];
}
export interface ScenarioV1 {
  version: 1;
  nodeId: string;
  seed: number;
  params: Record<string, string>;
  mode: string;
  data: JsonObject;
  draft?: JsonObject;
}
export interface SessionStamp {
  generation: number;
  sessionId: string;
  documentId: string;
  revision: number;
}
export type SessionCommand = SessionStamp & (
  { type: 'apply'; scenario: ScenarioV1 } | { type: 'read' | 'ready' | 'ack' }
);
export interface BrowserBindings {
  ready?(): boolean | Promise<boolean>;
  /** Additional readiness for static captures only. Live read/apply still uses ready. */
  captureReady?(): boolean | Promise<boolean>;
  identify?(): string | undefined;
  apply?(scenario: ScenarioV1): void | Promise<void>;
  read?(scenario: ScenarioV1): ScenarioV1 | Promise<ScenarioV1>;
}
export type ActionStep =
  { type: 'click'; selector: string } |
  { type: 'fill'; selector: string; value: string } |
  { type: 'press'; selector: string; key: string } |
  { type: 'redirect' };
export interface ExpectedMockExchange {
  method: string;
  path: string;
  status?: number;
  body?: Json;
  response?: Json;
}
export interface ProjectAction {
  id: string;
  source: string;
  target: string;
  label: string;
  condition?: string;
  role?: string;
  steps: ActionStep[];
  /** Static answer labels shown after confirmation. Never use captured request data. */
  displayValues?: Array<string | number | boolean>;
  expectedPath?: string;
  expectRequests?: ExpectedMockExchange[];
  expectSnapshot?: { mode?: string; data?: JsonObject };
}
export interface MockRequest {
  method: string;
  path: string;
  search: string;
  body?: Json;
  scenario: ScenarioV1;
}
export interface MockResponse {
  status?: number;
  body: Json;
}
export type ScenarioInput = Partial<ScenarioV1> & {
  entities?: Array<{ param: string; field: string[]; prefix?: string }>;
};
export interface ProjectAdapter {
  tsconfig?: string;
  env?: Record<string, string>;
  browser?: string;
  openapi?: string;
  transports?: Array<{ call: string; path: string; method?: string }>;
  bindings?: Record<string, NonNullable<FieldSchema['binding']>>;
  configure?(context: { load(specifier: string): Promise<Record<string, unknown>> }): void | Promise<void>;
  apiPrefixes?: string[];
  captureRules?: CaptureRule[];
  nodes?: GraphNode[] | (() => GraphNode[] | Promise<GraphNode[]>);
  actions?: ProjectAction[] | (() => ProjectAction[] | Promise<ProjectAction[]>);
  schema?(node: GraphNode): FieldSchema | undefined | Promise<FieldSchema | undefined>;
  scenario?(node: GraphNode, role?: string): ScenarioInput | Promise<ScenarioInput>;
  createMocks?(scenario: ScenarioV1): (request: MockRequest) => MockResponse | undefined | Promise<MockResponse | undefined>;
  createHost?: HostDriver['start'];
}
export interface HostDriver {
  start(context: { root: string; adapter: ProjectAdapter }): Promise<{
    transformIndexHtml(url: string, html: string): Promise<string>;
    middleware(request: unknown, response: unknown, next: () => void): void;
    close(): Promise<void>;
  }>;
}
export declare function defineAdapter<T extends ProjectAdapter>(adapter: T): T;
