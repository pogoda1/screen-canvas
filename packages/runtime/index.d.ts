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
  requests?: Observation[];
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
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  condition?: string;
  role?: string;
  action?: string;
  evidence: Evidence;
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
  identify?(): string | undefined;
  apply?(scenario: ScenarioV1): void | Promise<void>;
  read?(scenario: ScenarioV1): ScenarioV1 | Promise<ScenarioV1>;
}
export type ActionStep =
  { type: 'click'; selector: string } |
  { type: 'fill'; selector: string; value: string } |
  { type: 'press'; selector: string; key: string } |
  { type: 'redirect' };
export interface ProjectAction {
  id: string;
  source: string;
  target: string;
  label: string;
  condition?: string;
  role?: string;
  steps: ActionStep[];
}
export interface MockRequest {
  method: string;
  path: string;
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
