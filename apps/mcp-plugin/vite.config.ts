import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

// Build id reported by get_project_info (plugin_build), so you can confirm Blockbench
// loaded THIS build after a rebuild: "<version>+<UTC yyyymmdd.hhmm>.<git sha>".
const version: string = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version;
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '.').slice(0, 13);
let sha = 'nogit';
try {
  sha = execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  if (execSync('git status --porcelain', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()) sha += '-dirty';
} catch {}

export default defineConfig({
  define: {
    __PLUGIN_VERSION__: JSON.stringify(version),
    __PLUGIN_BUILD__: JSON.stringify(`${version}+${stamp}.${sha}`),
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/mcp_socketio_plugin.ts'),
      formats: ['iife'],
      name: 'BlockbenchMcpPlugin',
      fileName: () => 'mcp_socketio_plugin.js'
    },
    outDir: 'dist',
    emptyOutDir: true
  }
});
