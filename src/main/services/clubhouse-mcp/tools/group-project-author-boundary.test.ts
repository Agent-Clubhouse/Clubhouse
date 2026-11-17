/** Structural regression guard: agent mutations must never silently become computer housekeeping. */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

const optionsAt: Record<string, number> = {
  // The management add/exclude pair invokes its selected membership function through this local variable.
  operation: 2,
  addGroupMember: 2,
  excludeGroupMember: 2,
  'membership.addMember': 2,
  'membership.excludeMember': 2,
  'membership.answerAutoJoinOffer': 2,
  'membership.recordMemberDisabledTools': 3,
  'groupProjectHost.post': 4,
  'groupProjectHost.update': 2,
  'groupProjectHost.deleteMessage': 3,
  'groupProjectHost.deleteTopic': 2,
  'groupProjectHost.setTopicProtected': 3,
  'groupProjectHost.updateMembership': 2,
  addGroupMember: 2,
  excludeGroupMember: 2,
  'membership.addMember': 2,
  'membership.excludeMember': 2,
  'membership.answerAutoJoinOffer': 2,
  'membership.recordMemberDisabledTools': 3,
  // The management module's add/exclude pair is invoked through this local function variable.
  operation: 2,
};
const reads = new Set(['outOfScopeMessage', 'inScope', 'selfMachine', 'list', 'scopeOptions', 'get', 'operations', 'previewScope', 'isReplica', 'estimateTrim', 'readDigest', 'readTopic', 'getMessage', 'isThisMachine', 'resolveMembers']);
const hostOnly = new Set(['setScope', 'exclusive', 'setRetention', 'clearAll', 'dismissRefusals']);
/** Existing service-level exceptions are explicit mechanics work, not compliant new admin mutations. */
const serviceExceptions = {
  setProjectPolling: '#3664: legacy polling omits agent author; Mac Mini mechanics owner',
  setTopicSubscription: 'Legacy caller-only subscription policy uses own-machine per-address housekeeping; no admin mutation',
};
function calls(source: ts.SourceFile): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => { if (ts.isCallExpression(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(source);
  return found;
}
function authenticatedAuthor(node: ts.Expression, source: ts.SourceFile): boolean {
  if (ts.isCallExpression(node)) return node.expression.getText(source) === 'author' && node.arguments.length === 1 && node.arguments[0].getText(source) === 'caller';
  if (!ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some((p) => {
    if (ts.isShorthandPropertyAssignment(p)) return p.name.text === 'agentId';
    return ts.isPropertyAssignment(p) && p.name.getText(source) === 'agentId' && ts.isIdentifier(p.initializer) && ['caller', 'callerId', 'agentId'].includes(p.initializer.text);
  });
}
function missingAuthors(text: string, file: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const missing: string[] = [];
  const inspectReferences = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === 'groupProjectHost' && optionsAt[node.getText(source)] !== undefined
      && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) missing.push(`${file}: do not alias ${node.getText(source)}; keep its explicit author at the MCP boundary`);
    ts.forEachChild(node, inspectReferences);
  };
  inspectReferences(source);
  for (const call of calls(source)) {
    const name = call.expression.getText(source);
    const property = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : undefined;
    let index = optionsAt[name];
    if (property === 'setOwnGrant') index = 3;
    if (ts.isPropertyAccessExpression(call.expression) && call.expression.expression.getText(source) === 'groupProjectHost' && index === undefined && !reads.has(property!) && !hostOnly.has(property!)) {
      missing.push(`${file}: unclassified host call ${name}`);
    }
    if (index === undefined) continue;
    const options = call.arguments[index];
    if (!options || !ts.isObjectLiteralExpression(options) || !options.properties.some((p) => ts.isPropertyAssignment(p) && p.name.getText(source) === 'author' && authenticatedAuthor(p.initializer, source))) {
      missing.push(`${file}:${source.getLineAndCharacterOfPosition(call.getStart()).line + 1} ${name} needs an explicit author`);
    }
  }
  return missing;
}
const toolsDir = path.join(process.cwd(), 'src/main/services/clubhouse-mcp/tools');

describe('Group Project agent author boundary (#3617)', () => {
  it('requires an explicit author on every direct forwardable GP MCP mutation', () => {
    const files = fs.readdirSync(toolsDir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));
    const failures = files.flatMap((file) => missingAuthors(fs.readFileSync(path.join(toolsDir, file), 'utf8'), file));
    expect(failures).toEqual([]);
  });
  it('fails the guard when an author argument is removed or a host method is unclassified', () => {
    expect(missingAuthors('groupProjectHost.update(id, fields)', 'omission.ts')).toHaveLength(1);
    expect(missingAuthors('membership.addMember(id, member)', 'omission.ts')).toHaveLength(1);
    expect(missingAuthors('groupProjectHost.update(id, fields, {author: undefined})', 'undefined.ts')).toHaveLength(1);
    expect(missingAuthors('groupProjectHost.update(id, fields, {author: args.author})', 'spoof.ts')).toHaveLength(1);
    expect(missingAuthors('const write = groupProjectHost.update; write(id, fields)', 'alias.ts')).toHaveLength(1);
    expect(missingAuthors('groupProjectHost.newWrite(id)', 'new.ts')).toEqual(['new.ts: unclassified host call groupProjectHost.newWrite']);
    expect(missingAuthors('groupProjectHost.update(id, fields, {author: {agentId: caller, label: caller}})', 'explicit.ts')).toEqual([]);
  });
  it('keeps UI/system omissions and known legacy exceptions explicitly separate', () => {
    const board = fs.readFileSync(path.join(toolsDir, 'group-project-tools.ts'), 'utf8');
    expect(Object.keys(serviceExceptions)).toEqual(['setProjectPolling', 'setTopicSubscription']);
    for (const name of Object.keys(serviceExceptions)) expect(board).toContain(`${name}(`);
    const management = fs.readFileSync(path.join(toolsDir, 'group-project-management-tools.ts'), 'utf8');
    for (const name of Object.keys(serviceExceptions)) expect(management).not.toContain(`${name}(`);
    const host = fs.readFileSync(path.join(toolsDir, '../../group-project-host.ts'), 'utf8');
    expect(host).toContain("options.author ?? { label: 'membership' }");
  });
  it('keeps the shared membership/own-grant wrappers forwarding caller options on every write', () => {
    const expectations: Record<string, string[]> = {
      'group-project-membership.ts': ['addMember', 'excludeMember', 'answerAutoJoinOffer', 'recordMemberDisabledTools'],
      'group-project-roles.ts': ['setOwnGrant'],
    };
    for (const [file, functions] of Object.entries(expectations)) {
      const source = ts.createSourceFile(file, fs.readFileSync(path.join(toolsDir, '../..', file), 'utf8'), ts.ScriptTarget.Latest, true);
      for (const name of functions) {
        const fn = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
        expect(fn, `${file}:${name}`).toBeTruthy();
        const writes: ts.CallExpression[] = [];
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node) && ['groupProjectHost.update', 'groupProjectHost.updateMembership'].includes(node.expression.getText(source))) writes.push(node);
          ts.forEachChild(node, visit);
        };
        visit(fn);
        expect(writes.length).toBeGreaterThan(0);
        for (const write of writes) expect(write.arguments[2]?.getText(source), `${file}:${name}`).toBe('options');
      }
    }
  });
  it('separates existing service exceptions and host-only operations from new forwardable admin mutations', () => {
    expect(serviceExceptions.setProjectPolling).toContain('#3664');
    expect(serviceExceptions.setTopicSubscription).toContain('caller-only');
    const source = fs.readFileSync(path.join(toolsDir, 'group-project-management-tools.ts'), 'utf8');
    for (const name of Object.keys(serviceExceptions)) expect(source).not.toContain(`${name}(`);
    expect(hostOnly.has('setScope')).toBe(true);
    expect(hostOnly.has('update')).toBe(false);
  });
});
