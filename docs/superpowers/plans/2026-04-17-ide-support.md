# IDE Support (VSCode + JetBrains) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make NeoSyringe DI errors appear natively in both VS Code (red squiggles + Problems panel) and JetBrains IDEs (IntelliJ IDEA, WebStorm) with inline error highlighting and the Inspections panel.

**Architecture:**
- **VSCode:** Already functional via the existing TypeScript Language Service plugin (`@djodjonx/neosyringe-lsp`). This plan verifies it works end-to-end and documents the setup.
- **JetBrains:** Cannot use the TS LSP plugin because IntelliJ uses its own PSI engine for error display and bypasses `getSemanticDiagnostics`. The solution is a **native JetBrains plugin** (Kotlin/Gradle) in a new `packages/intellij-plugin` workspace. The plugin runs the NeoSyringe CLI as an external process and maps its output to IntelliJ's `ExternalAnnotator` API, which feeds the Problems panel and editor gutter.

**Tech Stack:**
- VSCode: TypeScript, tsconfig plugin array (existing)
- JetBrains plugin: Kotlin 1.9, Gradle 8, IntelliJ Platform SDK (2024.1+), `intellij-platform-gradle-plugin` v2

---

## File Map

### New Package: `packages/intellij-plugin/`
```
packages/intellij-plugin/
├── build.gradle.kts               — Gradle build config (IntelliJ Platform plugin)
├── gradle.properties              — Plugin metadata (id, version, since-build)
├── settings.gradle.kts            — Project name
├── src/main/kotlin/com/neosyringe/intellij/
│   ├── NeoSyringeAnnotator.kt     — ExternalAnnotator: runs CLI, parses output, creates annotations
│   ├── NeoSyringeInspection.kt    — LocalInspectionTool: wraps annotator for Problems panel
│   ├── NeoSyringeCLIRunner.kt     — Executes `neosyringe check` as a subprocess
│   ├── NeoSyringeOutputParser.kt  — Parses CLI JSON output into structured errors
│   └── NeoSyringeSettingsState.kt — Persistent settings (CLI path, enable/disable)
├── src/main/resources/
│   └── META-INF/plugin.xml        — Plugin descriptor
└── src/test/kotlin/com/neosyringe/intellij/
    ├── NeoSyringeOutputParserTest.kt — Unit tests for CLI output parsing
    └── NeoSyringeCLIRunnerTest.kt    — Unit tests for subprocess execution
```

### Modified Files
- `packages/cli/src/index.ts` — Add `--format json` output flag for machine-readable errors
- `packages/cli/package.json` — No changes needed
- `pnpm-workspace.yaml` — Add intellij-plugin to workspaces (if it were a Node package; Gradle handles its own build)
- `docs/guide/ide-setup.md` — Document both IDE setups
- `packages/lsp/README.md` — Update with confirmed VSCode instructions

---

## Important Prerequisite: CLI JSON Output

The JetBrains plugin needs machine-readable error output from the CLI. Before building the Kotlin plugin, we must add `--format json` to the CLI.

---

## Task 1: Add JSON Output to CLI

**Files:**
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/tests/cli.test.ts` (create if missing)

- [ ] **Step 1: Read the current CLI entry point**

Read `packages/cli/src/index.ts` to understand the current output format. Note where errors are printed to stdout/stderr.

- [ ] **Step 2: Write failing test for --format json**

Create `packages/cli/tests/cli.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';

const CLI = path.resolve(__dirname, '../src/index.ts');
const FIXTURE = path.resolve(__dirname, 'fixtures/duplicate-container.ts');

describe('CLI --format json', () => {
  it('outputs valid JSON array on error', () => {
    let output = '';
    try {
      execSync(`tsx ${CLI} check ${FIXTURE} --format json`, { encoding: 'utf8' });
    } catch (e: any) {
      output = e.stdout || '';
    }
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({
      type: expect.any(String),
      message: expect.any(String),
      file: expect.any(String),
      line: expect.any(Number),
      column: expect.any(Number),
    });
  });

  it('outputs empty JSON array when no errors', () => {
    const output = execSync(`tsx ${CLI} check --format json`, { encoding: 'utf8' });
    const parsed = JSON.parse(output);
    expect(parsed).toEqual([]);
  });
});
```

Create `packages/cli/tests/fixtures/duplicate-container.ts`:
```typescript
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
interface IFoo {}
class Foo implements IFoo {}

