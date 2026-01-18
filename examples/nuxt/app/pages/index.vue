<script setup lang="ts">
import { ref } from 'vue';
import AppButton from '../components/ui/AppButton.vue';
import AppCard from '../components/ui/AppCard.vue';

const activeTab = ref<'singleton' | 'transient' | 'full'>('singleton');

const features = [
  {
    icon: '✨',
    title: 'Pure Domain Classes',
    description: 'No decorators, no DI imports. Your business logic stays clean.'
  },
  {
    icon: '🚀',
    title: 'Zero Runtime Overhead',
    description: 'DI is resolved at build time. No container shipped to production.'
  },
  {
    icon: '🛡️',
    title: 'Type-Safe Interfaces',
    description: 'useInterface<ILogger>() works without manual Symbols.'
  },
  {
    icon: '🔄',
    title: 'Flexible Lifecycles',
    description: 'Singleton or Transient - choose per service, all compile-time.'
  }
];

const singletonCode = `// SINGLETON (default) - Shared instance
{
  token: useInterface<ILogger>(),
  provider: ConsoleLogger
  // lifecycle: 'singleton' is the default
},
{
  token: useInterface<IEventBus>(),
  provider: InMemoryEventBus
},
{ token: UserService }  // Auto-resolved deps`;

const transientCode = `// TRANSIENT - New instance every resolve()
{
  token: useInterface<IRequestContext>(),
  provider: RequestContext,
  lifecycle: 'transient'  // 👈 Key!
},
{
  token: useInterface<IOperationTracker>(),
  provider: OperationTracker,
  lifecycle: 'transient'
}`;

const fullCode = `export const appContainer = defineBuilderConfig({
  name: 'AppContainer',
  injections: [
    // ═══════════════════════════════════════
    // SINGLETON - One instance for the app
    // ═══════════════════════════════════════
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    { token: useInterface<IEventBus>(), provider: InMemoryEventBus },
    { token: useInterface<IUserRepository>(), provider: InMemoryUserRepository },
    { token: UserService },
    { token: ProductService },

    // ═══════════════════════════════════════
    // TRANSIENT - New instance each resolve()
    // ═══════════════════════════════════════
    {
      token: useInterface<IRequestContext>(),
      provider: RequestContext,
      lifecycle: 'transient'
    },
    {
      token: useInterface<IOperationTracker>(),
      provider: OperationTracker,
      lifecycle: 'transient'
    }
  ]
});`;

// Live Demo State
const transientIds = ref<string[]>([]);
const singletonId = ref<string | null>(null);
const singletonResolveCount = ref(0);

function createTransientInstance() {
  const newId = `ctx_${crypto.randomUUID().slice(0, 8)}`;
  transientIds.value = [newId, ...transientIds.value.slice(0, 4)];
}

function resolveSingleton() {
  if (!singletonId.value) {
    singletonId.value = `logger_${crypto.randomUUID().slice(0, 8)}`;
  }
  singletonResolveCount.value++;
}
</script>

