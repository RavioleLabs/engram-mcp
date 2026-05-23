import { describe, it, expect, beforeEach } from 'vitest';
import { moduleRegistry } from '../memory/core/module-registry.js';
import type { MemoryModule } from '../memory/core/module-interface.js';

const fakeModule = (id: string): MemoryModule => ({
  id,
  displayName: `Fake ${id}`,
  isCustom: false,
  onBoot: async () => {},
  onShutdown: async () => {},
  ingest: async () => [],
  tools: [
    {
      name: `search_${id}`,
      description: `Search ${id}`,
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ ok: true }),
    },
  ],
});

describe('ModuleRegistry', () => {
  beforeEach(() => {
    // Reset registry between tests
    for (const m of moduleRegistry.list()) {
      moduleRegistry['modules'].delete(m.id);
    }
    moduleRegistry['booted'] = false;
  });

  it('registers a module and lists it', () => {
    moduleRegistry.register(fakeModule('test'));
    expect(moduleRegistry.list().map((m) => m.id)).toEqual(['test']);
  });

  it('throws on duplicate registration', () => {
    moduleRegistry.register(fakeModule('dup'));
    expect(() => moduleRegistry.register(fakeModule('dup'))).toThrow(/already registered/);
  });

  it('collects tools from all modules', () => {
    moduleRegistry.register(fakeModule('a'));
    moduleRegistry.register(fakeModule('b'));
    expect(
      moduleRegistry
        .collectTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(['search_a', 'search_b']);
  });
});
