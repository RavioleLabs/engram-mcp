import { createLogger } from '../logger.js';
import type { MCPToolDefinition } from '../../memory/core/module-interface.js';

const log = createLogger('tool-router');

export class ToolRouter {
  private tools = new Map<string, MCPToolDefinition>();

  register(tool: MCPToolDefinition): void {
    if (this.tools.has(tool.name)) {
      log.warn(`Tool ${tool.name} re-registered (overwriting)`);
    }
    this.tools.set(tool.name, tool);
  }

  registerMany(tools: MCPToolDefinition[]): void {
    for (const t of tools) this.register(t);
  }

  list(): MCPToolDefinition[] {
    return [...this.tools.values()];
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.handler(args);
  }
}
