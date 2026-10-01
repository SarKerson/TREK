/**
 * libsql-js 0.5.29's remote statement reports no parameter metadata, so its
 * object-binding path silently sends an empty named_args array. Translate SQL
 * parameter tokens to numbered positional slots before native preparation.
 * Preserve SQLite slot numbering, including repeated names and ?NNN, so callers
 * that already supply positional values retain their existing semantics.
 */
export function compileSqlBindings(source: string): { sql: string; bind(params: unknown[]): unknown[] } {
  const names: (string | undefined)[] = [];
  const slots = new Map<string, number>();
  let sql = '';
  let index = 0;
  const isNameChar = (char: string | undefined) => !!char && (/[A-Za-z0-9_$]/.test(char) || char.charCodeAt(0) >= 128);
  while (index < source.length) {
    const start = index;
    const char = source[index++];
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const end = char === '[' ? ']' : char;
      while (index < source.length) {
        if (source[index++] !== end) continue;
        if (char !== '[' && source[index] === end) { index++; continue; }
        break;
      }
    } else if (char === '-' && source[index] === '-') {
      while (index < source.length && source[index] !== '\n') index++;
    } else if (char === '/' && source[index] === '*') {
      const end = source.indexOf('*/', index + 1);
      index = end < 0 ? source.length : end + 2;
    } else if (/[A-Za-z_]/.test(char) || char.charCodeAt(0) >= 128) {
      // '$' is legal within a bare SQLite identifier, not a parameter there.
      while (isNameChar(source[index])) index++;
    } else if (char === '?') {
      while (/[0-9]/.test(source[index] ?? '')) index++;
      const explicit = source.slice(start + 1, index);
      const slot = explicit ? Number(explicit) : names.length + 1;
      if (!Number.isSafeInteger(slot) || slot < 1 || slot > 32766) throw new Error('Invalid SQLite parameter index');
      while (names.length < slot) names.push(undefined);
    } else if ((char === ':' || char === '@' || char === '$') && isNameChar(source[index])) {
      while (isNameChar(source[index])) index++;
      // Tcl-style $name::suffix(...) is not used by TREK. Refuse it explicitly
      // rather than transform only part of a parameter into different SQL.
      if (char === '$' && (source.slice(index, index + 2) === '::' || source[index] === '(')) {
        throw new Error('Unsupported SQLite named parameter form');
      }
      const token = source.slice(start, index);
      let slot = slots.get(token);
      if (slot === undefined) {
        slot = names.length + 1;
        slots.set(token, slot);
        names.push(token.slice(1));
      }
      sql += `?${slot}`;
      continue;
    }
    sql += source.slice(start, index);
  }
  return {
    sql,
    bind(params) {
      const first = params[0];
      if (params.length === 1 && first !== null && typeof first === 'object'
        && !Array.isArray(first) && !ArrayBuffer.isView(first)) {
        const values = first as Record<string, unknown>;
        return [names.map(name => {
          if (name === undefined) throw new Error('Named bindings cannot supply anonymous SQLite parameters');
          if (!Object.prototype.hasOwnProperty.call(values, name)) throw new Error(`Missing named SQLite parameter: ${name}`);
          return values[name];
        })];
      }
      // Native libsql mistakes sole null/Buffer values for named maps unless
      // all positional arguments are explicitly grouped inside one array.
      return [params.flat()];
    },
  };
}
