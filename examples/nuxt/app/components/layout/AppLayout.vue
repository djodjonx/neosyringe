<script setup lang="ts">
const navItems = [
  { to: '/', label: 'Home', icon: '🏠' },
  { to: '/users', label: 'Users', icon: '👥' },
  { to: '/products', label: 'Products', icon: '📦' }
];
</script>

<template>
  <div class="app-layout">
    <header class="header">
      <div class="header-content">
        <NuxtLink to="/" class="logo">
          <span class="logo-icon">💉</span>
          <span class="logo-text">Neo-Syringe</span>
        </NuxtLink>
        <nav class="nav">
          <NuxtLink
            v-for="item in navItems"
            :key="item.to"
            :to="item.to"
            class="nav-link"
          >
            <span class="nav-icon">{{ item.icon }}</span>
            {{ item.label }}
          </NuxtLink>
        </nav>
      </div>
    </header>

    <main class="main">
      <slot />
    </main>

    <footer class="footer">
      <p>Built with Neo-Syringe • Compile-Time DI</p>
    </footer>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: #f8fafc;
}

.header {
  background: linear-gradient(135deg, #0d9488 0%, #14b8a6 100%);
  color: white;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  position: sticky;
  top: 0;
  z-index: 100;
}

.header-content {
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 1rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 60px;
}

.logo {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  text-decoration: none;
  color: white;
  font-weight: 700;
  font-size: 1.25rem;
}

.logo-icon {
  font-size: 1.5rem;
}

.nav {
  display: flex;
  gap: 0.5rem;
}

.nav-link {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 1rem;
  border-radius: 6px;
  text-decoration: none;
  color: rgba(255, 255, 255, 0.9);
  font-weight: 500;
  transition: all 0.2s;
}

.nav-link:hover {
  background: rgba(255, 255, 255, 0.15);
  color: white;
}

.nav-link.router-link-active {
  background: rgba(255, 255, 255, 0.2);
  color: white;
}

.nav-icon {
  font-size: 1rem;
}

.main {
  flex: 1;
}

.footer {
  background: #1f2937;
  color: #9ca3af;
  text-align: center;
  padding: 1.5rem;
  font-size: 0.875rem;
}

.footer p {
  margin: 0;
}
</style>

