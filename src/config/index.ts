import fs from 'fs';
import path from 'path';
import os from 'os';
import { EngramConfigSchema, defaultConfig, type EngramConfig } from './schema.js';

function resolveDataDir(raw: string): string {
  if (raw.startsWith('~')) return path.join(os.homedir(), raw.slice(1));
  return raw;
}

export function loadConfig(): EngramConfig {
  const configDir = process.env.ENGRAM_CONFIG_DIR
    ? resolveDataDir(process.env.ENGRAM_CONFIG_DIR)
    : path.join(os.homedir(), '.engram');
  const configPath = path.join(configDir, 'config.json');

  if (!fs.existsSync(configPath)) {
    return defaultConfig;
  }

  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const parsed = EngramConfigSchema.parse(raw);
  if (process.env.DATA_DIR) parsed.dataDir = process.env.DATA_DIR;
  return parsed;
}
