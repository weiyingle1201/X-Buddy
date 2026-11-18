// 生成单文件版本：把 Vite 构建产物中的 JS/CSS 内联进一个 HTML
// 用法：npm run build:single → dist-single/x-buddy.html（完整页面）与 dist-single/body.html（无 <html>/<head> 外壳的片段）
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

execSync('npx vite build --outDir dist-tmp --base ./', { stdio: 'inherit' });
const html = readFileSync('dist-tmp/index.html', 'utf8');
const js = html.match(/<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>/);
const css = html.match(/<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+\.css)">/);
if (!js || !css) throw new Error('未找到构建产物引用');
const jsText = readFileSync(join('dist-tmp', js[1]), 'utf8').replace(/<\/script/gi, '<\\/script');
const cssText = readFileSync(join('dist-tmp', css[1]), 'utf8');
const title = '<title>X-Buddy 投资研究工作台</title>';
const body = `${title}\n<style>${cssText}</style>\n<div id="root"></div>\n<script type="module">${jsText}</script>\n`;
mkdirSync('dist-single', { recursive: true });
writeFileSync('dist-single/body.html', body);
writeFileSync('dist-single/x-buddy.html', `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n${title}\n<style>${cssText}</style>\n</head>\n<body>\n<div id="root"></div>\n<script type="module">${jsText}</script>\n</body>\n</html>\n`);
execSync('rm -rf dist-tmp');
console.log('dist-single/x-buddy.html', (readFileSync('dist-single/x-buddy.html').length / 1024).toFixed(0), 'KB');
