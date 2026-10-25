#!/usr/bin/env node
// 范围门：全新重做版不得出现冻结清单外的旧功能标识。
// 命中即失败（退出码 1）。只扫文本文件，跳过二进制与依赖目录。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOTS = ['src', 'android/app/src/main/java', 'android/app/src/main/res'];
const TEXT_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.css', '.html', '.java', '.kt', '.xml', '.gradle', '.json', '.md']);
const BANNED = ['spotify', 'librespot', 'qqmusic', 'kugou', 'bodian', 'qishui', 'sleep timer', 'com.suanran.folia'];

const hits = [];
function walk(dir) {
    let entries;
    try {
        entries = readdirSync(dir);
    } catch {
        return;
    }
    for (const entry of entries) {
        const path = join(dir, entry);
        let st;
        try {
            st = statSync(path);
        } catch {
            continue;
        }
        if (st.isDirectory()) {
            walk(path);
        } else if (TEXT_EXTS.has(extname(path))) {
            const text = readFileSync(path, 'utf8').toLowerCase();
            for (const word of BANNED) {
                if (text.includes(word)) {
                    hits.push(path + ' :: ' + word);
                }
            }
        }
    }
}

for (const root of ROOTS) {
    walk(root);
}

if (hits.length > 0) {
    console.error('scope gate failed:');
    for (const hit of hits) {
        console.error('  ' + hit);
    }
    process.exit(1);
}
console.log('scope gate passed');