<template>
  <div class="page">
    <div class="hero">
      <h1>🧪 NeoSyringe + Nuxt DDD</h1>
      <p class="hero-subtitle">
        Domain-Driven Design with <strong>Compile-Time</strong> Dependency Injection
      </p>
      <div class="hero-actions">
        <NuxtLink to="/users">
          <AppButton variant="primary">
            👥 Manage Users
          </AppButton>
        </NuxtLink>
        <NuxtLink to="/products">
          <AppButton variant="secondary">
            📦 Manage Products
          </AppButton>
        </NuxtLink>
      </div>
    </div>

    <section class="features">
      <AppCard v-for="feature in features" :key="feature.title" hoverable>
        <div class="feature">
          <span class="feature-icon">{{ feature.icon }}</span>
          <h3>{{ feature.title }}</h3>
          <p>{{ feature.description }}</p>
        </div>
      </AppCard>
    </section>

    <!-- DI Configuration Section -->
    <section class="di-config">
      <h2>💉 DI Configuration</h2>
      <p class="section-subtitle">
        Configure your services with different lifecycles - all resolved at build time!
      </p>

      <div class="lifecycle-tabs">
        <button
          :class="['tab', { active: activeTab === 'singleton' }]"
          @click="activeTab = 'singleton'"
        >
          🔒 Singleton
        </button>
        <button
          :class="['tab', { active: activeTab === 'transient' }]"
          @click="activeTab = 'transient'"
        >
          ♻️ Transient
        </button>
        <button
          :class="['tab', { active: activeTab === 'full' }]"
          @click="activeTab = 'full'"
        >
          📋 Full Config
        </button>
      </div>

      <div class="code-container">
        <!-- Singleton Tab -->
        <div v-if="activeTab === 'singleton'" class="code-panel">
          <div class="code-header">
            <span class="badge singleton">SINGLETON</span>
            <span class="desc">One instance shared across the entire application</span>
          </div>
          <pre class="code-block"><code>{{ singletonCode }}</code></pre>
          <div class="code-info">
            <div class="info-item">
              <span class="icon">✅</span>
              <span>Same instance returned on every <code>resolve()</code></span>
            </div>
            <div class="info-item">
              <span class="icon">✅</span>
              <span>Perfect for stateless services like Logger, EventBus</span>
            </div>
            <div class="info-item">
              <span class="icon">✅</span>
              <span>Cached in container's instances Map</span>
            </div>
          </div>
        </div>

        <!-- Transient Tab -->
        <div v-if="activeTab === 'transient'" class="code-panel">
          <div class="code-header">
            <span class="badge transient">TRANSIENT</span>
            <span class="desc">New instance created on every resolve() call</span>
          </div>
          <pre class="code-block"><code>{{ transientCode }}</code></pre>
          <div class="code-info">
            <div class="info-item">
              <span class="icon">♻️</span>
              <span>Fresh instance with unique ID each time</span>
            </div>
            <div class="info-item">
              <span class="icon">♻️</span>
              <span>Ideal for RequestContext, OperationTracker</span>
            </div>
            <div class="info-item">
              <span class="icon">♻️</span>
              <span>No caching - factory called every time</span>
            </div>
          </div>
        </div>

        <!-- Full Config Tab -->
        <div v-if="activeTab === 'full'" class="code-panel">
          <div class="code-header">
            <span class="badge full">COMPLETE</span>
            <span class="desc">Full container configuration example</span>
          </div>
          <pre class="code-block code-full"><code>{{ fullCode }}</code></pre>
        </div>
      </div>

      <!-- Live Demo -->
      <div class="live-demo">
        <h3>🎮 Live Demo: Transient vs Singleton</h3>
        <div class="demo-grid">
          <div class="demo-card">
            <h4>Transient Service</h4>
            <p class="demo-desc">
              Each click creates a new instance with unique ID
            </p>
            <button class="demo-btn" @click="createTransientInstance">
              Create Instance
            </button>
            <div class="demo-results">
              <div
                v-for="(id, index) in transientIds"
                :key="id"
                class="instance-id"
                :style="{ animationDelay: `${index * 0.1}s` }"
              >
                {{ id }}
              </div>
            </div>
          </div>
          <div class="demo-card">
            <h4>Singleton Service</h4>
            <p class="demo-desc">
              Always returns the same instance
            </p>
            <button class="demo-btn singleton-btn" @click="resolveSingleton">
              Resolve Instance
            </button>
            <div class="demo-results">
              <div v-if="singletonId" class="instance-id singleton-instance">
                {{ singletonId }}
                <span class="same-badge">Same every time!</span>
              </div>
              <div v-if="singletonResolveCount > 0" class="resolve-count">
                Resolved {{ singletonResolveCount }} times
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Architecture Section -->
    <section class="architecture">
      <h2>🏗️ DDD Architecture</h2>
      <div class="architecture-grid">
        <AppCard>
          <template #header>
            📦 Shared Kernel
          </template>
          <ul>
            <li>
              <code>ILogger</code> - Logging
              <span class="lifecycle-tag singleton">singleton</span>
            </li>
            <li>
              <code>IEventBus</code> - Events
              <span class="lifecycle-tag singleton">singleton</span>
            </li>
            <li>
              <code>IRequestContext</code>
              <span class="lifecycle-tag transient">transient</span>
            </li>
            <li>
              <code>IOperationTracker</code>
              <span class="lifecycle-tag transient">transient</span>
            </li>
          </ul>
        </AppCard>

        <AppCard>
          <template #header>
            👥 User Bounded Context
          </template>
          <ul>
            <li><code>User</code> - Aggregate root</li>
            <li>
              <code>IUserRepository</code> - Port
              <span class="lifecycle-tag singleton">singleton</span>
            </li>
            <li>
              <code>UserService</code>
              <span class="lifecycle-tag singleton">singleton</span>
            </li>
          </ul>
        </AppCard>

        <AppCard>
          <template #header>
            📦 Product Bounded Context
          </template>
          <ul>
            <li><code>Product</code> - Aggregate root</li>
            <li>
              <code>IProductRepository</code> - Port
              <span class="lifecycle-tag singleton">singleton</span>
            </li>
            <li>
              <code>ProductService</code>
              <span class="lifecycle-tag singleton">singleton</span>
            </li>
          </ul>
        </AppCard>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page {
  padding: 2rem;
  max-width: 1100px;
  margin: 0 auto;
}

.hero {
  text-align: center;
  padding: 3rem 0;
}

