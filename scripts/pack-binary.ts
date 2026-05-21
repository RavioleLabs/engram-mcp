#!/usr/bin/env tsx
/**
 * pack-binary.ts — Bundle engram-mcp into 5 self-contained executables.
 *
 * Uses @yao-pkg/pkg (Node 22-compatible fork of vercel/pkg).
 *
 * Targets:
 *   engram-mcp-darwin-arm64
 *   engram-mcp-darwin-x64
 *   engram-mcp-linux-x64
 *   engram-mcp-linux-arm64
 *   engram-mcp-win-x64.exe
 *
 * Run:
 *   npx tsx scripts/pack-binary.ts
 *   # or after `npm run build`:
 *   node scripts/pack-binary.ts  (if built)
 *
 * Output: dist/bin/
 *
 * Requirements:
 *   npm install --save-dev @yao-pkg/pkg
 *   npm run build  (produces dist/scripts/serve.js)
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';

const ROOT    = new URL('..', import.meta.url).pathname;
const DIST    = join(ROOT, 'dist');
const BIN_DIR = join(DIST, 'bin');
const ENTRY   = join(DIST, 'scripts', 'serve.js');

// ── Validate prerequisites ────────────────────────────────────────────────────

if (!existsSync(ENTRY)) {
  console.error(`Entry point not found: ${ENTRY}`);
  console.error('Run `npm run build` first to compile TypeScript.');
  process.exit(1);
}

mkdirSync(BIN_DIR, { recursive: true });

// ── Pkg targets ───────────────────────────────────────────────────────────────

const targets: Array<{ pkgTarget: string; outputName: string }> = [
  { pkgTarget: 'node22-macos-arm64',   outputName: 'engram-mcp-darwin-arm64'  },
  { pkgTarget: 'node22-macos-x64',     outputName: 'engram-mcp-darwin-x64'    },
  { pkgTarget: 'node22-linux-x64',     outputName: 'engram-mcp-linux-x64'     },
  { pkgTarget: 'node22-linux-arm64',   outputName: 'engram-mcp-linux-arm64'   },
  { pkgTarget: 'node22-win-x64',       outputName: 'engram-mcp-win-x64.exe'   },
];

// ── Resolve pkg binary ────────────────────────────────────────────────────────

function findPkg(): string {
  // Try local node_modules first
  const local = join(ROOT, 'node_modules', '.bin', 'pkg');
  if (existsSync(local)) return local;

  // Try npx
  const result = spawnSync('npx', ['--yes', '@yao-pkg/pkg', '--version'], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  if (result.status === 0) return 'npx @yao-pkg/pkg';

  console.error(
    '@yao-pkg/pkg not found. Add it as a devDependency:\n  npm install --save-dev @yao-pkg/pkg'
  );
  process.exit(1);
}

const PKG = findPkg();

// ── pkg.json config (written next to entry) ───────────────────────────────────

// Include all built JS files + native modules
const pkgConfig = {
  pkg: {
    assets: [
      'dist/**/*.json',
      'dist/**/*.node',
    ],
    scripts: [
      'dist/**/*.js',
    ],
  },
};

// Merge into package.json temporarily — pkg reads from there
const pkgJsonPath  = join(ROOT, 'package.json');
const pkgJsonOrig  = readFileSync(pkgJsonPath, 'utf8');
const pkgJsonParsed = JSON.parse(pkgJsonOrig) as Record<string, unknown>;

const merged = { ...pkgJsonParsed, ...pkgConfig };
writeFileSync(pkgJsonPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');

// ── Build each target ─────────────────────────────────────────────────────────

const results: Array<{ name: string; sha256: string; size: number }> = [];

let buildError: unknown = null;

try {
  for (const { pkgTarget, outputName } of targets) {
    const outputPath = join(BIN_DIR, outputName);
    console.log(`\nBuilding ${outputName} (${pkgTarget})...`);

    const cmd = [
      PKG,
      ENTRY,
      '--target', pkgTarget,
      '--output', outputPath,
      '--compress', 'GZip',
    ].join(' ');

    try {
      execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
    } catch (err) {
      console.error(`Failed to build ${outputName}:`, err);
      throw err;
    }

    // Generate .sha256 sidecar
    const buf      = readFileSync(outputPath);
    const sha256   = createHash('sha256').update(buf).digest('hex');
    const sha256Path = `${outputPath}.sha256`;
    writeFileSync(sha256Path, `${sha256}  ${outputName}\n`, 'utf8');

    results.push({ name: outputName, sha256, size: buf.length });
    console.log(`  ${outputName} (${(buf.length / 1024 / 1024).toFixed(1)} MB)  sha256: ${sha256}`);
  }
} catch (err) {
  buildError = err;
} finally {
  // Restore original package.json
  writeFileSync(pkgJsonPath, pkgJsonOrig, 'utf8');
}

if (buildError) {
  console.error('\nBuild failed. package.json restored.');
  process.exit(1);
}

// ── Write manifest ────────────────────────────────────────────────────────────

const manifestPath = join(BIN_DIR, 'manifest.json');
writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      binaries: results.map((r) => ({
        name:   r.name,
        sha256: r.sha256,
        bytes:  r.size,
      })),
    },
    null,
    2
  ) + '\n',
  'utf8'
);

console.log(`\nAll binaries built to ${BIN_DIR}`);
console.log(`Manifest: ${manifestPath}`);
