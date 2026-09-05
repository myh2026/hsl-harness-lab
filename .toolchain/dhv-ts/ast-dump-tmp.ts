import { Lexer } from './src/lexer';
import { Parser } from './src/parser';
import * as fs from 'node:fs';

const file = process.argv[2]!;
const src = fs.readFileSync(file, 'utf-8');
const toks = new Lexer(src, file).tokenize();
const parser = new Parser(toks, file);
const ast = parser.parseFile();
const out = JSON.stringify(ast, (k: string, v: unknown) => (k === 'span' ? undefined : v), 1);
fs.writeFileSync('/tmp/hsl-probe/ast.json', out);
console.log('items:', (ast.items as any[]).map((i: any) => i.kind + ':' + (i.fn?.name ?? i.struct?.name ?? '')).join(', '));