export const container = defineBuilderConfig({
  injections: [
    { token: useInterface<IFoo>(), provider: Foo },
    { token: useInterface<IFoo>(), provider: Foo },
  ]
});
```

- [ ] **Step 3: Run to verify failure**

```bash
pnpm --filter @djodjonx/neosyringe-cli test
```
Expected: FAIL — `--format json` not supported

- [ ] **Step 4: Implement --format json in CLI**

In `packages/cli/src/index.ts`, add the `--format` argument. The CLI already uses `process.argv`. Add:

```typescript
const formatFlag = process.argv.includes('--format')
  ? process.argv[process.argv.indexOf('--format') + 1]
  : 'text';

// When formatting errors:
if (formatFlag === 'json') {
  const jsonErrors = allErrors.map(e => ({
    type: e.type,
    message: e.message,
    file: e.sourceFile.fileName,
    line: e.sourceFile.getLineAndCharacterOfPosition(e.node.getStart()).line + 1,
    column: e.sourceFile.getLineAndCharacterOfPosition(e.node.getStart()).character + 1,
    endLine: e.sourceFile.getLineAndCharacterOfPosition(e.node.getEnd()).line + 1,
    endColumn: e.sourceFile.getLineAndCharacterOfPosition(e.node.getEnd()).character + 1,
    code: getErrorCode(e.type), // 9995–9999
  }));
  process.stdout.write(JSON.stringify(jsonErrors, null, 2));
  process.exit(jsonErrors.length > 0 ? 1 : 0);
} else {
  // existing text output...
}
```

Add a `getErrorCode` helper if it doesn't exist:
```typescript
function getErrorCode(type: string): number {
  switch (type) {
    case 'missing': return 9995;
    case 'cycle': return 9996;
    case 'type-mismatch': return 9997;
    case 'duplicate': return 9998;
    default: return 9999;
  }
}
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @djodjonx/neosyringe-cli test
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/tests/
git commit -m "feat(cli): add --format json output for machine-readable error reporting"
```

---

## Task 2: Verify VSCode End-to-End

**Files:**
- Modify: `packages/lsp/README.md`
- Read: `packages/lsp/INTELLIJ.md` (no changes needed)

VSCode uses the tsconfig `plugins` array to load TS language service plugins. The existing `@djodjonx/neosyringe-lsp` package should work. Verify the setup manually.

- [ ] **Step 1: Verify tsconfig setup in the example project**

Read `examples/nuxt/tsconfig.json`. Confirm it contains:
```json
{
  "compilerOptions": {
    "plugins": [
      { "name": "@djodjonx/neosyringe-lsp" }
    ]
  }
}
```

If missing, add it.

- [ ] **Step 2: Build the LSP package**

```bash
pnpm --filter @djodjonx/neosyringe-lsp build
```
Expected: dist/ folder updated with no errors.

- [ ] **Step 3: Open the example project in VSCode and verify**

Open `examples/nuxt/app/di/container.ts` in VSCode. Deliberately introduce a duplicate injection:
```typescript
{ token: useInterface<ISomeService>(), provider: SomeService },
{ token: useInterface<ISomeService>(), provider: SomeService }, // duplicate
```
Expected: Red squiggle appears with `[NeoSyringe] Duplicate registration...` message.

If it does NOT appear: check that VSCode is using the workspace TypeScript version (bottom-right of VS Code → "TypeScript X.X.X" → "Use Workspace Version").

- [ ] **Step 4: Update LSP README with verified setup steps**

In `packages/lsp/README.md`, add a "VSCode Setup" section:

```markdown
## VS Code Setup

1. Add the plugin to your `tsconfig.json`:

