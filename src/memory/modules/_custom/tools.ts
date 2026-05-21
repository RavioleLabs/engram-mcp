// src/memory/modules/_custom/tools.ts
import { createLogger } from '../../../logger.js';
import type { MCPToolDefinition } from '../../core/module-interface.js';
import type { MemoryStore } from '../../core/store.js';
import type { EngramConfig } from '../../../config/schema.js';
import { moduleRegistry } from '../../core/module-registry.js';
import { ToolRouter } from '../../../mcp-server/tool-router.js';
import {
  createCustomType,
  listCustomTypes,
  deleteCustomType,
  type CustomTypeDefinition,
} from './persistence.js';
import { createGenericModule, buildGenericModuleTools } from './generic-module.js';

const log = createLogger('custom:tools');

export function buildCustomTypeTools(
  store: MemoryStore,
  config: EngramConfig,
  router: ToolRouter,
): MCPToolDefinition[] {
  return [
    {
      name: 'create_custom_type',
      description:
        'Create a new user-defined memory type at runtime. Auto-exposes add_<name> and search_<name> tools. Name must be lowercase snake_case.',
      inputSchema: {
        type: 'object',
        properties: {
          type_name: { type: 'string', description: 'lowercase, snake_case, [a-z0-9_]' },
          display_name: { type: 'string' },
          schema: {
            type: 'object',
            description: 'Optional JSON Schema for the custom-properties field.',
          },
        },
        required: ['type_name', 'display_name'],
      },
      handler: async (args) => {
        const def = createCustomType({
          type_name: args.type_name as string,
          display_name: args.display_name as string,
          schema: args.schema as object | undefined,
        });
        const mod = createGenericModule(def, config);
        moduleRegistry.register(mod);
        await mod.onBoot({ store });
        const tools = buildGenericModuleTools(def, store, config);
        router.registerMany(tools);
        log.info(
          `Live-registered custom type ${def.type_name} with tools ${tools.map((t) => t.name).join(', ')}`,
        );
        return { type_name: def.type_name, tools: tools.map((t) => t.name) };
      },
    },
    {
      name: 'list_custom_types',
      description: 'List user-defined memory types.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        return listCustomTypes();
      },
    },
    {
      name: 'delete_custom_type',
      description:
        'Delete a custom type definition. Does NOT delete the memories already stored under that type; existing memories remain searchable.',
      inputSchema: {
        type: 'object',
        properties: { type_name: { type: 'string' } },
        required: ['type_name'],
      },
      handler: async (args) => {
        deleteCustomType(args.type_name as string);
        return { deleted: args.type_name };
      },
    },
  ];
}

export function loadAndRegisterCustomTypes(
  store: MemoryStore,
  config: EngramConfig,
  router: ToolRouter,
): void {
  const defs: CustomTypeDefinition[] = listCustomTypes();
  for (const def of defs) {
    const mod = createGenericModule(def, config);
    moduleRegistry.register(mod);
    void mod.onBoot({ store });
    router.registerMany(buildGenericModuleTools(def, store, config));
    log.info(`Loaded custom type at boot: ${def.type_name}`);
  }
}
