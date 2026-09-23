import {
  baseContextsEqual,
  cloneBaseContext,
  validateBaseContext,
} from './what-if-base-context.mjs';
import {
  WHAT_IF_SCHEMA_VERSION,
  cloneScenario,
  validateScenario,
} from './what-if-scenario.mjs';

export const WHAT_IF_STORE_KEY = 'tigersProbability.whatIf.store.v1';
export const WHAT_IF_DRAFT_KEY = 'tigersProbability.whatIf.draft.v1';

export class ScenarioStoreError extends Error {
  constructor(code, message, cause) {
    super(message, {cause});
    this.name = 'ScenarioStoreError';
    this.code = code;
  }
}

function emptyStore() {
  return {
    schema_version: WHAT_IF_SCHEMA_VERSION,
    base_contexts: [],
    scenarios: [],
    last_opened_scenario_id: null,
  };
}

function assertStorage(storage) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') {
    throw new ScenarioStoreError('STORAGE_UNAVAILABLE', 'A localStorage-compatible store is required');
  }
}

function validateStore(value) {
  if (!value || typeof value !== 'object') throw new ScenarioStoreError('CORRUPT_STORE', 'What-if store must be an object');
  if (value.schema_version !== WHAT_IF_SCHEMA_VERSION) {
    throw new ScenarioStoreError('UNSUPPORTED_SCHEMA', `Unsupported What-if store schema_version: ${value.schema_version}`);
  }
  if (!Array.isArray(value.base_contexts)) throw new ScenarioStoreError('CORRUPT_STORE', 'What-if base_contexts must be an array');
  if (!Array.isArray(value.scenarios)) throw new ScenarioStoreError('CORRUPT_STORE', 'What-if scenarios must be an array');

  const baseIds = new Set();
  for (const baseContext of value.base_contexts) {
    validateBaseContext(baseContext);
    if (baseIds.has(baseContext.base_context_id)) throw new ScenarioStoreError('CORRUPT_STORE', `Duplicate base context id: ${baseContext.base_context_id}`);
    baseIds.add(baseContext.base_context_id);
  }

  const scenarioIds = new Set();
  for (const scenario of value.scenarios) {
    validateScenario(scenario);
    if (scenarioIds.has(scenario.scenario_id)) throw new ScenarioStoreError('CORRUPT_STORE', `Duplicate Scenario id: ${scenario.scenario_id}`);
    if (!baseIds.has(scenario.base_context_id)) throw new ScenarioStoreError('CORRUPT_STORE', `Missing base context: ${scenario.base_context_id}`);
    scenarioIds.add(scenario.scenario_id);
  }
  if (value.last_opened_scenario_id !== null && typeof value.last_opened_scenario_id !== 'string') {
    throw new ScenarioStoreError('CORRUPT_STORE', 'last_opened_scenario_id must be a string or null');
  }
  return value;
}

export class LocalScenarioRepository {
  constructor({storage = globalThis.localStorage, key = WHAT_IF_STORE_KEY} = {}) {
    assertStorage(storage);
    this.storage = storage;
    this.key = key;
    this.lastLoadIssue = null;
  }

  readStore() {
    const raw = this.storage.getItem(this.key);
    if (raw === null) {
      this.lastLoadIssue = null;
      return emptyStore();
    }
    try {
      const parsed = JSON.parse(raw);
      validateStore(parsed);
      this.lastLoadIssue = null;
      return parsed;
    } catch (error) {
      this.lastLoadIssue = error instanceof ScenarioStoreError
        ? error
        : new ScenarioStoreError('CORRUPT_STORE', 'Could not read the What-if store', error);
      return emptyStore();
    }
  }

  assertWritableStore() {
    const store = this.readStore();
    if (this.lastLoadIssue) throw this.lastLoadIssue;
    return store;
  }

  writeStore(store) {
    validateStore(store);
    try {
      this.storage.setItem(this.key, JSON.stringify(store));
    } catch (error) {
      throw new ScenarioStoreError('WRITE_FAILED', 'Could not save the What-if store', error);
    }
  }

  list() {
    return this.readStore().scenarios.map(cloneScenario);
  }

  get(id) {
    const scenario = this.readStore().scenarios.find(item => item.scenario_id === id);
    return scenario ? cloneScenario(scenario) : null;
  }

  getBaseContext(id) {
    const baseContext = this.readStore().base_contexts.find(item => item.base_context_id === id);
    return baseContext ? cloneBaseContext(baseContext) : null;
  }

  getBundle(id) {
    const store = this.readStore();
    const scenario = store.scenarios.find(item => item.scenario_id === id);
    if (!scenario) return null;
    const baseContext = store.base_contexts.find(item => item.base_context_id === scenario.base_context_id);
    return {
      scenario: cloneScenario(scenario),
      base_context: cloneBaseContext(baseContext),
    };
  }

  save(scenario, baseContext = null) {
    validateScenario(scenario);
    if (baseContext) {
      validateBaseContext(baseContext);
      if (scenario.base_context_id !== baseContext.base_context_id) throw new ScenarioStoreError('BASE_MISMATCH', 'Scenario and base context do not match');
    }
    const store = this.assertWritableStore();
    const baseIndex = store.base_contexts.findIndex(item => item.base_context_id === scenario.base_context_id);
    if (baseIndex < 0) {
      if (!baseContext) throw new ScenarioStoreError('MISSING_BASE_CONTEXT', `Missing base context: ${scenario.base_context_id}`);
      store.base_contexts.push(cloneBaseContext(baseContext));
    } else if (baseContext && !baseContextsEqual(store.base_contexts[baseIndex], baseContext)) {
      throw new ScenarioStoreError('BASE_ID_COLLISION', `Base context id collision: ${scenario.base_context_id}`);
    }

    const saved = cloneScenario(scenario);
    const scenarioIndex = store.scenarios.findIndex(item => item.scenario_id === scenario.scenario_id);
    if (scenarioIndex >= 0) store.scenarios[scenarioIndex] = saved;
    else store.scenarios.push(saved);
    this.writeStore(store);
    return cloneScenario(saved);
  }

  delete(id) {
    const store = this.assertWritableStore();
    const originalLength = store.scenarios.length;
    store.scenarios = store.scenarios.filter(scenario => scenario.scenario_id !== id);
    if (store.scenarios.length === originalLength) return false;
    if (store.last_opened_scenario_id === id) store.last_opened_scenario_id = null;
    const referencedBaseIds = new Set(store.scenarios.map(scenario => scenario.base_context_id));
    store.base_contexts = store.base_contexts.filter(baseContext => referencedBaseIds.has(baseContext.base_context_id));
    this.writeStore(store);
    return true;
  }

  setLastOpenedScenarioId(id) {
    const store = this.assertWritableStore();
    if (id !== null && !store.scenarios.some(scenario => scenario.scenario_id === id)) {
      throw new ScenarioStoreError('UNKNOWN_SCENARIO', `Unknown Scenario id: ${id}`);
    }
    store.last_opened_scenario_id = id;
    this.writeStore(store);
  }

  getStatus() {
    this.readStore();
    return this.lastLoadIssue
      ? {ok: false, code: this.lastLoadIssue.code, message: this.lastLoadIssue.message}
      : {ok: true, code: null, message: ''};
  }
}