\`\`\`json
{
  "compilerOptions": {
    "plugins": [{ "name": "@djodjonx/neosyringe-lsp" }]
  }
}
\`\`\`

2. **IMPORTANT:** Use the workspace TypeScript version, not VS Code's bundled version.
   - Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
   - Run: "TypeScript: Select TypeScript Version"
   - Choose: "Use Workspace Version"

3. Reload the TypeScript server:
   - Command Palette → "TypeScript: Restart TS Server"

NeoSyringe errors will now appear as red squiggles and in the Problems panel.
```

- [ ] **Step 5: Commit**

```bash
git add packages/lsp/README.md examples/nuxt/tsconfig.json
git commit -m "docs(lsp): document verified VSCode setup steps"
```

---

## Task 3: Scaffold JetBrains Plugin Project

**Files:**
- Create: `packages/intellij-plugin/build.gradle.kts`
- Create: `packages/intellij-plugin/gradle.properties`
- Create: `packages/intellij-plugin/settings.gradle.kts`
- Create: `packages/intellij-plugin/src/main/resources/META-INF/plugin.xml`

**Prerequisite:** JDK 17+ and Gradle 8+ must be installed.
```bash
java -version   # must be 17+
gradle --version # must be 8+
```

- [ ] **Step 1: Create the Gradle wrapper setup**

```bash
mkdir -p /Users/jonathan/projects/neo-syringe/packages/intellij-plugin
cd /Users/jonathan/projects/neo-syringe/packages/intellij-plugin
gradle wrapper --gradle-version 8.5
```

- [ ] **Step 2: Create settings.gradle.kts**

Create `packages/intellij-plugin/settings.gradle.kts`:

```kotlin
rootProject.name = "neosyringe-intellij-plugin"
```

- [ ] **Step 3: Create gradle.properties**

Create `packages/intellij-plugin/gradle.properties`:

```properties
pluginGroup=com.neosyringe.intellij
pluginName=NeoSyringe
pluginVersion=0.1.0
pluginSinceBuild=241
pluginUntilBuild=

platformType=IC
platformVersion=2024.1

javaVersion=17
```

- [ ] **Step 4: Create build.gradle.kts**

Create `packages/intellij-plugin/build.gradle.kts`:

```kotlin
import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "1.9.24"
    id("org.jetbrains.intellij.platform") version "2.1.0"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

kotlin {
    jvmToolchain(providers.gradleProperty("javaVersion").get().toInt())
}

intellijPlatform {
    pluginConfiguration {
        name = providers.gradleProperty("pluginName")
        version = providers.gradleProperty("pluginVersion")
        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
            untilBuild = providers.gradleProperty("pluginUntilBuild")
        }
    }
}

dependencies {
    intellijPlatform {
        create(
            providers.gradleProperty("platformType"),
            providers.gradleProperty("platformVersion")
        )
        testFramework(TestFrameworkType.Platform)
    }

    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
}
```

- [ ] **Step 5: Create src directory structure**

```bash
mkdir -p packages/intellij-plugin/src/main/kotlin/com/neosyringe/intellij
mkdir -p packages/intellij-plugin/src/main/resources/META-INF
mkdir -p packages/intellij-plugin/src/test/kotlin/com/neosyringe/intellij
```

- [ ] **Step 6: Create plugin.xml**

Create `packages/intellij-plugin/src/main/resources/META-INF/plugin.xml`:

```xml
<idea-plugin>
    <id>com.neosyringe.intellij</id>
    <name>NeoSyringe DI</name>
    <vendor>NeoSyringe</vendor>
    <description>
        Highlights NeoSyringe dependency injection errors (missing bindings,
        duplicates, type mismatches, cycles) directly in the editor.
    </description>

    <depends>com.intellij.modules.platform</depends>
    <depends>JavaScript</depends>

    <extensions defaultExtensionNs="com.intellij">
        <externalAnnotator
            language="TypeScript"
            implementationClass="com.neosyringe.intellij.NeoSyringeAnnotator"/>

        <localInspection
            language="TypeScript"
            displayName="NeoSyringe DI errors"
            groupName="NeoSyringe"
            enabledByDefault="true"
            level="ERROR"
            implementationClass="com.neosyringe.intellij.NeoSyringeInspection"/>
    </extensions>
</idea-plugin>
```

