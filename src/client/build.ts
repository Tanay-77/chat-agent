import * as esbuild from 'esbuild';
import path from 'node:path';

export async function buildClient(minify: boolean = false): Promise<void> {
  const entryPoint = path.resolve(process.cwd(), 'src/client/main.tsx');
  const outfile = path.resolve(process.cwd(), 'public/bundle.js');

  console.log('[Client Builder] Compiling React application...');
  await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    outfile,
    minify,
    sourcemap: true,
    target: ['es2022'],
    format: 'esm',
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production')
    }
  });
  console.log('[Client Builder] Successfully bundled React frontend -> public/bundle.js');
}

// CLI invocation support
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('build.ts')) {
  buildClient(true).catch((err) => {
    console.error('[Client Builder Error]:', err);
    process.exit(1);
  });
}

