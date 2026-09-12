#!/usr/bin/env node
// Builds dist/cara-transfer-<version>.zip containing only the files the extension needs (uses the system `zip`).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';

const version = JSON.parse(readFileSync('manifest.json', 'utf8')).version;
mkdirSync('dist', { recursive: true });
const out = `dist/cara-transfer-${version}.zip`;
rmSync(out, { force: true });
execFileSync('zip', ['-r', out, 'manifest.json', 'src', '_locales', 'icons', '-x', '*.DS_Store'], { stdio: 'inherit' });
console.log('written', out);