- [ ] **Step 7: Verify Gradle sync succeeds**

```bash
cd packages/intellij-plugin
./gradlew dependencies --quiet
```
Expected: Resolves IntelliJ Platform dependencies without error. First run downloads ~500MB of IntelliJ SDK.

- [ ] **Step 8: Commit scaffold**

```bash
cd /Users/jonathan/projects/neo-syringe
git add packages/intellij-plugin/
git commit -m "feat(intellij-plugin): scaffold JetBrains plugin project with Gradle and IntelliJ Platform"
```

---

## Task 4: Implement CLI Runner and Output Parser

**Files:**
- Create: `packages/intellij-plugin/src/main/kotlin/com/neosyringe/intellij/NeoSyringeCLIRunner.kt`
- Create: `packages/intellij-plugin/src/main/kotlin/com/neosyringe/intellij/NeoSyringeOutputParser.kt`
- Test: `packages/intellij-plugin/src/test/kotlin/com/neosyringe/intellij/NeoSyringeOutputParserTest.kt`

- [ ] **Step 1: Write OutputParser test**

Create `packages/intellij-plugin/src/test/kotlin/com/neosyringe/intellij/NeoSyringeOutputParserTest.kt`:

```kotlin
package com.neosyringe.intellij

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*

class NeoSyringeOutputParserTest {

    @Test
    fun `parses single error from JSON output`() {
        val json = """
            [
              {
                "type": "duplicate",
                "message": "Duplicate registration: 'IFoo' is already registered.",
                "file": "/project/src/container.ts",
                "line": 10,
                "column": 5,
                "endLine": 10,
                "endColumn": 40,
                "code": 9998
              }
            ]
        """.trimIndent()

        val errors = NeoSyringeOutputParser.parse(json)

        assertEquals(1, errors.size)
        assertEquals("duplicate", errors[0].type)
        assertEquals(10, errors[0].line)
        assertEquals(5, errors[0].column)
        assertEquals("/project/src/container.ts", errors[0].file)
    }

    @Test
    fun `parses empty JSON array`() {
        val errors = NeoSyringeOutputParser.parse("[]")
        assertTrue(errors.isEmpty())
    }

    @Test
    fun `returns empty list on malformed JSON`() {
        val errors = NeoSyringeOutputParser.parse("not json at all")
        assertTrue(errors.isEmpty())
    }

    @Test
    fun `parses multiple errors`() {
        val json = """
            [
              {"type":"missing","message":"Missing IBar","file":"a.ts","line":5,"column":1,"endLine":5,"endColumn":10,"code":9995},
              {"type":"cycle","message":"Cycle: A->B->A","file":"a.ts","line":8,"column":1,"endLine":8,"endColumn":10,"code":9996}
            ]
        """.trimIndent()
        val errors = NeoSyringeOutputParser.parse(json)
        assertEquals(2, errors.size)
        assertEquals("missing", errors[0].type)
        assertEquals("cycle", errors[1].type)
    }
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd packages/intellij-plugin
./gradlew test
```
Expected: FAIL — `NeoSyringeOutputParser` not found

- [ ] **Step 3: Create the data classes and parser**

Create `packages/intellij-plugin/src/main/kotlin/com/neosyringe/intellij/NeoSyringeOutputParser.kt`:

```kotlin
package com.neosyringe.intellij

import com.google.gson.Gson
import com.google.gson.reflect.TypeToken

data class NeoSyringeError(
    val type: String,
    val message: String,
    val file: String,
    val line: Int,
    val column: Int,
    val endLine: Int,
    val endColumn: Int,
    val code: Int
)

object NeoSyringeOutputParser {
    private val gson = Gson()

    fun parse(json: String): List<NeoSyringeError> {
        return try {
            val type = object : TypeToken<List<NeoSyringeError>>() {}.type
            gson.fromJson(json, type) ?: emptyList()
        } catch (e: Exception) {
            emptyList()
        }
    }
}
```

