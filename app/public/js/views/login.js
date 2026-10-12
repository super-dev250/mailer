import { ref } from '/vendor/vue.js';
import { signIn } from '../store.js';

export const Login = {
  setup() {
    const secret = ref('');
    const error = ref('');
    const busy = ref(false);

    async function submit() {
      const value = secret.value.trim();
      if (!value) return;
      busy.value = true;
      error.value = '';
      try {
        const response = await fetch('/api/overview', { headers: { Authorization: `Bearer ${value}` } });
        if (response.ok) signIn(value);
        else error.value = (await response.json().catch(() => ({}))).error ?? 'Could not sign in.';
      } catch {
        error.value = 'Could not reach the app. Check your connection and try again.';
      }
      busy.value = false;
    }

    return { secret, error, busy, submit };
  },
  template: `
    <div class="login">
      <form class="card" @submit.prevent="submit">
        <div class="brand" style="padding: 0"><span class="brand-mark"><Icon name="mail" /></span> Mailer</div>
        <div class="field">
          <label for="secret">App secret</label>
          <input id="secret" type="password" v-model="secret" autocomplete="current-password" autofocus>
          <span class="hint">The value you saved as the APP_SECRET secret on GitHub.</span>
        </div>
        <div v-if="error" class="notice problem"><Icon name="alert" /> <span>{{ error }}</span></div>
        <button class="btn primary" style="justify-content: center" :disabled="busy">Sign in</button>
      </form>
    </div>`,
};
