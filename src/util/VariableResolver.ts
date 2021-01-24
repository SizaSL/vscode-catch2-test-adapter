import * as pathlib from 'path';

///

function _mapAllStrings(
  value: any /*eslint-disable-line*/,
  parent: any /*eslint-disable-line*/,
  mapperFunc: (s: string, parent: any) => any /*eslint-disable-line*/,
): any /*eslint-disable-line*/ {
  if (value === null) return null;
  switch (typeof value) {
    case 'bigint':
    case 'boolean':
    case 'function':
    case 'number':
    case 'symbol':
    case 'undefined':
      return value;
    case 'string': {
      return mapperFunc(value, parent);
    }
    case 'object': {
      if (Array.isArray(value)) {
        const newValue: any[] = []; /*eslint-disable-line*/
        for (const v of value) {
          const res = _mapAllStrings(v, value, mapperFunc);
          if (res !== undefined) newValue.push(res);
        }
        return newValue;
      } else {
        const newValue = Object.create(Object.getPrototypeOf(value));
        Object.defineProperties(newValue, Object.getOwnPropertyDescriptors(value));
        for (const prop in value) {
          const res = _mapAllStrings(value[prop], value, mapperFunc);
          if (res !== undefined) newValue[prop] = res;
        }
        return newValue;
      }
    }
  }
}

const _flatResolved = Symbol('special value which means that the variable was flat resolved');

async function _mapAllStringsAsync(
  value: Readonly<any> /*eslint-disable-line*/,
  parent: any /*eslint-disable-line*/,
  mapperFunc: (s: string, parent: any) => Promise<any> /*eslint-disable-line*/,
): Promise<any> /*eslint-disable-line*/ {
  if (value === null) return null;
  switch (typeof value) {
    case 'bigint':
    case 'boolean':
    case 'function':
    case 'number':
    case 'symbol':
    case 'undefined':
      return value;
    case 'string': {
      return mapperFunc(value, parent);
    }
    case 'object': {
      if (Array.isArray(value)) {
        const newValue: any[] = []; /*eslint-disable-line*/
        for (const v of value) {
          const res = await _mapAllStringsAsync(v, newValue, mapperFunc);
          if (res !== _flatResolved) newValue.push(res);
        }
        return newValue;
      } else {
        const newValue = Object.create(Object.getPrototypeOf(value));
        Object.defineProperties(newValue, Object.getOwnPropertyDescriptors(value));
        for (const prop in value) {
          const res = await _mapAllStringsAsync(value[prop], newValue, mapperFunc);
          if (res !== _flatResolved) newValue[prop] = res;
          else delete newValue[prop];
        }
        return newValue;
      }
    }
  }
}

function replaceAllString(input: string, resolve: string, rule: string): string {
  let resolved = input;
  let resolved2 = input.replace(resolve, rule);
  while (resolved !== resolved2) {
    resolved = resolved2;
    resolved2 = input.replace(resolve, rule);
  }
  return resolved;
}

async function replaceAllRegExp(
  input: string,
  resolve: RegExp,
  rule: (m: RegExpMatchArray) => Promise<string>,
  firstMatch: RegExpMatchArray,
): Promise<string> {
  let m: RegExpMatchArray | null = firstMatch;
  let remainingStr = input;
  const newStr: string[] = [];

  while (m && m.index !== undefined) {
    newStr.push(remainingStr.substr(0, m.index));

    const ruleV = await rule(m);
    if (typeof ruleV !== 'string') throw Error('resolveVariables regex func return type should be string');
    newStr.push(ruleV);

    remainingStr = remainingStr.substr(m.index + m[0].length);
    m = remainingStr.match(resolve);
  }

  return newStr.join('') + remainingStr;
}

interface ResolveStrRuleStr {
  resolve: string;
  rule: string;
  isFlat?: boolean;
}

interface ResolveStrRuleAsync<R> {
  resolve: string;
  rule: () => Promise<R>;
  isFlat?: boolean;
}

interface ResolveRegexRuleAsync {
  resolve: RegExp;
  rule: (m: RegExpMatchArray) => Promise<string>;
  isFlat?: never;
}

// eslint-disable-next-line
export type ResolveRuleAsync<R = any> = ResolveStrRuleStr | ResolveStrRuleAsync<R> | ResolveRegexRuleAsync;

