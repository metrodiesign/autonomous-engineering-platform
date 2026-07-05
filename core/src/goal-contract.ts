// Goal Contract (§11.1) — frozen, versioned artifact at .ai/goal.yaml.
// Vendor-neutral (INV-7). Dependency-free: a tiny block-YAML subset parser
// sufficient for the §11.1 template (scalars, nested maps, string lists, list-of-maps).

export type YamlScalar = string | number | boolean;
export type YamlValue = YamlScalar | null | YamlValue[] | { [k: string]: YamlValue };

export interface AcceptanceCriterion {
  id: string;
  description?: string;
  verification?: string;
  golden?: boolean;
}

export interface GoalContract {
  version?: number;
  goal?: { id?: string; title?: string; objective?: string };
  business_outcomes?: string[];
  scope?: { include?: string[]; exclude?: string[] };
  constraints?: { stack?: Record<string, string>; forbidden?: string[] };
  acceptance_criteria?: AcceptanceCriterion[];
  quality_gates?: Record<string, YamlValue>;
  budget?: Record<string, number>;
  approval_policy?: { require_human_approval?: string[] };
}

interface Line {
  indent: number;
  content: string; // after any leading spaces and any leading "- "
  isItem: boolean; // line began with "- "
}

function toScalar(raw: string): YamlScalar {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

function tokenize(text: string): Line[] {
  const lines: Line[] = [];
  for (const raw of text.split('\n')) {
    // strip inline comments (space before '#'); ignore full-line comments and blanks
    const stripped = raw.replace(/\s+#.*$/, '');
    if (stripped.trim() === '' || stripped.trimStart().startsWith('#')) continue;
    const indent = stripped.length - stripped.trimStart().length;
    let content = stripped.trimStart();
    const isItem = content.startsWith('- ') || content === '-';
    if (isItem) content = content === '-' ? '' : content.slice(2);
    lines.push({ indent, content, isItem });
  }
  return lines;
}

// Parse a map whose entries sit at exactly `indent`; deeper lines belong to values.
function parseMap(lines: Line[], start: number, indent: number): [Record<string, YamlValue>, number] {
  const obj: Record<string, YamlValue> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent || (line.indent === indent && line.isItem)) break;
    if (line.indent > indent) break; // defensive: deeper lines consumed by recursion
    const m = line.content.match(/^([^:]+):(?:\s+(.*))?$/);
    if (!m) break;
    const key = m[1]!.trim();
    const inline = m[2];
    if (inline !== undefined && inline !== '') {
      obj[key] = toScalar(inline);
      i++;
    } else if (i + 1 < lines.length && lines[i + 1]!.indent > indent) {
      const [value, next] = parseNode(lines, i + 1, lines[i + 1]!.indent);
      obj[key] = value;
      i = next;
    } else {
      obj[key] = null;
      i++;
    }
  }
  return [obj, i];
}

// Parse a list whose items sit at exactly `indent`. Items are scalars, or maps
// beginning inline on the "- key: value" line.
function parseList(lines: Line[], start: number, indent: number): [YamlValue[], number] {
  const arr: YamlValue[] = [];
  let i = start;
  while (i < lines.length && lines[i]!.isItem && lines[i]!.indent === indent) {
    const item = lines[i]!;
    if (item.content === '') {
      // nested block under the "-"
      const child = i + 1 < lines.length ? lines[i + 1]!.indent : indent + 2;
      const [value, next] = parseNode(lines, i + 1, child);
      arr.push(value);
      i = next;
    } else if (/^[^:]+:(\s|$)/.test(item.content)) {
      // map item: synthesize the inline "key: value" as the first line at indent+2
      const childIndent = indent + 2;
      const synth: Line[] = [{ indent: childIndent, content: item.content, isItem: false }];
      let j = i + 1;
      while (j < lines.length && lines[j]!.indent >= childIndent) {
        synth.push(lines[j]!);
        j++;
      }
      const [value] = parseMap(synth, 0, childIndent);
      arr.push(value);
      i = j;
    } else {
      arr.push(toScalar(item.content));
      i++;
    }
  }
  return [arr, i];
}

function parseNode(lines: Line[], start: number, indent: number): [YamlValue, number] {
  if (lines[start]!.isItem && lines[start]!.indent === indent) return parseList(lines, start, indent);
  return parseMap(lines, start, indent);
}

/** Parse a block-YAML subset into a plain object. Sufficient for the §11.1 template. */
export function parseYaml(text: string): Record<string, YamlValue> {
  const lines = tokenize(text);
  if (lines.length === 0) return {};
  const [value] = parseMap(lines, 0, lines[0]!.indent);
  return value;
}

export function parseGoalContract(text: string): GoalContract {
  return parseYaml(text) as GoalContract;
}

/** List missing required fields (§11.1): goal.id, goal.title, acceptance_criteria (non-empty), budget, approval_policy. */
export function validateGoalContract(c: GoalContract): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!c.goal?.id) missing.push('goal.id');
  if (!c.goal?.title) missing.push('goal.title');
  if (!Array.isArray(c.acceptance_criteria) || c.acceptance_criteria.length === 0) missing.push('acceptance_criteria');
  if (!c.budget || typeof c.budget !== 'object') missing.push('budget');
  if (!c.approval_policy || typeof c.approval_policy !== 'object') missing.push('approval_policy');
  return { ok: missing.length === 0, missing };
}
