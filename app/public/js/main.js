import { createApp } from '/vendor/vue.js';
import { Icon } from './icons.js';
import { store } from './store.js';
import { ConfirmDialog, Menu, Modal, Pager, Toasts } from './ui.js';
import { Login } from './views/login.js';
import { Shell } from './views/shell.js';

const app = createApp({
  components: { Login, Shell, ConfirmDialog, Toasts },
  setup: () => ({ store }),
  template: `
    <Shell v-if="store.secret" />
    <Login v-else />
    <ConfirmDialog />
    <Toasts />`,
});

for (const [name, component] of Object.entries({ Icon, Menu, Modal, Pager })) app.component(name, component);
app.mount('#app');
