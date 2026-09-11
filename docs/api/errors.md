# Error Reference

All errors reported by NeoSyringe — in the IDE, the CLI, and at build time.

## Error Codes

| Code | Type | Where reported |
|------|------|----------------|
| 9995 | `missing` | Missing dependency not registered |
| 9996 | `cycle` | Circular dependency between services |
| 9997 | `type-mismatch` | Provider incompatible with token type |
| 9998 | `duplicate` | Token registered more than once |

---

## Missing Injection (9995)

A service requires a dependency that is not registered in the container.

```
Missing injection: 'IDatabase' required by 'UserService' is not registered in this builder nor its parents/extends
```

**Fix:** Register the missing token in the same container, a parent container, or a partial extended by this container.

```typescript
export const container = defineBuilderConfig({
  injections: [
    { token: useInterface<IDatabase>(), provider: PostgresDatabase }, // ← add this
    { token: UserService }
  ]
});
```

---

## Circular Dependency (9996)

Two or more services depend on each other, forming a cycle.

```
Circular dependency detected: ServiceA -> ServiceB -> ServiceA
```

**Fix:** Introduce an intermediate abstraction or restructure the dependency direction. Circular dependencies are always a design issue — there is no runtime workaround.

---

## Type Mismatch (9997)

Several situations produce this error:

### Provider does not implement the interface

```
Type mismatch: Provider 'LogService' is not assignable to token type 'IUserRepository'.
```

**Fix:** Use a provider that implements the token's interface.

---

### `useValue` with a primitive type

```
useValue cannot be used with primitive type 'string'.
Use useProperty<string>(TargetClass, 'paramName') instead.
```

**Fix:** Use [`useProperty`](../guide/injection-types#property-token) for string, number, and boolean values.

```typescript
// ❌
{ token: useInterface<string>(), useValue: 'http://localhost' }

// ✅
const apiUrl = useProperty<string>(ApiService, 'apiUrl');
{ token: apiUrl, provider: () => 'http://localhost' }
```

---

### `useValue` with a class token

```
useValue cannot be used with a class token. Use provider: MyClass to register a class, or useInterface<T>() with useValue for an interface token.
```

`useValue` only works for interface tokens (`useInterface<T>()`) and property tokens (`useProperty<T>()`) — both are resolved by string comparison. A class-constructor token is resolved by class identity, which a pre-built value has no way to satisfy.

**Fix:** For a plain registration, use `provider: MyClass`. For a pre-built instance under a class token, use a factory instead of `useValue`:

```typescript
// ❌ Throws TypeMismatchError
{ token: SomeConcreteClass, useValue: someInstance }

// ✅ Correct
{ token: SomeConcreteClass, provider: () => someInstance, useFactory: true }
```

---

### Async factory with `lifecycle: 'transient'`

```
Async factory for 'IDatabase' cannot use lifecycle: 'transient'.
Async factories are pre-initialized once in initialize() and must be singletons.
```

**Fix:** Remove `lifecycle: 'transient'` — async factories are always singleton.

```typescript
// ❌
{ token: useInterface<IDatabase>(), provider: async () => createPool(), useFactory: true, lifecycle: 'transient' }

// ✅
{ token: useInterface<IDatabase>(), provider: async () => createPool(), useFactory: true }
```

---

## Duplicate Registration (9998)

A token is registered more than once in the same scope.

### Internal duplicate

```
Duplicate registration: 'UserService' is already registered.
```

**Fix:** Remove the duplicate, or use `scoped: true` if you intentionally want to override a parent token.

---

### Duplicate with parent container

```
Duplicate registration: 'AuthService' is already registered in parent container 'legacy'.
```

**Fix:** Use `scoped: true` to mark the override as intentional.

```typescript
{ token: AuthService, provider: NewAuthService, scoped: true }
```

---

### Duplicate with partial (extends)

```
Duplicate registration: 'LoggerService' is already registered in partial 'sharedPartial'.
```

**Fix:** Remove the registration from the local container — it is already provided by the extended partial.

---

### Mixed `multi` and non-`multi` for the same token

```
Token 'IPlugin' is registered both with and without 'multi: true'.
All registrations for a token must consistently use multi: true or not at all.
```

**Fix:** Decide whether the token is multi or single, and apply `multi: true` (or not) consistently to all registrations.

---

## Unsupported Container Shape (build time, not a coded diagnostic)

`defineBuilderConfig(...)` was called in a shape the build plugin cannot locate and replace — most commonly, returned directly from a function with no intermediate variable.

```
defineBuilderConfig() must be assigned to a variable — 'const container = defineBuilderConfig({...})'
(then `return container;` separately if inside a function) — or used as
'export default defineBuilderConfig({...})'. A bare 'return defineBuilderConfig({...})' (or any other
shape) cannot be located for replacement and would silently ship the untransformed call, which is
unsafe at runtime.
```

**Fix:** Assign the result to a `const` first, then return it:

```typescript
// ❌ Fails the build
export function buildContainer() {
  return defineBuilderConfig({ injections: [ /* ... */ ] });
}

// ✅ Works
export function buildContainer() {
  const container = defineBuilderConfig({ injections: [ /* ... */ ] });
  return container;
}
```

This used to fail silently — no error, and the raw `defineBuilderConfig()` call shipped untouched, throwing an unrelated runtime error the first time it was ever invoked. It is now caught and rejected at build time.

---

## Service Not Found (runtime, not a build-time diagnostic)

Unlike every error above, this one is thrown by the **generated container itself**, at `resolve()` time — not by the build plugin.

```
NeoServiceNotFoundError: [ContainerName] Service not found or token not registered: <token>
```

**Cause:** You called `container.resolve(token)` (or an auto-wired class depends on `token`) for a token that isn't registered in that specific container, its `useContainer` parent chain, or its `legacy` containers.

**Fix:**
- Double-check you're resolving from the right container — a token registered in a sibling module's container is not visible unless shared through `useContainer` (see [Composing Containers Across Modules](../guide/parent-container.md)).
- If this is meant to come from a parent/legacy container, confirm the token was actually registered there — a build-time "Missing injection" error would normally catch this first, but a token resolved manually at runtime (not via a typed constructor parameter) isn't checked at build time.