.hero h1 {
  font-size: 2.5rem;
  margin: 0 0 1rem 0;
  background: linear-gradient(135deg, #0d9488 0%, #f97316 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.hero-subtitle {
  font-size: 1.25rem;
  color: #6b7280;
  margin: 0 0 2rem 0;
}

.hero-actions {
  display: flex;
  justify-content: center;
  gap: 1rem;
}

.hero-actions a {
  text-decoration: none;
}

.features {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1rem;
  margin: 3rem 0;
}

.feature {
  text-align: center;
}

.feature-icon {
  font-size: 2rem;
  display: block;
  margin-bottom: 0.5rem;
}

.feature h3 {
  margin: 0 0 0.5rem 0;
  color: #1f2937;
  font-size: 1rem;
}

.feature p {
  margin: 0;
  color: #6b7280;
  font-size: 0.875rem;
}

/* DI Config Section */
.di-config {
  margin: 4rem 0;
}

.di-config h2 {
  margin: 0 0 0.5rem 0;
  color: #1f2937;
}

.section-subtitle {
  color: #6b7280;
  margin: 0 0 2rem 0;
}

.lifecycle-tabs {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.tab {
  padding: 0.75rem 1.5rem;
  border: 2px solid #e5e7eb;
  background: white;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 500;
  transition: all 0.2s;
}

.tab:hover {
  border-color: #0d9488;
}

.tab.active {
  background: linear-gradient(135deg, #0d9488 0%, #14b8a6 100%);
  border-color: #0d9488;
  color: white;
}

.code-container {
  background: #1e293b;
  border-radius: 12px;
  overflow: hidden;
}

.code-panel {
  padding: 1.5rem;
}

.code-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1rem;
}

.badge {
  padding: 0.25rem 0.75rem;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
}

.badge.singleton {
  background: #0d9488;
  color: white;
}

.badge.transient {
  background: #f97316;
  color: white;
}

.badge.full {
  background: #8b5cf6;
  color: white;
}

.code-header .desc {
  color: #94a3b8;
  font-size: 0.875rem;
}

.code-block {
  background: #0f172a;
  padding: 1.25rem;
  border-radius: 8px;
  overflow-x: auto;
  margin: 0;
}

.code-block code {
  color: #e2e8f0;
  font-family: 'Fira Code', 'Monaco', monospace;
  font-size: 0.875rem;
  line-height: 1.6;
  white-space: pre;
}

.code-full {
  max-height: 400px;
  overflow-y: auto;
}

.code-info {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid #334155;
}

.info-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  color: #94a3b8;
  font-size: 0.875rem;
}

.info-item .icon {
  font-size: 1rem;
}

.info-item code {
  background: #334155;
  padding: 0.125rem 0.375rem;
  border-radius: 4px;
  color: #14b8a6;
}

/* Live Demo */
.live-demo {
  margin-top: 2rem;
  padding: 1.5rem;
  background: #f8fafc;
  border-radius: 12px;
  border: 1px solid #e5e7eb;
}

.live-demo h3 {
  margin: 0 0 1rem 0;
  color: #1f2937;
}

.demo-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
}

.demo-card {
  background: white;
  padding: 1.5rem;
  border-radius: 8px;
  border: 1px solid #e5e7eb;
}

.demo-card h4 {
  margin: 0 0 0.5rem 0;
  color: #1f2937;
}

.demo-desc {
  margin: 0 0 1rem 0;
  color: #6b7280;
  font-size: 0.875rem;
}

.demo-btn {
  padding: 0.75rem 1.5rem;
  background: linear-gradient(135deg, #f97316 0%, #fb923c 100%);
  border: none;
  border-radius: 6px;
  color: white;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.demo-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(249, 115, 22, 0.3);
}

.singleton-btn {
  background: linear-gradient(135deg, #0d9488 0%, #14b8a6 100%);
}

.singleton-btn:hover {
  box-shadow: 0 4px 12px rgba(13, 148, 136, 0.3);
}

.demo-results {
  margin-top: 1rem;
  min-height: 100px;
}

.instance-id {
  display: inline-block;
  padding: 0.5rem 0.75rem;
  background: #fef3c7;
  border: 1px solid #f59e0b;
  border-radius: 6px;
  font-family: monospace;
  font-size: 0.875rem;
  margin: 0.25rem;
  animation: fadeIn 0.3s ease;
}

.singleton-instance {
  background: #ccfbf1;
  border-color: #0d9488;
}

.same-badge {
  display: block;
  font-size: 0.75rem;
  color: #0d9488;
  margin-top: 0.25rem;
  font-family: system-ui;
}

.resolve-count {
  margin-top: 0.5rem;
  color: #6b7280;
  font-size: 0.875rem;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Architecture Section */
.architecture {
  margin: 3rem 0;
}

.architecture h2 {
  margin: 0 0 1.5rem 0;
  color: #1f2937;
}

.architecture-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1rem;
}

.architecture ul {
  margin: 0;
  padding-left: 1.25rem;
}

.architecture li {
  margin: 0.5rem 0;
  color: #4b5563;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.architecture code {
  background: #f3f4f6;
  padding: 0.125rem 0.375rem;
  border-radius: 4px;
  font-size: 0.875rem;
  color: #0d9488;
}

.lifecycle-tag {
  font-size: 0.625rem;
  padding: 0.125rem 0.375rem;
  border-radius: 3px;
  font-weight: 500;
  text-transform: uppercase;
}

.lifecycle-tag.singleton {
  background: #ccfbf1;
  color: #0d9488;
}

.lifecycle-tag.transient {
  background: #ffedd5;
  color: #c2410c;
}

@media (max-width: 768px) {
  .demo-grid {
    grid-template-columns: 1fr;
  }

  .lifecycle-tabs {
    flex-wrap: wrap;
  }

  .tab {
    flex: 1;
    text-align: center;
  }
}
</style>

