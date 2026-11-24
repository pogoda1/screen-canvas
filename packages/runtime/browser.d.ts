import type { BrowserBindings, ScenarioV1 } from './index.js';
export declare const browserKey: unique symbol;
export declare function registerBrowserBindings(bindings: BrowserBindings): () => void;
export declare function getInitialScenario(): ScenarioV1 | undefined;