Add Gson dependency to `build.gradle.kts`:
```kotlin
dependencies {
    // ... existing
    implementation("com.google.code.gson:gson:2.10.1")
}
```

- [ ] **Step 4: Create CLI Runner**

Create `packages/intellij-plugin/src/main/kotlin/com/neosyringe/intellij/NeoSyringeCLIRunner.kt`:

```kotlin
package com.neosyringe.intellij

import com.intellij.openapi.project.Project
import java.io.File
import java.util.concurrent.TimeUnit

object NeoSyringeCLIRunner {

    /**
     * Runs `neosyringe check --format json` in the project root.
     * Returns parsed errors, or empty list if CLI is not found or fails unexpectedly.
     */
    fun run(project: Project): List<NeoSyringeError> {
        val projectDir = File(project.basePath ?: return emptyList())

        // Find the CLI: try local node_modules/.bin/neosyringe first, then global
        val cliPath = findCLI(projectDir) ?: return emptyList()

        return try {
            val process = ProcessBuilder(cliPath, "check", "--format", "json")
                .directory(projectDir)
                .redirectErrorStream(false)
                .start()

            val stdout = process.inputStream.bufferedReader().readText()
            process.waitFor(30, TimeUnit.SECONDS)

            NeoSyringeOutputParser.parse(stdout)
        } catch (e: Exception) {
            emptyList()
        }
    }

    private fun findCLI(projectDir: File): String? {
        // 1. Local node_modules
        val localCLI = File(projectDir, "node_modules/.bin/neosyringe")
        if (localCLI.exists() && localCLI.canExecute()) return localCLI.absolutePath

        // 2. npx fallback
        val npx = findExecutable("npx") ?: return null
        return "$npx neosyringe" // will be split differently; use list form
    }

    private fun findExecutable(name: String): String? {
        val paths = System.getenv("PATH")?.split(File.pathSeparator) ?: return null
        for (dir in paths) {
            val file = File(dir, name)
            if (file.exists() && file.canExecute()) return file.absolutePath
        }
        return null
    }
}
```

- [ ] **Step 5: Run tests**

```bash
cd packages/intellij-plugin
./gradlew test
```
Expected: All 4 parser tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/jonathan/projects/neo-syringe
git add packages/intellij-plugin/src/
git commit -m "feat(intellij-plugin): implement CLI runner and JSON output parser"
```

---

## Task 5: Implement the ExternalAnnotator

**Files:**
- Create: `packages/intellij-plugin/src/main/kotlin/com/neosyringe/intellij/NeoSyringeAnnotator.kt`
- Create: `packages/intellij-plugin/src/main/kotlin/com/neosyringe/intellij/NeoSyringeInspection.kt`

`ExternalAnnotator` is IntelliJ's mechanism for running external analysis tools and displaying their results as editor annotations (red underlines + gutter icons). It runs on a background thread after the file is saved.

- [ ] **Step 1: Implement NeoSyringeAnnotator**

Create `packages/intellij-plugin/src/main/kotlin/com/neosyringe/intellij/NeoSyringeAnnotator.kt`:

```kotlin
package com.neosyringe.intellij

import com.intellij.lang.annotation.AnnotationHolder
import com.intellij.lang.annotation.ExternalAnnotator
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.editor.Document
import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiFile

/**
 * Runs NeoSyringe CLI analysis after file save and displays errors as editor annotations.
 *
 * IntelliJ's ExternalAnnotator lifecycle:
 * 1. collectInformation() — runs on EDT, extracts file info before background work
 * 2. doAnnotate()         — runs on background thread, executes the analysis
 * 3. apply()              — runs on EDT, creates editor annotations from results
 */
class NeoSyringeAnnotator : ExternalAnnotator<NeoSyringeAnnotator.FileInfo, List<NeoSyringeError>>() {

    data class FileInfo(val filePath: String, val document: Document, val project: com.intellij.openapi.project.Project)

