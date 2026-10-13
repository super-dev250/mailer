import { computed, onMounted, ref } from '/vendor/vue.js';
import { api } from '../api.js';
import { CAMPAIGN_STATUS, audienceName, count, percent, when } from '../format.js';
import { go, problem, store } from '../store.js';

export const CampaignsView = {
  setup() {
    const campaigns = ref(null);
    onMounted(() =>
      api.get('/api/campaigns').then((data) => (campaigns.value = data.campaigns), problem),
    );

    const create = () => api.post('/api/campaigns').then(({ id }) => go(`/campaigns/${id}`), problem);
    // The whole row opens the campaign; a click on the link inside it already does.
    const open = (item, event) => event.target.closest('a') || go(`/campaigns/${item.id}`);

    // Shown until the first campaign exists.
    const steps = computed(() => [
      { label: 'Add a mailbox', done: store.overview.mailboxes.length > 0, href: '#/mailboxes' },
      { label: 'Import your contacts', done: store.overview.lists.length > 0, href: '#/contacts' },
      { label: 'Write your first campaign', done: campaigns.value.length > 0 },
    ]);

    return { campaigns, create, open, steps, CAMPAIGN_STATUS, audienceName, count, percent, when };
  },
  template: `
    <div class="page-head">
      <h1>Campaigns</h1>
      <div class="actions">
        <button type="button" class="btn primary" @click="create"><Icon name="plus" /> New campaign</button>
      </div>
    </div>
    <div v-if="campaigns" class="stack">
      <div v-if="!campaigns.length" class="card pad stack">
        <h2>Getting started</h2>
        <ul class="steps">
          <li v-for="step in steps" :key="step.label">
            <span class="step-mark" :class="{ done: step.done }"><Icon v-if="step.done" name="check" /></span>
            <a v-if="step.href && !step.done" :href="step.href">{{ step.label }}</a>
            <span v-else :class="{ done: step.done }">{{ step.label }}</span>
          </li>
        </ul>
      </div>
      <div v-else class="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Campaign</th><th>Status</th><th>Audience</th>
              <th class="num">Sent</th><th class="num">Delivered</th><th class="num">Opened</th><th class="num">Clicked</th><th class="num">Replied</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in campaigns" :key="item.id" class="clickable" @click="open(item, $event)">
              <td>
                <a class="cell-title" :href="'#/campaigns/' + item.id">{{ item.name }}</a>
                <div class="cell-sub">{{ item.subject || 'No subject yet' }}</div>
              </td>
              <td>
                <span class="badge" :class="{ ring: CAMPAIGN_STATUS[item.status].ring }" :style="{ '--dot': CAMPAIGN_STATUS[item.status].dot }">{{ CAMPAIGN_STATUS[item.status].label }}</span>
                <div class="cell-sub">{{ when(item.started_at || item.created_at) }}</div>
              </td>
              <td>{{ audienceName(item.list) }}</td>
              <template v-if="item.status === 'draft'"><td class="num muted" colspan="5">Not sent yet</td></template>
              <template v-else>
                <td class="num">{{ count(item.stats.sent) }}<span class="muted"> / {{ count(item.stats.total) }}</span></td>
                <td class="num">{{ percent(item.stats.delivered, item.stats.sent) }}</td>
                <td class="num">{{ percent(item.stats.opened, item.stats.sent) }}</td>
                <td class="num">{{ percent(item.stats.clicked, item.stats.sent) }}</td>
                <td class="num">{{ percent(item.stats.replied, item.stats.sent) }}</td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
    </div>`,
};
