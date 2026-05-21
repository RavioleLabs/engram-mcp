import { createLogger } from '../../logger.js';
import type { MemoryModule, MemoryModuleContext, MCPToolDefinition } from './module-interface.js';

const log = createLogger('module-registry');

class ModuleRegistry {
  private modules = new Map<string, MemoryModule>();
  private booted = false;

  register(module: MemoryModule): void {
    if (this.modules.has(module.id)) {
      throw new Error(`Module ${module.id} already registered`);
    }
    this.modules.set(module.id, module);
    log.info(`Registered module: ${module.id} (${module.displayName})`);
  }

  get(id: string): MemoryModule | undefined {
    return this.modules.get(id);
  }

  list(): MemoryModule[] {
    return [...this.modules.values()];
  }

  collectTools(): MCPToolDefinition[] {
    const tools: MCPToolDefinition[] = [];
    for (const mod of this.modules.values()) {
      tools.push(...mod.tools);
    }
    return tools;
  }

  async bootAll(ctx: MemoryModuleContext): Promise<void> {
    if (this.booted) throw new Error('Registry already booted');
    for (const mod of this.modules.values()) {
      await mod.onBoot(ctx);
      mod.startWatcher?.();
      log.info(`Booted module: ${mod.id}`);
    }
    this.booted = true;
  }

  async shutdownAll(): Promise<void> {
    for (const mod of this.modules.values()) {
      mod.stopWatcher?.();
      await mod.onShutdown();
    }
    this.booted = false;
  }
}

export const moduleRegistry = new ModuleRegistry();