    override fun collectInformation(file: PsiFile): FileInfo? {
        // Only annotate TypeScript files containing NeoSyringe keywords
        if (!file.name.endsWith(".ts") && !file.name.endsWith(".tsx")) return null

        val text = file.text
        if (!text.contains("defineBuilderConfig") && !text.contains("definePartialConfig")) return null

        val document = com.intellij.openapi.fileEditor.FileDocumentManager
            .getInstance()
            .getDocument(file.virtualFile) ?: return null

        return FileInfo(file.virtualFile.path, document, file.project)
    }

    override fun doAnnotate(info: FileInfo): List<NeoSyringeError> {
        // Runs on background thread — safe to call subprocess here
        return NeoSyringeCLIRunner.run(info.project)
            .filter { it.file == info.filePath }
    }

    override fun apply(file: PsiFile, errors: List<NeoSyringeError>, holder: AnnotationHolder) {
        val document = com.intellij.openapi.fileEditor.FileDocumentManager
            .getInstance()
            .getDocument(file.virtualFile) ?: return

        for (error in errors) {
            val startOffset = getOffset(document, error.line - 1, error.column - 1)
            val endOffset = getOffset(document, error.endLine - 1, error.endColumn - 1)

            if (startOffset < 0 || endOffset < 0 || startOffset >= endOffset) continue

            val range = TextRange(startOffset, endOffset)
            val severity = if (error.type == "missing" || error.type == "cycle")
                HighlightSeverity.ERROR
            else
                HighlightSeverity.ERROR

            holder.newAnnotation(severity, "[NeoSyringe] ${error.message}")
                .range(range)
                .tooltip("[NeoSyringe DI] ${error.message} (code ${error.code})")
                .create()
        }
    }

    private fun getOffset(document: Document, line: Int, column: Int): Int {
        if (line < 0 || line >= document.lineCount) return -1
        val lineStart = document.getLineStartOffset(line)
        val lineEnd = document.getLineEndOffset(line)
        val offset = lineStart + column
        return if (offset <= lineEnd) offset else -1
    }
}
```

- [ ] **Step 2: Implement NeoSyringeInspection**

`LocalInspectionTool` makes errors appear in the Problems panel (View > Tool Windows > Problems).

Create `packages/intellij-plugin/src/main/kotlin/com/neosyringe/intellij/NeoSyringeInspection.kt`:

```kotlin
package com.neosyringe.intellij

import com.intellij.codeInspection.LocalInspectionTool
import com.intellij.codeInspection.ProblemsHolder
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiElementVisitor
import com.intellij.psi.PsiFile

class NeoSyringeInspection : LocalInspectionTool() {

    override fun buildVisitor(holder: ProblemsHolder, isOnTheFly: Boolean): PsiElementVisitor {
        return object : PsiElementVisitor() {
            override fun visitFile(file: PsiFile) {
                if (!file.name.endsWith(".ts") && !file.name.endsWith(".tsx")) return

                val text = file.text
                if (!text.contains("defineBuilderConfig") && !text.contains("definePartialConfig")) return

                val errors = NeoSyringeCLIRunner.run(file.project)
                    .filter { it.file == file.virtualFile.path }

                val document = com.intellij.openapi.fileEditor.FileDocumentManager
                    .getInstance()
                    .getDocument(file.virtualFile) ?: return

                for (error in errors) {
                    val startOffset = getOffset(document, error.line - 1, error.column - 1)
                    if (startOffset < 0) continue

                    val element = file.findElementAt(startOffset) ?: file
                    holder.registerProblem(
                        element,
                        "[NeoSyringe] ${error.message}"
                    )
                }
            }

            private fun getOffset(document: com.intellij.openapi.editor.Document, line: Int, column: Int): Int {
                if (line < 0 || line >= document.lineCount) return -1
                return document.getLineStartOffset(line) + column
            }
        }
    }
}
```

- [ ] **Step 3: Build the plugin**

```bash
cd packages/intellij-plugin
./gradlew buildPlugin
```
Expected: `build/distributions/NeoSyringe-0.1.0.zip` created.

- [ ] **Step 4: Test in IntelliJ sandbox**

```bash
./gradlew runIde
```

This launches a sandboxed IntelliJ instance with the plugin installed. Open `examples/nuxt` in the sandbox IDE, open `app/di/container.ts`, introduce a duplicate injection, and save.

Expected: Red underline appears under the duplicate injection token. Error appears in Problems panel.

- [ ] **Step 5: Commit**

```bash
cd /Users/jonathan/projects/neo-syringe
git add packages/intellij-plugin/
git commit -m "feat(intellij-plugin): implement ExternalAnnotator and LocalInspection for error display"
```

---

## Task 6: Plugin Settings State

**Files:**
- Create: `packages/intellij-plugin/src/main/kotlin/com/neosyringe/intellij/NeoSyringeSettingsState.kt`
- Modify: `packages/intellij-plugin/src/main/resources/META-INF/plugin.xml`
- Modify: `packages/intellij-plugin/src/main/kotlin/com/neosyringe/intellij/NeoSyringeCLIRunner.kt`

Users need to be able to:
1. Disable the plugin (avoid analysis overhead in large projects)
2. Point to a custom CLI path (useful for global installs)

- [ ] **Step 1: Create settings state**

Create `packages/intellij-plugin/src/main/kotlin/com/neosyringe/intellij/NeoSyringeSettingsState.kt`:

```kotlin
package com.neosyringe.intellij

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.project.Project

