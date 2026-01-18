<script setup lang="ts">
import AppLayout from './components/layout/AppLayout.vue';
</script>

<template>
  <AppLayout>
    <NuxtPage />
  </AppLayout>
</template>

<style>
/* Global Reset */
*,
*::before,
*::after {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 0;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
</style>

