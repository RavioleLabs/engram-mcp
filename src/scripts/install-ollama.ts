/**
 * OS-aware Ollama installer. Auto-runs the canonical install command for the
 * detected platform. Always requires user-explicit consent (caller prompts).
 *
 *   macOS:    brew install ollama (fallback: print DMG URL)
 *   Linux:    curl -fsSL https://ollama.com/install.sh | sh
 *   Windows:  winget install Ollama.Ollama (fallback: print .exe URL)
 */
import { spawnSync, spawn } from 'child_process';
import os from 'os';

export function isOllamaInstalled(): boolean {
  const r = spawnSync('ollama', ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

export async function installOllama(): Promise<void> {
  const platform = os.platform();
  console.log(`\nDetected platform: ${platform}`);

  if (platform === 'darwin') {
    await installMac();
  } else if (platform === 'linux') {
    await installLinux();
  } else if (platform === 'win32') {
    await installWindows();
  } else {
    throw new Error(
      `Unsupported platform ${platform}. Install Ollama manually from https://ollama.com/download.`,
    );
  }

  // Start the daemon
  console.log('\nStarting Ollama server in background…');
  const child = spawn('ollama', ['serve'], { stdio: 'ignore', detached: true });
  child.unref();
  await new Promise((r) => setTimeout(r, 2000));
}

async function installMac(): Promise<void> {
  // Prefer brew if available
  const brewOk = spawnSync('which', ['brew'], { stdio: 'ignore' }).status === 0;
  if (brewOk) {
    console.log('Installing via Homebrew: brew install ollama');
    const r = spawnSync('brew', ['install', 'ollama'], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('brew install ollama failed');
    return;
  }
  console.log(
    '\nHomebrew not detected. Download the macOS app from https://ollama.com/download/Ollama-darwin.zip',
  );
  console.log('Unzip and move Ollama.app to /Applications, then re-run this installer.');
  process.exit(0);
}

async function installLinux(): Promise<void> {
  console.log('Installing via official script: curl -fsSL https://ollama.com/install.sh | sh');
  const r = spawnSync('sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], {
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error('Ollama install script failed');
}

async function installWindows(): Promise<void> {
  // winget is available on Win10 19H1+ / Win11
  const wingetOk = spawnSync('winget', ['--version'], { stdio: 'ignore' }).status === 0;
  if (wingetOk) {
    console.log('Installing via winget: winget install Ollama.Ollama');
    const r = spawnSync(
      'winget',
      [
        'install',
        '--id',
        'Ollama.Ollama',
        '--accept-source-agreements',
        '--accept-package-agreements',
      ],
      { stdio: 'inherit' },
    );
    if (r.status !== 0) throw new Error('winget install Ollama failed');
    return;
  }
  console.log(
    '\nWinget not available. Download Ollama for Windows: https://ollama.com/download/OllamaSetup.exe',
  );
  console.log('Run the installer, then re-run this wizard.');
  process.exit(0);
}
