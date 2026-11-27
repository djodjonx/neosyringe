import type { DependencyGraph, ScopeInput } from '../analyzer/types';

/**
 * Scope inputs of a generated container (topic 18).
 *
 * A container that declares `scopeInputs` is the model of its scopes. It is built unbound (`_inputs` is `undefined`),
 * so `resolve`, `resolveAll`, `resolveMany` and `initialize` refuse with `NEO_SCOPE_INPUTS_UNBOUND`, which names the
 * inputs. `createScope({ values })` checks the whole list against the plan of the class, then builds the one scope
 * that holds the values. A container without inputs gets none of this text: its output is the one it always had.
 *
 * Everything lives in the class (a static plan, three members), so the output adds no top-level name: a name of the
 * user's file, or a second container written into it, can never collide with it. The plan is built once per class,
 * when the class is defined, and never by a scope.
 */

/** The shape `createScope` is typed with in the generated file. The tokens are string ids there. */
const OPTIONS_TYPE = '{ readonly values: readonly { readonly token: unknown; readonly useValue: unknown }[] }';

/** True when the container declares inputs: the graph keeps the whole declared list, pruned or not. */
export function hasScopeInputs(graph: DependencyGraph): boolean {
  return (graph.scopeInputs?.length ?? 0) > 0;
}

/** The input a creator reads, as its slot in the values of a scope. */
export function inputRead(slot: number): string {
  return `this._readInput(${slot})`;
}

/**
 * The first statement of a public member of a container with inputs: the model refuses it. Empty when the
 * container has no input. The text ends with a newline and the indent of a method body.
 */
export function boundGuard(graph: DependencyGraph, operation: string): string {
  return hasScopeInputs(graph) ? `this._assertBound('${operation}');\n    ` : '';
}

/**
 * The refusal of `initialize` on the model: a rejection, as every refusal of `initialize` is, never a throw.
 * Empty when the container has no input.
 */
export function boundInitializeGuard(graph: DependencyGraph): string {
  return hasScopeInputs(graph) ? `if (!this._scope) return Promise.reject(this._unbound('initialize()'));\n    ` : '';
}

function schemaOf(inputs: readonly ScopeInput[]): string {
  return `[${inputs.map((input) => `{ token: ${JSON.stringify(input.tokenId)}, slot: ${input.slot} }`).join(', ')}]`;
}

/**
 * The members a class with inputs adds: the plan, the binding flag, the readers and the refusal of the model. The
 * plan is `{ names, bind }`. `bind(options, fail)` reads `options` once, field by field, and answers the values by slot
 * (a `Map`, so an `undefined` given on purpose is present). It validates everything before it answers: the shape, then
 * each entry in list order (an unknown token, a token twice), then the inputs that are missing, in declared order.
 * `fail` makes the error of the class (`_neoFail`), so the messages and codes are those of every other refusal.
 */
export function inputMembers(graph: DependencyGraph, className: string): string {
  const inputs = graph.scopeInputs ?? [];
  if (inputs.length === 0) return '';
  const invalid = "fail('NEO_SCOPE_INPUTS_INVALID', 'createScope() needs { values: [{ token, useValue }] }')";
  return `private readonly _scope: boolean;

  private static readonly _inputPlan = ${className}._createInputPlan(${schemaOf(inputs)});

  private static _createInputPlan(schema: readonly { readonly token: string; readonly slot: number }[]) {
    const slots = new Map<string, number>(schema.map((rule) => [rule.token, rule.slot]));
    return {
      names: schema.map((rule) => ${className}.formatToken(rule.token)).join(', '),
      bind(options: unknown, fail: (code: string, detail: string) => Error): ReadonlyMap<number, unknown> {
        let list: unknown = [];
        if (options !== undefined) {
          if (typeof options !== 'object' || options === null) throw ${invalid};
          list = Reflect.get(options, 'values') ?? [];
        }
        if (!Array.isArray(list)) throw ${invalid};
        const entries: (readonly [unknown, unknown])[] = [];
        for (const entry of [...list]) {
          if (typeof entry !== 'object' || entry === null) throw ${invalid};
          entries.push([Reflect.get(entry, 'token'), Reflect.get(entry, 'useValue')]);
        }
        const values = new Map<number, unknown>();
        for (const [token, value] of entries) {
          const slot = typeof token === 'string' ? slots.get(token) : undefined;
          if (slot === undefined) throw fail('NEO_SCOPE_INPUT_UNKNOWN', "scope input '" + ${className}.formatToken(token) + "' is not declared");
          if (values.has(slot)) throw fail('NEO_SCOPE_INPUT_DUPLICATE', "scope input '" + ${className}.formatToken(token) + "' is given twice");
          values.set(slot, value);
        }
        const missing = schema.filter((rule) => !values.has(rule.slot)).map((rule) => ${className}.formatToken(rule.token));
        if (missing.length > 0) throw fail('NEO_SCOPE_INPUT_MISSING', 'scope inputs missing: ' + missing.join(', '));
        return values;
      },
    };
  }

  private _unbound(operation: string): Error {
    return this._neoFail('NEO_SCOPE_INPUTS_UNBOUND', operation + ' needs scope inputs: ' + ${className}._inputPlan.names + '; call createScope({ values })');
  }

  private _assertBound(operation: string): void {
    if (!this._scope) throw this._unbound(operation);
  }

  private _readInput(slot: number): unknown {
    return this._inputs?.get(slot);
  }`;
}

/** The constructor of a class with inputs: the third parameter is the values of the scope, absent for the model. */
export function inputConstructor(legacyParentName: string, defaultName = 'NeoContainer'): string {
  return `constructor(
    private legacy?: ${legacyParentName}[],
    private name: string = '${defaultName}',
    private _inputs?: ReadonlyMap<number, unknown>
  ) {
    this._scope = _inputs !== undefined;
  }`;
}

/**
 * `createScope` of a class with inputs. `guard` is the state check every `createScope` makes. The parents come next
 * (a scope of a destroyed parent is refused, as a resolve is), then the plan reads and checks the values before the
 * one `new`: a refused binding builds nothing. A scope never inherits the values of the one it is made from.
 */
export function inputCreateScopeMethod(className: string, guard: string, observation = false): string {
  const build = observation
    ? `const __neoScope = new ${className}(this.legacy, this.name, __neoValues);
    this._neoAdopt(__neoScope);
    return __neoScope;`
    : `return new ${className}(this.legacy, this.name, __neoValues);`;
  return `public createScope(options: ${OPTIONS_TYPE}): ${className} {
    ${guard}
    this._assertParents();
    const __neoValues = ${className}._inputPlan.bind(options, (code, detail) => this._neoFail(code, detail));
    ${build}
  }`;
}

/**
 * The public `destroy` of a class with inputs: the destroy of every class under another name, then the release of
 * the values once the container is closed, so a destroyed scope holds none of them: not the map of the values, and not
 * the values the scope marked as borrowed when it resolved them. A destroy that is refused (`NEO_CONTAINER_BUSY`,
 * during an override) closes nothing, so it releases nothing. The release is attached before the caller can observe
 * the promise.
 */
export function inputDestroyMethod(): string {
  return `public destroy(): Promise<void> {
    const __neoWork = this._destroyScope();
    const __neoRelease = (): void => {
      if (!this._touchClosed(false)) return;
      for (const __neoValue of this._inputs?.values() ?? []) this._borrowed.delete(__neoValue);
      this._inputs = undefined;
    };
    void __neoWork.then(__neoRelease, __neoRelease);
    return __neoWork;
  }`;
}
