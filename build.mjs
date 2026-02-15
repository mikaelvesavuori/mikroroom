#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, watch as fsWatch } from 'node:fs';
import { build } from 'esbuild';
import { minify } from 'html-minifier-terser';
import { transform } from 'lightningcss';

///////////////////
// CONFIGURATION //
///////////////////

const getPackageVersion = () =>
  JSON.parse(readFileSync('./package.json', 'utf-8')).version;

const packageVersion = getPackageVersion();

const config = {
  version: packageVersion,
  dirs: {
    app: 'dist/app',
    api: 'dist/api',
    static: 'static',
    src: {
      app: './src/app/index.ts',
      api: './src/api/index.ts',
      css: './static/style.css',
      html: './static/index.html',
      config: './static/mikroroom.config.json'
    }
  },
  esbuild: {
    app: {
      entryPoints: ['./src/app/index.ts'],
      outfile: 'dist/app/app.js',
      bundle: true,
      format: 'iife',
      target: ['chrome139', 'safari18', 'edge143'],
      platform: 'browser',
      treeShaking: true
    },
    api: {
      entryPoints: ['./src/api/index.ts'],
      outfile: 'dist/api/mikroroom.mjs',
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      treeShaking: true,
      external: ['esbuild']
    }
  }
};

/////////////////////
// BUILD FUNCTIONS //
/////////////////////

/**
 * Build app JavaScript bundle
 */
export async function buildApp(options = {}) {
  const { minify: shouldMinify = true, sourcemap = false } = options;

  console.log('📦 Building app bundle...');

  await build({
    ...config.esbuild.app,
    minify: shouldMinify,
    sourcemap: sourcemap ? 'inline' : false,
    banner: {
      js: `/* MikroRoom v${config.version} | ${new Date().toISOString()} */`
    }
  });

  console.log('✅ App bundle created: dist/app/app.js');
}

/**
 * Build api JavaScript bundle
 */
export async function buildApi(options = {}) {
  const { minify: shouldMinify = true, sourcemap = false } = options;

  console.log('📦 Building API bundle...');

  await build({
    ...config.esbuild.api,
    minify: shouldMinify,
    sourcemap: sourcemap ? 'inline' : false,
    banner: {
      js: `/* MikroRoom API v${config.version} | ${new Date().toISOString()} */`
    }
  });

  console.log('✅ API bundle created: dist/api/mikroroom.mjs');
}

/**
 * Process CSS with Lightning CSS
 */
export async function buildCSS(options = {}) {
  const { minify: shouldMinify = true } = options;

  console.log('🎨 Processing CSS...');

  const cssInput = readFileSync(config.dirs.src.css);

  const { code } = transform({
    filename: 'style.css',
    code: cssInput,
    minify: shouldMinify,
    sourceMap: false
  });

  writeFileSync('./dist/app/style.css', code);
  console.log('✅ CSS processed: dist/app/style.css');
}

/**
 * Process and minify HTML
 */
export async function buildHTML(options = {}) {
  const { minify: shouldMinify = true } = options;

  console.log('🌐 Processing HTML...');

  const html = readFileSync(config.dirs.src.html, 'utf8');

  if (shouldMinify) {
    const minified = await minify(html, {
      collapseWhitespace: true,
      removeComments: true,
      minifyCSS: false,
      minifyJS: false
    });
    writeFileSync('./dist/app/index.html', minified);
  } else {
    writeFileSync('./dist/app/index.html', html);
  }

  console.log('✅ HTML processed: dist/app/index.html');
}

/**
 * Copy static assets
 */
export function copyAssets() {
  console.log('📂 Copying static assets...');

  const configSrc = config.dirs.src.config;
  const configDest = './dist/app/mikroroom.config.json';

  if (existsSync(configSrc)) {
    copyFileSync(configSrc, configDest);
    console.log('✅ Config copied: dist/app/mikroroom.config.json');
  } else {
    console.warn('⚠️  Config file not found:', configSrc);
  }
}

/**
 * Ensure output directories exist
 */
function ensureDirectories() {
  mkdirSync(config.dirs.app, { recursive: true });
  mkdirSync(config.dirs.api, { recursive: true });
}

/////////////////////////
// ORCHESTRATION TASKS //
/////////////////////////

/**
 * Build everything
 */
export async function buildAll(options = {}) {
  console.log(`\n🚀 Building MikroRoom v${config.version}...`);
  console.log(`Mode: ${options.minify === false ? 'Development' : 'Production'}\n`);

  ensureDirectories();
  const startTime = Date.now();

  await buildApp(options);
  await buildApi(options);
  await buildCSS(options);
  await buildHTML(options);
  copyAssets();

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n✨ Build completed in ${duration}s`);
  console.log('\n📁 Output:');
  console.log('  - dist/app/app.js');
  console.log('  - dist/app/style.css');
  console.log('  - dist/app/index.html');
  console.log('  - dist/app/mikroroom.config.json');
  console.log('  - dist/api/mikroroom.mjs');
}

/**
 * Watch mode - rebuild on file changes
 */
export async function watchMode(options = {}) {
  console.log('\n👀 Watch mode enabled...\n');

  // Initial build
  await buildAll(options);

  console.log('\n🔍 Watching for changes...\n');

  // Watch app files
  fsWatch('./src/app', { recursive: true }, async (_eventType, filename) => {
    if (filename?.endsWith('.ts') || filename?.endsWith('.js')) {
      console.log(`🔄 App file changed: ${filename}`);
      await buildApp(options).catch(console.error);
    }
  });

  // Watch api files
  fsWatch('./src/api', { recursive: true }, async (_eventType, filename) => {
    if (filename?.endsWith('.ts') || filename?.endsWith('.js')) {
      console.log(`🔄 API file changed: ${filename}`);
      await buildApi(options).catch(console.error);
    }
  });

  // Watch static files
  fsWatch('./static', { recursive: true }, async (_eventType, filename) => {
    console.log(`🔄 Static file changed: ${filename}`);
    if (filename?.endsWith('.css')) await buildCSS(options).catch(console.error);
    else if (filename?.endsWith('.html')) await buildHTML(options).catch(console.error);
    else if (filename?.endsWith('.json')) copyAssets();
  });

  console.log('Press Ctrl+C to stop watching\n');
}

///////////////////
// CLI INTERFACE //
///////////////////

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);

  // Parse arguments
  const isDev = args.includes('--dev');
  const isWatch = args.includes('--watch');
  const target = args.find(arg => ['--app', '--api', '--css', '--html', '--assets'].includes(arg));

  const buildOptions = {
    minify: !isDev,
    sourcemap: isDev
  };

  try {
    if (isWatch) {
      await watchMode(buildOptions);
    } else if (target) {
      ensureDirectories();

      switch (target) {
        case '--app':
          await buildApp(buildOptions);
          break;
        case '--api':
          await buildApi(buildOptions);
          break;
        case '--css':
          await buildCSS(buildOptions);
          break;
        case '--html':
          await buildHTML(buildOptions);
          break;
        case '--assets':
          copyAssets();
          break;
      }
    } else {
      await buildAll(buildOptions);
    }
  } catch (error) {
    console.error('\n❌ Build failed:', error);
    process.exit(1);
  }
}