@State(
    name = "NeoSyringeSettings",
    storages = [Storage(".idea/neosyringe.xml")]
)
@Service(Service.Level.PROJECT)
class NeoSyringeSettingsState : PersistentStateComponent<NeoSyringeSettingsState.State> {

    data class State(
        var enabled: Boolean = true,
        var customCLIPath: String = ""
    )

    private var state = State()

    override fun getState(): State = state
    override fun loadState(state: State) { this.state = state }

    companion object {
        fun getInstance(project: Project): NeoSyringeSettingsState =
            project.getService(NeoSyringeSettingsState::class.java)
    }
}
```

- [ ] **Step 2: Register in plugin.xml**

In `META-INF/plugin.xml`, add inside `<extensions defaultExtensionNs="com.intellij">`:

```xml
<projectService
    serviceImplementation="com.neosyringe.intellij.NeoSyringeSettingsState"/>
```

- [ ] **Step 3: Wire into CLIRunner and Annotator**

In `NeoSyringeCLIRunner.kt`, guard with the enabled setting:

```kotlin
fun run(project: Project): List<NeoSyringeError> {
    val settings = NeoSyringeSettingsState.getInstance(project)
    if (!settings.state.enabled) return emptyList()

    val customPath = settings.state.customCLIPath.takeIf { it.isNotBlank() }
    val projectDir = File(project.basePath ?: return emptyList())
    val cliPath = customPath ?: findCLI(projectDir) ?: return emptyList()
    // ... rest of run()
}
```

- [ ] **Step 4: Build and verify**

```bash
cd packages/intellij-plugin
./gradlew buildPlugin
```
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
cd /Users/jonathan/projects/neo-syringe
git add packages/intellij-plugin/
git commit -m "feat(intellij-plugin): add persistent settings state for enable/disable and custom CLI path"
```

---

## Task 7: Add Debouncing to Prevent Repeated Analysis

**Files:**
- Modify: `packages/intellij-plugin/src/main/kotlin/com/neosyringe/intellij/NeoSyringeCLIRunner.kt`

The `ExternalAnnotator` is called frequently (on every keystroke in some configs). The CLI subprocess is expensive. Add a debounce: skip analysis if the last run was < 3 seconds ago for the same project.

- [ ] **Step 1: Add project-level debounce to CLIRunner**

In `NeoSyringeCLIRunner.kt`, add before the `run` function:

```kotlin
private val lastRunTime = java.util.concurrent.ConcurrentHashMap<String, Long>()
private const val DEBOUNCE_MS = 3000L

fun run(project: Project): List<NeoSyringeError> {
    val settings = NeoSyringeSettingsState.getInstance(project)
    if (!settings.state.enabled) return emptyList()

    val projectPath = project.basePath ?: return emptyList()
    val now = System.currentTimeMillis()
    val last = lastRunTime[projectPath] ?: 0L

    if (now - last < DEBOUNCE_MS) {
        return cachedResults[projectPath] ?: emptyList()
    }

    lastRunTime[projectPath] = now
    // ... run the CLI ...
    val results = NeoSyringeOutputParser.parse(stdout)
    cachedResults[projectPath] = results
    return results
}

private val cachedResults = java.util.concurrent.ConcurrentHashMap<String, List<NeoSyringeError>>()
```