// eslint-disable-next-line
function resolveVariablesAsync<T>(value: T, varValue: readonly ResolveRuleAsync<any>[]): Promise<T> {
  return _mapAllStringsAsync(
    value,
    undefined,
    // eslint-disable-next-line
    async (s: string, parent: any): Promise<any> => {
      for (let i = 0; i < varValue.length; ++i) {
        const { resolve, rule, isFlat } = varValue[i];

        if (typeof resolve == 'string') {
          if (s === resolve) {
            if (typeof rule == 'string') {
              return rule;
            } else {
              const ruleV = await (rule as () => Promise<any>)(); // eslint-disable-line
              if (isFlat) {
                if (Array.isArray(parent)) {
                  if (Array.isArray(ruleV)) {
                    parent.push(...ruleV);
                    return _flatResolved;
                  }
                } else if (typeof parent === 'object') {
                  if (typeof ruleV === 'object') {
                    Object.assign(parent, ruleV);
                    return _flatResolved;
                  }
                }
                throw Error(
                  `resolveVariablesAsync: coudn't flat-resolve because ${typeof parent} != ${typeof ruleV} for ${s}`,
                );
              } else {
                return ruleV;
              }
            }
          } else if (typeof rule == 'string') {
            s = replaceAllString(s, resolve, rule);
          } else {
            // rule as Function
            if (s.indexOf(resolve) != -1) {
              const ruleV = await (rule as () => Promise<any>)(); // eslint-disable-line
              s = replaceAllString(s, resolve, ruleV);
            }
          }
        } else {
          const ruleF = rule as (m: RegExpMatchArray) => Promise<string>;
          // resolve as RegExp && rule as Function
          // eslint-disable-next-line
          if (rule.length > 1) {
            throw Error('resolveVariables regex func should expect 1 argument');
          }

          const match = s.match(resolve);

          if (match) {
            // whole input matches
            if (match.index === 0 && match[0].length === s.length) {
              return ruleF(match);
            }

            s = await replaceAllRegExp(s, resolve, ruleF, match);
          }
        }
      }

      return Promise.resolve(s);
    },
  );
}

const _normalizedEnvCache: Record<string, string | undefined> =
  process.platform === 'win32'
    ? Object.keys(process.env).reduce((o, key) => Object.assign(o, { [key.toLowerCase()]: process.env[key] }), {})
    : process.env;

function resolveOSEnvironmentVariables<T>(value: T, strictAllowed: boolean): T {
  return _mapAllStrings(value, undefined, (s: string): string | undefined => {
    let replacedS = '';
    while (true) {
      const match = s.match(/\$\{(os_env|os_env_strict):([A-z_][A-z0-9_]*)\}/);

      if (!match) return replacedS + s;

      const envName = process.platform === 'win32' ? match[2].toLowerCase() : match[2];

      const val = _normalizedEnvCache[envName];

      replacedS += s.substring(0, match.index!);

      if (val !== undefined) {
        replacedS += val;
      } else {
        if (match[1] === 'os_env_strict') {
          if (strictAllowed) return undefined;
          else replacedS += '<missing env>';
        } else {
          // skip: replaces to empty string
        }
      }

      s = s.substring(match.index! + match[0].length);
    }
  });
}

const PythonIndexerRegexStr = '(?:\\[(?:(-?[0-9]+)|(-?[0-9]+)?:(-?[0-9]+)?)\\])';

function processArrayWithPythonIndexer<T>(arr: readonly T[], match: RegExpMatchArray): T[] {
  if (match[1]) {
    const idx = Number(match[1]);
    if (idx < 0) return [arr[arr.length + idx]];
    else return [arr[idx]];
  } else {
    const idx1 = match[2] === undefined ? undefined : Number(match[2]);
    const idx2 = match[3] === undefined ? undefined : Number(match[3]);
    return arr.slice(idx1, idx2);
  }
}

export function createPythonIndexerForStringVariable(
  varName: string,
  value: string,
  separator: string | RegExp,
  join: string,
): ResolveRegexRuleAsync {
  const resolve = new RegExp('\\$\\{' + varName + PythonIndexerRegexStr + '?\\}');
  const array = value.split(separator);

  return {
    resolve,
    rule: async (m: RegExpMatchArray): Promise<string> => processArrayWithPythonIndexer(array, m).join(join),
  };
}

export function createPythonIndexerForPathVariable(valName: string, pathStr: string): ResolveRegexRuleAsync {
  const { resolve, rule } = createPythonIndexerForStringVariable(
    valName,
    pathlib.normalize(pathStr),
    /\/|\\/,
    pathlib.sep,
  );

  return {
    resolve,
    rule: async (m: RegExpMatchArray): Promise<string> => {
      try {
        const ruleV = await rule(m);
        return pathlib.normalize(ruleV);
      } catch (e) {
        return m[0];
      }
    },
  };
}

export class VariableResolver {
  public constructor(
    private readonly _resolveRules: ReadonlyArray<ResolveRuleAsync>,
    private readonly _base?: VariableResolver,
  ) {}

  public async resolveAsync<T>(value: T, resolveOSEnvWithStrictAllowed?: boolean): Promise<T> {
    return this.resolveAsyncWithMore<T>(value, resolveOSEnvWithStrictAllowed);
  }

  public async resolveAsyncWithMore<T>(
    value: T,
    resolveOSEnvWithStrictAllowed: boolean | undefined,
    ...more: ResolveRuleAsync[]
  ): Promise<T> {
    let res = value;
    if (resolveOSEnvWithStrictAllowed !== undefined)
      res = resolveOSEnvironmentVariables(res, resolveOSEnvWithStrictAllowed);
    if (more.length > 0) res = await resolveVariablesAsync<T>(res, more);
    res = await resolveVariablesAsync<T>(res, this._resolveRules);
    if (this._base) res = await this._base.resolveAsync(res);
    return res;
  }
}
