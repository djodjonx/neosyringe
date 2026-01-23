---
"@djodjonx/neosyringe-core": minor
---

Add full type inference to container resolve method

The generated container now uses a generic typed signature `resolve<T>(token: any): T` instead of `resolve(token: any): any`, providing complete type safety and automatic type inference.

**Benefits:**
- ✨ Automatic type inference - no type assertions needed
- 🛡️ Full compile-time type checking
- 📝 Complete IDE auto-completion support
- 🔄 100% backward compatible

**Example:**
```typescript
const userService = container.resolve(UserService);
// Type: UserService ✅ (automatically inferred)

const logger = container.resolve(useInterface<ILogger>());
// Type: ILogger ✅
```

**Documentation:**
- Added comprehensive type safety examples across all guides
- Added comparison with other DI libraries (tsyringe, InversifyJS, Awilix)
- Updated API documentation with type inference details