- [ ] **Step 2: Build and verify**

```bash
cd packages/intellij-plugin
./gradlew buildPlugin
```

- [ ] **Step 3: Commit**

```bash
cd /Users/jonathan/projects/neo-syringe
git add packages/intellij-plugin/src/main/kotlin/com/neosyringe/intellij/NeoSyringeCLIRunner.kt
git commit -m "perf(intellij-plugin): add 3s debounce to CLI runner to reduce subprocess overhead"
```

---

## Task 8: Update Documentation

**Files:**
- Modify: `docs/guide/ide-setup.md` (create if missing)
- Modify: `packages/lsp/INTELLIJ.md`

- [ ] **Step 1: Update INTELLIJ.md to reflect the new plugin**

Replace the "Ce qui ne Fonctionne Pas" section with the new working approach:

```markdown
## IntelliJ IDEA / WebStorm Support

NeoSyringe provides a **native JetBrains plugin** for full error highlighting support.

### Installation

1. Download `NeoSyringe-<version>.zip` from the [GitHub Releases](https://github.com/...)
2. In IntelliJ: **Settings → Plugins → ⚙ → Install Plugin from Disk...**
3. Select the downloaded zip file
4. Restart IntelliJ

### What Works

- ✅ Red underlines on DI errors (duplicate, missing, cycle, type-mismatch)
- ✅ Errors in the Problems panel (View > Tool Windows > Problems)
- ✅ Error tooltip with full message
- ✅ Works in IntelliJ IDEA, WebStorm, Rider

### Requirements

- NeoSyringe CLI must be installed (`npm install @djodjonx/neosyringe-cli`)
- The CLI must be in `node_modules/.bin/neosyringe` relative to the project root

### Settings

**Settings → Tools → NeoSyringe:**
- Enable/disable analysis
- Set custom CLI path (if using a global install)
```

- [ ] **Step 2: Create/update docs/guide/ide-setup.md**

```markdown
# IDE Setup

## VS Code

1. Install the NeoSyringe LSP plugin:
   \`\`\`bash
   npm install --save-dev @djodjonx/neosyringe-lsp
   \`\`\`

2. Add to `tsconfig.json`:
   \`\`\`json
   { "compilerOptions": { "plugins": [{ "name": "@djodjonx/neosyringe-lsp" }] } }
   \`\`\`

3. Select workspace TypeScript version: **Command Palette → TypeScript: Select TypeScript Version → Use Workspace Version**

Errors appear as red squiggles and in the Problems panel (Ctrl+Shift+M).

## JetBrains (IntelliJ IDEA, WebStorm)

Install the **NeoSyringe** JetBrains plugin from the [releases page].

The plugin runs the NeoSyringe CLI in the background and displays errors using IntelliJ's native annotation system.

**Requirement:** `@djodjonx/neosyringe-cli` must be installed in the project.

## CI/CD (All Editors)

Add to your pipeline for editor-independent validation:

\`\`\`yaml
- name: NeoSyringe Check
  run: npx neosyringe check --strict
\`\`\`
```

- [ ] **Step 3: Commit**

```bash
git add docs/guide/ide-setup.md packages/lsp/INTELLIJ.md
git commit -m "docs: update IDE setup guide to document both VSCode and JetBrains support"
```

---

## Verification

After all tasks, verify the full pipeline:

```bash
# CLI JSON output
node packages/cli/dist/index.js check --format json

# VSCode: open examples/nuxt, introduce duplicate, verify squiggle appears
# JetBrains:
cd packages/intellij-plugin
./gradlew runIde
# Open examples/nuxt, introduce duplicate, save, verify annotation appears
```
